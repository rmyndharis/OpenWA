import { DataSource, In } from 'typeorm';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';

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
