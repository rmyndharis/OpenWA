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

  it('reports a claim handed to the engine past the stale window as outcome unknown, not in progress', async () => {
    const claim = await service.claim(input);
    if (claim.kind !== 'claimed') throw new Error('expected a claim');
    await service.handOver(claim.id);
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

  describe('hand-over to the engine', () => {
    const backdate = (id: string) =>
      repo.update(
        { id },
        { expiresAt: new Date(Date.now() - SEND_IDEMPOTENCY_STALE_PENDING_MS - 1000 + SEND_IDEMPOTENCY_TTL_MS) },
      );

    it('holds a fresh claim as not handed over, and records the hand-over', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      expect((await repo.findOneByOrFail({ id: claim.id })).state).toBe('claimed');

      await service.handOver(claim.id);

      expect((await repo.findOneByOrFail({ id: claim.id })).state).toBe('pending');
    });

    it('lets the next request take over a claim that never reached the engine once it is stale', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      await backdate(claim.id);

      const takeover = await service.claim(input);

      expect(takeover.kind).toBe('claimed');
      expect(takeover).not.toEqual(claim);
      expect(await repo.count()).toBe(1);
    });

    it('keeps a stale claim that never reached the engine bound to its own body', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      await backdate(claim.id);

      expect(await service.claim({ ...input, requestHash: 'h2' })).toEqual({ kind: 'mismatch' });
    });

    // A send that pacing held past the stale window must not go out beside the request that took its key over.
    it('refuses the hand-over of a claim another request took over', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      await backdate(claim.id);
      expect((await service.claim(input)).kind).toBe('claimed');

      await expect(service.handOver(claim.id)).rejects.toMatchObject({
        response: { statusCode: 409, code: 'IDEMPOTENCY_KEY_IN_PROGRESS' },
      });
    });

    it('refuses a second hand-over of the same claim, which stays handed over', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      await service.handOver(claim.id);

      await expect(service.handOver(claim.id)).rejects.toMatchObject({ response: { statusCode: 409 } });
      expect((await repo.findOneByOrFail({ id: claim.id })).state).toBe('pending');
    });

    it('leaves a completed claim and its stored answer as they are when a late hand-over arrives', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      await service.handOver(claim.id);
      await service.complete(claim.id, { messageId: 'm1' });

      await expect(service.handOver(claim.id)).rejects.toMatchObject({ response: { statusCode: 409 } });
      expect(await service.claim(input)).toEqual({ kind: 'replay', body: { messageId: 'm1' } });
    });

    // The holder reaches the engine between the retaker's read of its stale claim and the retaker's delete.
    it('leaves a stale claim to a holder that hands over before the takeover deletes it', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      await backdate(claim.id);
      const remove = repo.delete.bind(repo);
      jest.spyOn(repo, 'delete').mockImplementationOnce(async criteria => {
        await service.handOver(claim.id);
        return remove(criteria);
      });

      expect(await service.claim(input)).toEqual({ kind: 'outcome_unknown' });
      expect(await repo.findOneByOrFail({ id: claim.id })).toMatchObject({ state: 'pending' });
      expect(await repo.count()).toBe(1);
    });

    it('frees a claim handed to the engine when the engine proves nothing was sent', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      await service.handOver(claim.id);
      await service.release(claim.id);

      expect((await service.claim(input)).kind).toBe('claimed');
    });
  });

  describe('a release the database refused', () => {
    afterEach(() => jest.useRealTimers());

    it('is tried again, later each time, until it lands', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      jest.useFakeTimers();
      const remove = repo.delete.bind(repo);
      const refused = new Error('Connection terminated unexpectedly');
      const del = jest
        .spyOn(repo, 'delete')
        .mockRejectedValueOnce(refused)
        .mockRejectedValueOnce(refused)
        .mockImplementation(criteria => remove(criteria));

      await expect(service.release(claim.id)).rejects.toBe(refused);
      await jest.advanceTimersByTimeAsync(999);
      expect(del).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(del).toHaveBeenCalledTimes(2);
      // Refused again: the next try comes after twice the wait.
      await jest.advanceTimersByTimeAsync(1999);
      expect(del).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(del).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
      expect((await service.claim(input)).kind).toBe('claimed');
    });

    // Refused every time: the passes come 1, 3, 7, 15, 31, 61 and 91 seconds after the first refusal.
    it('waits twice as long after each refusal, up to thirty seconds, and stays there', async () => {
      jest.useFakeTimers();
      const del = jest.spyOn(repo, 'delete').mockRejectedValue(new Error('Connection terminated unexpectedly'));
      await expect(service.release('claim-1')).rejects.toThrow();
      let now = 0;
      const passesBy = async (ms: number): Promise<number> => {
        await jest.advanceTimersByTimeAsync(ms - now);
        now = ms;
        return del.mock.calls.length - 1;
      };

      expect(await passesBy(30_999)).toBe(4);
      expect(await passesBy(31_000)).toBe(5);
      expect(await passesBy(60_999)).toBe(5);
      expect(await passesBy(61_000)).toBe(6);
      expect(await passesBy(90_999)).toBe(6);
      expect(await passesBy(91_000)).toBe(7);
    });

    it('starts again from one second once every owed release has landed', async () => {
      jest.useFakeTimers();
      const remove = repo.delete.bind(repo);
      const refused = new Error('Connection terminated unexpectedly');
      const del = jest
        .spyOn(repo, 'delete')
        .mockRejectedValueOnce(refused)
        // The pass at one second is refused too, so the next one waits two.
        .mockRejectedValueOnce(refused)
        .mockImplementationOnce(criteria => remove(criteria))
        .mockRejectedValueOnce(refused)
        .mockImplementation(criteria => remove(criteria));
      await expect(service.release('claim-a')).rejects.toBe(refused);
      await jest.advanceTimersByTimeAsync(3000);
      expect(del).toHaveBeenCalledTimes(3);

      await jest.advanceTimersByTimeAsync(7000);
      await expect(service.release('claim-b')).rejects.toBe(refused);
      await jest.advanceTimersByTimeAsync(999);
      expect(del).toHaveBeenCalledTimes(4);
      await jest.advanceTimersByTimeAsync(1);
      expect(del).toHaveBeenCalledTimes(5);
    });

    it('ends a pass at its first refusal, so the wait doubles once a pass however many releases are owed', async () => {
      jest.useFakeTimers();
      const del = jest.spyOn(repo, 'delete').mockRejectedValue(new Error('Connection terminated unexpectedly'));
      for (const id of ['claim-a', 'claim-b', 'claim-c']) await expect(service.release(id)).rejects.toThrow();

      await jest.advanceTimersByTimeAsync(1000);
      expect(del).toHaveBeenCalledTimes(4);
      await jest.advanceTimersByTimeAsync(1999);
      expect(del).toHaveBeenCalledTimes(4);
      await jest.advanceTimersByTimeAsync(1);
      expect(del).toHaveBeenCalledTimes(5);
    });

    it('keeps one pass scheduled for two refusals, and drops it at shutdown', async () => {
      jest.useFakeTimers();
      const del = jest.spyOn(repo, 'delete').mockRejectedValue(new Error('Connection terminated unexpectedly'));
      await expect(service.release('claim-a')).rejects.toThrow();
      await expect(service.release('claim-b')).rejects.toThrow();

      await jest.advanceTimersByTimeAsync(1000);
      // One pass, ended by its first refusal.
      expect(del).toHaveBeenCalledTimes(3);
      await service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(del).toHaveBeenCalledTimes(3);
    });

    it('schedules no further pass when the one running at shutdown is refused', async () => {
      jest.useFakeTimers();
      const refused = new Error('Connection terminated unexpectedly');
      let refuseRunning!: (error: Error) => void;
      const del = jest
        .spyOn(repo, 'delete')
        .mockRejectedValueOnce(refused)
        .mockImplementationOnce(() => new Promise<never>((_resolve, reject) => (refuseRunning = reject)));
      await expect(service.release('claim-a')).rejects.toBe(refused);
      await jest.advanceTimersByTimeAsync(1000);
      expect(del).toHaveBeenCalledTimes(2);

      await service.onModuleDestroy();
      refuseRunning(refused);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(del).toHaveBeenCalledTimes(2);
    });

    it('is not tried again once the module stopped', async () => {
      const claim = await service.claim(input);
      if (claim.kind !== 'claimed') throw new Error('expected a claim');
      jest.useFakeTimers();
      const del = jest.spyOn(repo, 'delete').mockRejectedValue(new Error('Connection terminated unexpectedly'));

      await expect(service.release(claim.id)).rejects.toThrow();
      await service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(del).toHaveBeenCalledTimes(1);
      await expect(service.release(claim.id)).rejects.toThrow();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(del).toHaveBeenCalledTimes(2);
    });
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
