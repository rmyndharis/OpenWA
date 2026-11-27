import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, In } from 'typeorm';
import { RecoveryJournal } from '../../common/utils/recovery-journal';
import { type MessageCopyChange, WebhookOutboxService } from './webhook-outbox.service';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { LoggerService } from '../../common/services/logger.service';
import { MessageDirection } from '../message/entities/message.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

const base = {
  webhookId: 'wh-1',
  sessionId: 'sess-1',
  event: 'message.received',
  idempotencyKey: 'key_wh-1',
  deliveryId: 'del-1',
  payload: { from: '628123456789@c.us' },
};

describe('WebhookOutboxService', () => {
  let repo: { insert: jest.Mock; update: jest.Mock; find: jest.Mock };
  let service: WebhookOutboxService;

  beforeEach(() => {
    repo = {
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };
    service = new WebhookOutboxService(repo as never);
  });

  it('records the delivery as pending, carrying the payload a replay needs', async () => {
    await service.open(base);

    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ ...base, state: 'pending', attempts: 0 }));
  });

  it('treats a duplicate as the replay it is, keeping the existing row', async () => {
    const conflict = Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    repo.insert.mockRejectedValue(conflict);

    // A conflict on (webhookId, idempotencyKey) means this delivery is already recorded. Throwing
    // would surface as an unhandled rejection on a fire-and-forget path.
    await expect(service.open(base)).resolves.toBeUndefined();
  });

  it('never lets a repository failure reach a fire-and-forget caller', async () => {
    repo.insert.mockRejectedValue(new Error('disk full'));
    await expect(service.open(base)).resolves.toBeUndefined();

    repo.update.mockRejectedValue(new Error('disk full'));
    await expect(service.close('wh-1', 'key_wh-1', 'dispatched')).resolves.toBeUndefined();
    // A failed count must not block the replay: the write is best-effort like the rest.
    await expect(service.countAttempt('row-1', 0)).resolves.toBe(true);
  });

  it('retires the payload when recording an outcome, so a settled row stops carrying a message body', async () => {
    await service.close('wh-1', 'key_wh-1', 'dispatched');

    expect(repo.update).toHaveBeenCalledWith(
      { webhookId: 'wh-1', idempotencyKey: 'key_wh-1' },
      expect.objectContaining({ state: 'dispatched', payload: null }),
    );
  });

  it('keeps payload when marking queued and excludes already settled rows', async () => {
    await service.markQueued('wh-1', 'key_wh-1', 'job-1');
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: In(['pending', 'queued']) }),
      expect.objectContaining({ state: 'queued', deliveryId: 'job-1' }),
    );
    expect((repo.update.mock.calls as unknown[][])[0][1]).not.toHaveProperty('payload');
  });

  it('reverts a matching queued delivery back to pending without reopening settled rows', async () => {
    await service.markPending('wh-1', 'key_wh-1', 'job-1');
    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: 'wh-1', idempotencyKey: 'key_wh-1', state: 'queued', deliveryId: 'job-1' }),
      { state: 'pending' },
    );

    repo.update.mockRejectedValueOnce(new Error('disk full'));
    await expect(service.markPending('wh-1', 'key_wh-1', 'job-1')).resolves.toBeUndefined();
  });

  it('returns only rows that still carry a payload: a retired row is not replayable', async () => {
    const row = (over: Partial<WebhookOutboxEvent>): WebhookOutboxEvent => ({
      id: 'r',
      ...base,
      attempts: 0,
      state: 'pending',
      lastAttemptAt: null,
      createdAt: new Date(),
      ...over,
    });
    repo.find.mockResolvedValue([row({ id: 'keep' }), row({ id: 'retired', payload: null })]);

    const stale = await service.findStale(new Date(), 50);

    expect(stale.map(r => r.id)).toEqual(['keep']);
  });

  it('counts an attempt by incrementing the stored number, not by recomputing it', async () => {
    repo.update.mockResolvedValue({ affected: 1 });

    await expect(service.countAttempt('row-1', 2)).resolves.toBe(true);

    expect(repo.update).toHaveBeenCalledWith(
      { id: 'row-1', state: In(['pending', 'queued']) },
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('reports a row that is no longer pending, so a stale copy is not replayed', async () => {
    repo.update.mockResolvedValue({ affected: 0 });

    await expect(service.countAttempt('row-1', 2)).resolves.toBe(false);
  });
});

describe('WebhookOutboxService retention', () => {
  let repo: { find: jest.Mock; delete: jest.Mock; manager: unknown };
  let service: WebhookOutboxService;

  beforeEach(() => {
    repo = {
      find: jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
      delete: jest.fn().mockResolvedValue({ affected: 3 }),
      // The dialect the batched prune asks for.
      manager: { connection: { options: { type: 'better-sqlite3' } } },
    };
    service = new WebhookOutboxService(repo as never);
  });

  it('prunes settled and legacy null-state rows in two indexed passes, never one that can still be replayed', async () => {
    repo.find.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]).mockResolvedValueOnce([{ id: 'c' }]);
    repo.delete.mockResolvedValueOnce({ affected: 2 }).mockResolvedValueOnce({ affected: 1 });

    const removed = await service.pruneSettled(7);

    expect(removed).toBe(3);
    expect(repo.find).toHaveBeenCalledTimes(2);
    const [pass1Call, pass2Call] = repo.find.mock.calls as unknown as [
      [{ where: { state: { type: string; value?: unknown }; createdAt: { type: string } } }],
      [{ where: { state: { type: string }; createdAt: { type: string } } }],
    ];
    expect(pass1Call[0].where.state.type).toBe('in');
    expect(pass1Call[0].where.state.value).toEqual(['dispatched', 'delivered', 'failed']);
    expect(pass1Call[0].where.createdAt.type).toBe('lessThan');
    expect(pass2Call[0].where.state.type).toBe('isNull');
    expect(pass2Call[0].where.createdAt.type).toBe('lessThan');
    expect(repo.delete).toHaveBeenNthCalledWith(1, ['a', 'b']);
    expect(repo.delete).toHaveBeenNthCalledWith(2, ['c']);
  });

  it('prunes legacy null-state rows older than cutoff in SQLite while preserving pending, queued, and recent rows', async () => {
    const ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [WebhookOutboxEvent],
      synchronize: true,
    }).initialize();
    try {
      const insertRow = (id: string, key: string, state: string | null, daysOld: number): Promise<unknown> =>
        ds.query(
          `INSERT INTO webhook_outbox_events (id, webhookId, sessionId, event, idempotencyKey, deliveryId, payload, state, attempts, createdAt)
           VALUES (?, 'wh-1', 'sess-1', 'message.received', ?, ?, NULL, ?, 0, datetime('now', ?))`,
          [id, key, `dlv-${key}`, state, `-${daysOld} days`],
        );

      await insertRow('00000000-0000-4000-8000-000000000001', 'old-null', null, 14);
      await insertRow('00000000-0000-4000-8000-000000000002', 'old-dispatched', 'dispatched', 14);
      await insertRow('00000000-0000-4000-8000-000000000003', 'old-failed', 'failed', 14);
      await insertRow('00000000-0000-4000-8000-000000000008', 'old-delivered', 'delivered', 14);
      await insertRow('00000000-0000-4000-8000-000000000004', 'old-pending', 'pending', 14);
      await insertRow('00000000-0000-4000-8000-000000000005', 'old-queued', 'queued', 14);
      await insertRow('00000000-0000-4000-8000-000000000006', 'recent-null', null, 1);
      await insertRow('00000000-0000-4000-8000-000000000007', 'recent-dispatched', 'dispatched', 1);
      await insertRow('00000000-0000-4000-8000-000000000009', 'recent-delivered', 'delivered', 1);

      const sqliteService = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
      expect(await sqliteService.pruneSettled(7)).toBe(4);

      const survivors = (await ds.getRepository(WebhookOutboxEvent).find()).map(r => r.idempotencyKey).sort();
      expect(survivors).toEqual(['old-pending', 'old-queued', 'recent-delivered', 'recent-dispatched', 'recent-null']);
    } finally {
      await ds.destroy();
    }
  });

  it('keeps the settled row of a message a handler filed elsewhere while a failed delivery keeps a copy of it', async () => {
    const ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    }).initialize();
    try {
      const engineRef = JSON.stringify({ chatId: '628111@c.us', direction: 'outgoing', author: null });
      const insertRow = (id: string, key: string, moved: boolean): Promise<unknown> =>
        ds.query(
          `INSERT INTO webhook_outbox_events (id, webhookId, sessionId, event, idempotencyKey, deliveryId, payload, state, attempts, createdAt, engineRef)
           VALUES (?, 'wh-1', 'sess-1', 'message.sent', ?, ?, NULL, 'failed', 1, datetime('now', '-14 days'), ?)`,
          [id, key, `dlv-${key}`, moved ? engineRef : null],
        );
      await insertRow('00000000-0000-4000-8000-000000000001', 'moved-kept', true);
      await insertRow('00000000-0000-4000-8000-000000000002', 'moved-gone', true);
      await insertRow('00000000-0000-4000-8000-000000000003', 'plain-kept', false);
      const failures = ds.getRepository(WebhookDeliveryFailure);
      for (const [key, payload] of [
        ['moved-kept', { id: 'M', body: 'first text' }],
        ['moved-gone', null],
        ['plain-kept', { id: 'P', body: 'first text' }],
      ] as const) {
        await failures.insert({
          webhookId: 'wh-1',
          sessionId: 'sess-1',
          event: 'message.sent',
          url: 'https://receiver.example/hook',
          idempotencyKey: key,
          deliveryId: `dlv-${key}`,
          attempts: 1,
          lastError: 'receiver down',
          payload,
        });
      }

      expect(await new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent)).pruneSettled(7)).toBe(2);

      expect((await ds.getRepository(WebhookOutboxEvent).find()).map(r => r.idempotencyKey)).toEqual(['moved-kept']);
    } finally {
      await ds.destroy();
    }
  });

  it('awaits an in-flight prune pass during onModuleDestroy', async () => {
    let releaseFind!: () => void;
    repo.find.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseFind = () => resolve([{ id: 'a' }]);
        }),
    );

    const pruning = service.pruneSettled(7);
    await new Promise(resolve => setImmediate(resolve));

    let destroyed = false;
    const destroyP = Promise.resolve(service.onModuleDestroy()).then(() => {
      destroyed = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(destroyed).toBe(false);

    releaseFind();
    await destroyP;
    await pruning;
    expect(destroyed).toBe(true);
    // Stopped before issuing delete on the batch returned after shutdown began.
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('bounds onModuleDestroy when a prune query hangs', async () => {
    jest.useFakeTimers();
    try {
      repo.find.mockImplementationOnce(() => new Promise(() => undefined));

      void service.pruneSettled(7);
      let destroyed = false;
      const destroyP = service.onModuleDestroy().then(() => {
        destroyed = true;
      });

      await jest.advanceTimersByTimeAsync(999);
      expect(destroyed).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(destroyed).toBe(true);
      await destroyP;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * One pass deletes at most 100,000 rows. An installation that settles more than that a day never
   * caught up while the next pass waited a whole day, and the table grew without bound.
   */
  it('runs again a minute later while a pass keeps hitting its cap, then waits a day', async () => {
    jest.useFakeTimers();
    try {
      const prune = jest
        .spyOn(service, 'pruneSettled')
        .mockResolvedValueOnce(100_000)
        .mockResolvedValueOnce(100_000)
        .mockResolvedValue(42);
      const warn = jest.spyOn(service['logger'], 'warn');

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(prune).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(prune).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(DAY_MS - 120_001);
      expect(prune).toHaveBeenCalledTimes(3);
      await jest.advanceTimersByTimeAsync(1);
      expect(prune).toHaveBeenCalledTimes(4);
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('drops a pending follow-up pass on destroy', async () => {
    jest.useFakeTimers();
    try {
      const prune = jest.spyOn(service, 'pruneSettled').mockResolvedValue(100_000);

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      await service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(60_000);

      expect(prune).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not follow a failed pass with another one before the next day', async () => {
    jest.useFakeTimers();
    try {
      const prune = jest
        .spyOn(service, 'pruneSettled')
        .mockResolvedValueOnce(100_000)
        .mockRejectedValue(new Error('database is locked'));
      const error = jest.spyOn(service['logger'], 'error');

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(prune).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(DAY_MS - 60_001);
      expect(prune).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(1);
      expect(prune).toHaveBeenCalledTimes(3);
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('does not start a second pass while one is running', async () => {
    let releaseFind!: () => void;
    repo.find.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseFind = () => resolve([]);
        }),
    );

    const first = service.pruneSettled(7);
    await expect(service.pruneSettled(7)).resolves.toBe(0);
    expect(repo.find).toHaveBeenCalledTimes(1);

    releaseFind();
    await first;
  });

  it('refuses a retention window that would let the table grow without bound', async () => {
    const prev = process.env.WEBHOOK_OUTBOX_RETENTION_DAYS;
    process.env.WEBHOOK_OUTBOX_RETENTION_DAYS = '0';
    try {
      service.onModuleInit();
      await new Promise(resolve => setImmediate(resolve));
      // A settled row carries no payload and no audit value, so opting into unbounded growth buys
      // nothing: the value falls back rather than disabling the prune.
      expect(repo.delete).toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
      if (prev === undefined) delete process.env.WEBHOOK_OUTBOX_RETENTION_DAYS;
      else process.env.WEBHOOK_OUTBOX_RETENTION_DAYS = prev;
    }
  });
});

describe('WebhookOutboxService.openBatch dialect paths', () => {
  it('uses ON CONFLICT DO NOTHING RETURNING on drivers supporting INSERT RETURNING and filters duplicates', async () => {
    const qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      updateEntity: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({
        raw: [{ webhookId: 'wh-1', idempotencyKey: 'k1_wh-1' }],
      }),
    };
    const manager = {
      connection: { driver: { isReturningSqlSupported: (kind: string) => kind === 'insert' } },
      getRepository: jest.fn().mockReturnValue({ createQueryBuilder: () => qb }),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    const service = new WebhookOutboxService({} as never);

    const rows = [
      { ...base, webhookId: 'wh-1', idempotencyKey: 'k1_wh-1', deliveryId: 'd1' },
      { ...base, webhookId: 'wh-1', idempotencyKey: 'k1_wh-1', deliveryId: 'd1-dup' },
      { ...base, webhookId: 'wh-2', idempotencyKey: 'k1_wh-2', deliveryId: 'd2' },
    ];
    const inserted = await service.openBatch(rows, manager as never);

    expect(qb.orIgnore).toHaveBeenCalledTimes(1);
    expect(qb.returning).toHaveBeenCalledWith(['webhookId', 'idempotencyKey']);
    expect(qb.updateEntity).toHaveBeenCalledWith(false);
    expect(inserted).toEqual([rows[0]]);
  });

  it('swallows non-conflict errors when called standalone without a transaction manager', async () => {
    const qb = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      updateEntity: jest.fn().mockReturnThis(),
      execute: jest.fn().mockRejectedValue(new Error('disk full')),
    };
    const service = new WebhookOutboxService({
      createQueryBuilder: () => qb,
      manager: { connection: { driver: { isReturningSqlSupported: () => false } } },
    } as never);

    await expect(service.openBatch([base])).resolves.toBeNull();
  });
});

describe('WebhookOutboxService copies of deliveries with no outbox row written', () => {
  const MiB = 1024 * 1024;
  const row = (i: number, payload: Record<string, unknown> = {}) => ({
    webhookId: 'w',
    sessionId: 's',
    event: 'message.received',
    idempotencyKey: `msg_s_${i}_w`,
    deliveryId: `d${i}`,
    payload: { id: String(i), chatId: '628111@c.us', fromMe: false, author: '628222@c.us', body: 'hi', ...payload },
  });
  const losses = (error: jest.SpyInstance) =>
    error.mock.calls
      .map(([, , meta]) => meta as { action?: string; reason?: string; idempotencyKey?: string })
      .filter(meta => meta?.action === 'webhook_copy_lost');
  let service: WebhookOutboxService;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    // No outbox row was written for any of these deliveries.
    service = new WebhookOutboxService({ findOne: () => Promise.resolve(null) } as never);
    warn = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  it('hold at most 64 MiB of content, letting the oldest go first, each a logged loss', () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i, { media: { data: 'x'.repeat(MiB) + i } }));
    service.holdUnwritten(rows);

    const held = rows.filter(r => service.unwrittenCopy(r.webhookId, r.idempotencyKey));
    const bytes = held.reduce((sum, r) => sum + JSON.stringify(service.unwrittenCopy('w', r.idempotencyKey)).length, 0);
    expect(bytes).toBeLessThanOrEqual(64 * MiB);
    expect(held.at(-1)).toBe(rows.at(-1));
    expect(held[0]).not.toBe(rows[0]);
    const shed = rows.length - held.length;
    expect(losses(warn)).toHaveLength(shed);
    expect(losses(warn)[0]).toMatchObject({ reason: 'bytes', idempotencyKey: 'msg_s_0_w' });
  });

  it('let the content of the oldest go past 10,000, keeping what names its message, each a logged loss', async () => {
    service.holdUnwritten(Array.from({ length: 10_001 }, (_, i) => row(i)));

    expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeUndefined();
    expect(service.unwrittenCopy('w', 'msg_s_1_w')).toMatchObject({ body: 'hi' });
    expect(losses(warn)).toEqual([expect.objectContaining({ reason: 'count', idempotencyKey: 'msg_s_0_w' })]);
    // A revoke still reaches it.
    await service.changeUnwrittenForMessage('s', '0', { kind: 'close' });
    await expect(service.currentMessagePayload('w', 'msg_s_0_w', 'message.received')).resolves.toBeNull();
  });

  it('drop a copy with no content past 16 MiB of them, oldest first, each a logged loss', async () => {
    // What names each message is 1 MiB here, so a copy that let its content go still holds about that much.
    service.holdUnwritten(Array.from({ length: 90 }, (_, i) => row(i, { chatId: `${'x'.repeat(MiB)}${i}` })));

    const reasons = losses(warn).map(({ reason, idempotencyKey }) => [reason, idempotencyKey]);
    expect(reasons.filter(([reason]) => reason === 'dropped')[0]).toEqual(['dropped', 'msg_s_0_w']);
    const shed = reasons.filter(([reason]) => reason === 'bytes').length;
    const dropped = reasons.filter(([reason]) => reason === 'dropped').length;
    expect(shed - dropped).toBeLessThanOrEqual(16);
    expect(shed - dropped).toBeGreaterThanOrEqual(15);
    // Nothing of a dropped copy is kept: a revoke no longer reaches it, and its delivery reads its row (none here).
    await service.changeUnwrittenForMessage('s', '0', { kind: 'close' });
    await expect(service.currentMessagePayload('w', 'msg_s_0_w', 'message.received')).resolves.toBeUndefined();
    // The newest copy that let its content go is still reached.
    const newestShed = reasons.filter(([reason]) => reason === 'bytes').at(-1)![1]!;
    await service.changeUnwrittenForMessage('s', newestShed.split('_')[2], { kind: 'close' });
    await expect(service.currentMessagePayload('w', newestShed, 'message.received')).resolves.toBeNull();
  });

  it('hold at least 30,000 copies of typical messages once their content was let go', () => {
    const SESSION = '11111111-2222-4333-8444-555555555555';
    const WEBHOOK = '66666666-7777-4888-8999-000000000000';
    service.holdUnwritten(
      Array.from({ length: 40_000 }, (_, i) => ({
        webhookId: WEBHOOK,
        sessionId: SESSION,
        event: 'message.received',
        idempotencyKey: `msg_${SESSION}_false_120363000000000001@g.us_3EB0C431C26A${i}_123456789012345@lid_${WEBHOOK}`,
        deliveryId: `d${i}`,
        payload: {
          id: `false_120363000000000001@g.us_3EB0C431C26A${i}_123456789012345@lid`,
          chatId: '120363000000000001@g.us',
          fromMe: false,
          author: '123456789012345@lid',
          sender: '123456789012345@lid',
          body: 'hi',
        },
        engineRef: {
          chatId: '120363000000000001@g.us',
          direction: MessageDirection.INCOMING,
          author: '123456789012345@lid',
        },
      })),
    );

    expect(losses(warn).filter(({ reason }) => reason === 'dropped')).toEqual([]);
  });

  describe('a copy a change landed on', () => {
    // Later copies whose identity alone is 1 MiB: they pass the content bound, then the ceiling of copies without it.
    const pressure = (): void =>
      service.holdUnwritten(Array.from({ length: 90 }, (_, i) => row(i + 1, { author: `${'a'.repeat(MiB)}${i}` })));
    const changed = async (change: MessageCopyChange): Promise<void> => {
      service.holdUnwritten([row(0, { body: 'secret' })]);
      await service.changeUnwrittenForMessage('s', '0', change);
    };

    it('stays withdrawn past every bound, once a revoke reached it', async () => {
      await changed({ kind: 'close' });
      pressure();
      service.holdUnwritten(Array.from({ length: 10_001 }, (_, i) => row(i + 100)));

      expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeNull();
      await expect(service.currentMessagePayload('w', 'msg_s_0_w', 'message.received')).resolves.toBeNull();
    });

    it.each([
      ['a delete through the API', { kind: 'redact' }, { type: 'revoked', body: '' }],
      ['an edit', { kind: 'rewrite', body: 'edited text' }, { body: 'edited text' }],
    ] as const)('keeps what %s left while copies no change reached can go first', async (_label, change, kept) => {
      await changed(change);
      pressure();
      service.holdUnwritten(Array.from({ length: 10_001 }, (_, i) => row(i + 100)));

      expect(service.unwrittenCopy('w', 'msg_s_0_w')).toMatchObject(kept);
      expect(losses(warn).filter(({ idempotencyKey }) => idempotencyKey === 'msg_s_0_w')).toEqual([]);
    });

    // Copies whose edits each add 1 MiB: past the byte bound with no copy left that no change landed on.
    const rewrittenPast64MiB = async (): Promise<void> => {
      for (let i = 1; i <= 70; i++) {
        service.holdUnwritten([row(i)]);
        await service.changeUnwrittenForMessage('s', String(i), { kind: 'rewrite', body: 'x'.repeat(MiB) });
      }
    };

    it('withdraws a redacted copy, never sending what it held, once only changed copies are left to bound', async () => {
      await changed({ kind: 'redact' });
      await rewrittenPast64MiB();

      expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeNull();
      await expect(service.currentMessagePayload('w', 'msg_s_0_w', 'message.received')).resolves.toBeNull();
      expect(losses(warn).filter(({ idempotencyKey }) => idempotencyKey === 'msg_s_0_w')).toEqual([
        expect.objectContaining({ reason: 'bytes' }),
      ]);
    });

    it('logs the lost rewrite of a rewritten copy it lets go, once only changed copies are left to bound', async () => {
      await changed({ kind: 'rewrite', body: 'edited text' });
      await rewrittenPast64MiB();

      expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeUndefined();
      expect(losses(warn).filter(({ idempotencyKey }) => idempotencyKey === 'msg_s_0_w')).toEqual([
        expect.objectContaining({ reason: 'rewrite' }),
      ]);
      // What names the message is kept: a revoke still reaches it.
      await service.changeUnwrittenForMessage('s', '0', { kind: 'close' });
      expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeNull();
    });
  });

  describe('once the byte bound let the content go', () => {
    const shed = () => {
      service.holdUnwritten([row(0, { body: 'secret' })]);
      service.holdUnwritten(Array.from({ length: 65 }, (_, i) => row(i + 1, { media: { data: 'x'.repeat(MiB) } })));
      expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeUndefined();
    };

    it('send what the delivery holds when no change reaches it', async () => {
      shed();

      await expect(service.currentMessagePayload('w', 'msg_s_0_w', 'message.received')).resolves.toBeUndefined();
    });

    it.each([
      ['a revoke', { kind: 'close' }],
      ['a delete through the API', { kind: 'redact' }],
    ] as const)('withdraw the delivery once %s reaches it, by what still names the message', async (_label, change) => {
      shed();
      const judged: unknown[] = [];

      await service.changeUnwrittenForMessage('s', '0', change, payload => {
        judged.push(payload);
        return Promise.resolve(true);
      });

      expect(judged).toEqual([{ id: '0', chatId: '628111@c.us', fromMe: false, author: '628222@c.us' }]);
      await expect(service.currentMessagePayload('w', 'msg_s_0_w', 'message.received')).resolves.toBeNull();
      expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeNull();
    });

    it('log the lost rewrite of an edit that reaches it, and leave the delivery as it is', async () => {
      shed();

      await service.changeUnwrittenForMessage('s', '0', { kind: 'rewrite', body: 'edited' });

      expect(losses(warn).at(-1)).toMatchObject({ reason: 'rewrite', idempotencyKey: 'msg_s_0_w' });
      await expect(service.currentMessagePayload('w', 'msg_s_0_w', 'message.received')).resolves.toBeUndefined();
    });
  });
});

describe('WebhookOutboxService copies of queued deliveries, across a restart', () => {
  const MiB = 1024 * 1024;
  let dir: string;
  let journal: RecoveryJournal;
  let service: WebhookOutboxService;
  const repo = { findOne: () => Promise.resolve(null) } as never;
  const row = (i: number, payload: Record<string, unknown> = {}) => ({
    webhookId: 'w',
    sessionId: 's',
    event: 'message.received',
    idempotencyKey: `msg_s_${i}_w`,
    deliveryId: `d${i}`,
    payload: { id: String(i), chatId: '628111@c.us', fromMe: false, type: 'text', body: 'secret', ...payload },
  });
  const queued = (...rows: Array<ReturnType<typeof row>>): void => {
    service.holdUnwritten(rows);
    for (const r of rows) service.queuedUnwritten(r.webhookId, r.idempotencyKey, r.deliveryId);
  };
  const restart = (): void => {
    journal.close();
    journal = new RecoveryJournal(journal.path);
    service = new WebhookOutboxService(repo, journal);
  };

  beforeEach(() => {
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), 'outbox-journal-'));
    journal = new RecoveryJournal(join(dir, 'journal.jsonl'));
    service = new WebhookOutboxService(repo, journal);
  });

  afterEach(() => {
    journal.close();
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('journals a copy only once its delivery is queued, with what a change left of it by then', async () => {
    service.holdUnwritten([row(0), row(1)]);
    await service.changeUnwrittenForMessage('s', '0', { kind: 'redact' });
    service.queuedUnwritten('w', 'msg_s_0_w', 'd0');
    service.queuedUnwritten('w', 'never held', 'd9');

    restart();

    expect(service.unwrittenCopy('w', 'msg_s_0_w')).toMatchObject({ type: 'revoked', body: '' });
    expect(service.unwrittenCopy('w', 'msg_s_1_w')).toBeUndefined();
    expect(service.queuedCopies()).toEqual([{ webhookId: 'w', idempotencyKey: 'msg_s_0_w', deliveryId: 'd0' }]);
  });

  it.each([
    ['withdrawn by a revoke', { kind: 'close' }, null],
    [
      'rewritten by an edit',
      { kind: 'rewrite', body: 'edited text' },
      expect.objectContaining({ body: 'edited text' }),
    ],
  ] as const)('restores a copy %s as the change left it', async (_label, change, kept) => {
    queued(row(0));
    await service.changeUnwrittenForMessage('s', '0', change);

    restart();

    expect(service.unwrittenCopy('w', 'msg_s_0_w')).toEqual(kept);
  });

  it('restores a copy whose content was let go as such, which a revoke still withdraws', async () => {
    queued(row(0));
    queued(...Array.from({ length: 65 }, (_, i) => row(i + 1, { media: { data: 'x'.repeat(MiB) } })));
    expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeUndefined();

    restart();

    expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeUndefined();
    await service.changeUnwrittenForMessage('s', '0', { kind: 'close' });
    expect(service.unwrittenCopy('w', 'msg_s_0_w')).toBeNull();
  });

  it('forgets a copy with its delivery, and lets go of one it cannot read back', () => {
    queued(row(0), row(1));
    service.forgetUnwritten('w', 'msg_s_1_w');
    journal.close();
    appendFileSync(journal.path, `${JSON.stringify({ l: 'copy', k: 'w\u0000bad', v: { s: 's' } })}\n`);

    restart();

    expect(service.queuedCopies().map(copy => copy.idempotencyKey)).toEqual(['msg_s_0_w']);
    service.forgetUnwritten('w', 'msg_s_0_w');
    expect(readFileSync(journal.path, 'utf8')).toBe('');
  });
});
