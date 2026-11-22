import { DataSource, Repository } from 'typeorm';
import { SendIdempotencyKey } from '../entities/send-idempotency-key.entity';
import {
  hashSendRequest,
  isValidIdempotencyKey,
  SEND_IDEMPOTENCY_STALE_PENDING_MS,
  SEND_IDEMPOTENCY_TTL_MS,
  SendIdempotencyService,
} from './send-idempotency.service';

describe('SendIdempotencyService (sqlite)', () => {
  let ds: DataSource;
  let repo: Repository<SendIdempotencyKey>;
  let service: SendIdempotencyService;
  const input = { sessionId: 's1', key: 'k-1', route: 'sendText', requestHash: 'h1' };

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [SendIdempotencyKey],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(SendIdempotencyKey);
    service = new SendIdempotencyService(repo);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    await ds.destroy();
  });

  it('claims a fresh key, and a second claim of the same key while it runs is in progress', async () => {
    const first = await service.claim(input);
    expect(first.kind).toBe('claimed');

    expect(await service.claim(input)).toEqual({ kind: 'in_progress' });
    expect(await repo.count()).toBe(1);
  });

  it('lets only one of two concurrent claims win', async () => {
    const results = await Promise.all([service.claim(input), service.claim(input)]);
    expect(results.filter(r => r.kind === 'claimed')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'in_progress')).toHaveLength(1);
  });

  it('scopes keys per session', async () => {
    expect((await service.claim(input)).kind).toBe('claimed');
    expect((await service.claim({ ...input, sessionId: 's2' })).kind).toBe('claimed');
  });

  it('replays the stored body once the send completed', async () => {
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await service.complete(claim.id, { messageId: 'm1', timestamp: 1 });

    expect(await service.claim(input)).toEqual({ kind: 'replay', body: { messageId: 'm1', timestamp: 1 } });
  });

  it('refuses the key for a different body or route', async () => {
    await service.claim(input);
    expect(await service.claim({ ...input, requestHash: 'h2' })).toEqual({ kind: 'mismatch' });
  });

  // A completed key must not answer a different message with the first message's stored response:
  // the second message would never be sent and the client would be told it was.
  it('refuses the key for a different body or route once the send completed', async () => {
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await service.complete(claim.id, { messageId: 'm1' });

    expect(await service.claim({ ...input, requestHash: 'h2' })).toEqual({ kind: 'mismatch' });
    expect(await service.claim(input)).toEqual({ kind: 'replay', body: { messageId: 'm1' } });
  });

  it('refuses the key for a different body or route after the send failed', async () => {
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await service.markFailed(claim.id);

    expect(await service.claim({ ...input, requestHash: 'h2' })).toEqual({ kind: 'mismatch' });
    expect(await service.claim(input)).toEqual({ kind: 'outcome_unknown' });
  });

  it('binds a key to its send for 24 hours', async () => {
    const day = 24 * 60 * 60 * 1000;
    // The literal, not the imported constant: every other test reads the constant, so a changed
    // lifetime could not fail them.
    expect(SEND_IDEMPOTENCY_TTL_MS).toBe(day);

    const before = Date.now();
    await service.claim(input);
    const after = Date.now();

    const [row] = await repo.find();
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + day);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(after + day);
  });

  it('frees a released key for a new claim', async () => {
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await service.release(claim.id);

    expect((await service.claim({ ...input, requestHash: 'h2' })).kind).toBe('claimed');
  });

  it('keeps a failed key taken and reports the outcome as unknown', async () => {
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await service.markFailed(claim.id);

    expect(await service.claim(input)).toEqual({ kind: 'outcome_unknown' });
  });

  it('reports a pending claim past the stale window as outcome unknown, not in progress', async () => {
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    const claimedLongAgo = Date.now() - SEND_IDEMPOTENCY_STALE_PENDING_MS - 1000;
    await repo.update({ id: claim.id }, { expiresAt: new Date(claimedLongAgo + SEND_IDEMPOTENCY_TTL_MS) });

    expect(await service.claim(input)).toEqual({ kind: 'outcome_unknown' });
  });

  it('reclaims an expired key, even one that completed', async () => {
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await service.complete(claim.id, { messageId: 'm1' });
    await repo.update({ id: claim.id }, { expiresAt: new Date(Date.now() - 1000) });

    const again = await service.claim({ ...input, requestHash: 'h2' });
    expect(again.kind).toBe('claimed');
    expect(await repo.count()).toBe(1);
  });

  it('reclaims a key at the exact expiresAt === now boundary instead of returning in_progress', async () => {
    const fixedNow = new Date('2026-06-01T12:00:00.000Z');
    jest.useFakeTimers({ now: fixedNow });
    try {
      const first = await service.claim(input);
      if (first.kind !== 'claimed') throw new Error('expected a claim');
      await repo.update({ id: first.id }, { expiresAt: fixedNow });

      const reclaimed = await service.claim({ ...input, requestHash: 'h2' });
      expect(reclaimed.kind).toBe('claimed');
      expect(await repo.count()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('prunes only expired keys', async () => {
    await service.claim(input);
    const old = await service.claim({ ...input, key: 'k-old' });
    if (old.kind !== 'claimed') throw new Error('expected a claim');
    await repo.update({ id: old.id }, { expiresAt: new Date(Date.now() - 1000) });

    expect(await service.pruneExpired()).toBe(1);
    expect((await repo.find()).map(r => r.idempotencyKey)).toEqual(['k-1']);
  });

  it('prunes a key whose expiresAt equals now', async () => {
    const exactNow = new Date('2026-06-01T12:00:00.000Z');
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await repo.update({ id: claim.id }, { expiresAt: exactNow });

    expect(await service.pruneExpired(exactNow)).toBe(1);
    expect(await repo.count()).toBe(0);
  });

  it('coalesces concurrent pruneExpired calls into a single pass', async () => {
    const expired = await service.claim(input);
    if (expired.kind !== 'claimed') throw new Error('expected a claim');
    await repo.update({ id: expired.id }, { expiresAt: new Date(Date.now() - 1000) });

    const realFind = repo.find.bind(repo);
    let releaseFind!: () => void;
    const findGate = new Promise<void>(resolve => (releaseFind = resolve));
    let enteredFind!: () => void;
    const findStarted = new Promise<void>(resolve => (enteredFind = resolve));
    const findSpy = jest.spyOn(repo, 'find').mockImplementationOnce(async options => {
      enteredFind();
      await findGate;
      return realFind(options);
    });

    const first = service.pruneExpired();
    const second = service.pruneExpired();
    await findStarted;
    expect(findSpy).toHaveBeenCalledTimes(1);

    releaseFind();
    expect(await Promise.all([first, second])).toEqual([1, 1]);
    expect(await repo.count()).toBe(0);
  });

  it('drains an in-flight pruneExpired call during onModuleDestroy and skips subsequent prunes', async () => {
    const expired = await service.claim(input);
    if (expired.kind !== 'claimed') throw new Error('expected a claim');
    await repo.update({ id: expired.id }, { expiresAt: new Date(Date.now() - 1000) });

    const realFind = repo.find.bind(repo);
    let releaseFind!: () => void;
    const findGate = new Promise<void>(resolve => (releaseFind = resolve));
    let enteredFind!: () => void;
    const findStarted = new Promise<void>(resolve => (enteredFind = resolve));
    const findSpy = jest.spyOn(repo, 'find').mockImplementationOnce(async options => {
      enteredFind();
      await findGate;
      return realFind(options);
    });

    const inFlight = service.pruneExpired();
    await findStarted;

    let destroyDone = false;
    const destroying = service.onModuleDestroy().then(() => {
      destroyDone = true;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(destroyDone).toBe(false);

    releaseFind();
    await inFlight;
    await destroying;
    expect(destroyDone).toBe(true);

    // After destroy, pruneExpired returns 0 immediately without touching the repository.
    findSpy.mockClear();
    expect(await service.pruneExpired()).toBe(0);
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('rethrows a storage error that is not a duplicate key', async () => {
    await ds.query('DROP TABLE "send_idempotency_keys"');
    await expect(service.claim(input)).rejects.toThrow(/no such table/);
  });

  // The sweep is the only cleanup for keys that are never claimed again: without it every distinct
  // key a client ever used stays in the table, with its stored response, for good.
  describe('hourly prune', () => {
    const hour = 60 * 60 * 1000;

    afterEach(() => {
      jest.useRealTimers();
    });

    it('starts at module init, runs every hour, and stops at module destroy', async () => {
      jest.useFakeTimers();
      const prune = jest.spyOn(service, 'pruneExpired').mockResolvedValue(0);

      service.onModuleInit();
      jest.advanceTimersByTime(hour - 1);
      expect(prune).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(prune).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(hour);
      expect(prune).toHaveBeenCalledTimes(2);

      await service.onModuleDestroy();
      jest.advanceTimersByTime(2 * hour);
      expect(prune).toHaveBeenCalledTimes(2);
    });
  });
});

describe('isValidIdempotencyKey', () => {
  it.each(['a', 'order-123:retry', 'x'.repeat(255), '550e8400-e29b-41d4-a716-446655440000'])('accepts %p', key =>
    expect(isValidIdempotencyKey(key)).toBe(true),
  );

  it.each(['', ' ', 'has space', 'x'.repeat(256), 'tab\there', 'ünï', 'key\n', 'key\r\n'])('rejects %p', key =>
    expect(isValidIdempotencyKey(key)).toBe(false),
  );
});

describe('hashSendRequest', () => {
  it('ignores object key order but not array order, values or route', () => {
    const base = hashSendRequest('sendText', { chatId: 'c', text: 't', opts: { a: 1, b: 2 } });
    expect(hashSendRequest('sendText', { opts: { b: 2, a: 1 }, text: 't', chatId: 'c' })).toBe(base);
    expect(hashSendRequest('sendText', { chatId: 'c', text: 'u', opts: { a: 1, b: 2 } })).not.toBe(base);
    expect(hashSendRequest('reply', { chatId: 'c', text: 't', opts: { a: 1, b: 2 } })).not.toBe(base);
    expect(hashSendRequest('sendPoll', { options: ['a', 'b'] })).not.toBe(
      hashSendRequest('sendPoll', { options: ['b', 'a'] }),
    );
  });

  it('treats an absent field like an undefined one', () => {
    expect(hashSendRequest('sendText', { chatId: 'c', text: undefined })).toBe(
      hashSendRequest('sendText', { chatId: 'c' }),
    );
  });
});
