import 'reflect-metadata';
import { LoggerService } from '../../common/services/logger.service';
import { DataSource, FindOperator, Repository } from 'typeorm';
import { Session } from '../session/entities/session.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { OUTBOX_UNREADABLE_RETRY_MS, WebhookOutboxService } from './webhook-outbox.service';
import { recordWebhookDeliveryFailure } from './utils/record-delivery-failure';
import { dataHash } from './utils/deliver-once';

// SQLite serves every repository from one connection, so a transaction a write opens is shared with the
// writes that run while it is open. A re-dispatched key makes open() hit the unique violation it expects.
describe('WebhookOutboxService.open() against a concurrent write (SQLite)', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure, WebhookOutboxEvent],
      synchronize: true,
    }).initialize();
  });
  afterEach(() => ds.destroy());

  it('does not undo a delivery failure recorded while a duplicate key is rejected', async () => {
    const outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
    const failures = ds.getRepository(WebhookDeliveryFailure);
    const logger = { error: jest.fn() };
    const lost: number[] = [];

    for (let i = 0; i < 20; i++) {
      const row = { webhookId: 'w1', sessionId: 's1', event: 'message.ack', deliveryId: `d${i}`, payload: { i } };
      await outbox.open({ ...row, idempotencyKey: `ack_${i}` });

      const duplicate = outbox.open({ ...row, idempotencyKey: `ack_${i}`, deliveryId: `d${i}b` });
      const recorded = recordWebhookDeliveryFailure(failures, logger, {
        webhookId: 'w1',
        sessionId: 's1',
        event: 'message.received',
        url: 'https://a.example',
        idempotencyKey: `other_${i}`,
        deliveryId: `x${i}`,
        attempts: 3,
        lastStatusCode: 503,
        lastError: 'HTTP 503',
      });
      const [, result] = await Promise.all([duplicate, recorded]);

      // The recorder answered that the row is durable, so it must be there.
      if (result !== null && (await failures.count({ where: { idempotencyKey: `other_${i}` } })) === 0) lost.push(i);
    }

    expect(lost).toEqual([]);
  });
});

// The payload column is text on SQLite and is parsed when a row is read. A row whose stored text is not
// JSON (an imported or hand-edited row) must cost the sweep that row only, not every row behind it.
describe('WebhookOutboxService.findStale() past an unreadable payload (SQLite)', () => {
  let ds: DataSource;
  let outbox: WebhookOutboxService;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure, WebhookOutboxEvent],
      synchronize: true,
    }).initialize();
    outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
  });
  afterEach(() => ds.destroy());

  const insertRaw = async (id: string, key: string, payload: string, createdAt: string): Promise<void> => {
    await ds.query(
      `INSERT INTO webhook_outbox_events (id, webhookId, sessionId, event, idempotencyKey, deliveryId, payload, state, attempts, createdAt)
       VALUES (?, 'w1', 's1', 'message.received', ?, ?, ?, 'pending', 0, ?)`,
      [id, key, `d-${key}`, payload, createdAt],
    );
  };

  it('returns the readable rows behind it and reports how far it scanned', async () => {
    await insertRaw('00000000-0000-4000-8000-000000000001', 'k1', '{oops', '2026-01-01 00:00:00');
    await insertRaw('00000000-0000-4000-8000-000000000002', 'k2', '{"a":1}', '2026-01-01 00:00:01');
    await insertRaw('00000000-0000-4000-8000-000000000003', 'k3', '{oops', '2026-01-01 00:00:02');

    let scannedThrough: string | undefined;
    const rows = await outbox.findStale(new Date('2026-02-01T00:00:00Z'), 10, undefined, id => (scannedThrough = id));

    expect(rows.map(r => r.idempotencyKey)).toEqual(['k2']);
    expect(rows[0].payload).toEqual({ a: 1 });
    // The cursor passes the unreadable row at the end of the page, or a page of them would be read again forever.
    expect(scannedThrough).toBe('00000000-0000-4000-8000-000000000003');
  });

  it('logs each unreadable row with its id and action as fields, not as the trace', async () => {
    const error = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    try {
      await insertRaw('00000000-0000-4000-8000-000000000001', 'k1', '{oops', '2026-01-01 00:00:00');

      await outbox.findStale(new Date('2026-02-01T00:00:00Z'), 10);

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('could not be read'),
        expect.any(String),
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000001',
          action: 'webhook_outbox_row_unreadable',
        }),
      );
    } finally {
      error.mockRestore();
    }
  });

  // The page read fails for as long as the row sits in it, and each failure is a read of every row of the page
  // and a log line, on every pass of the sweep, for a row that cannot be replayed anyway.
  it('leaves an unreadable row out of the next passes and reads it again after the wait', async () => {
    const error = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    const now = jest.spyOn(Date, 'now');
    try {
      const t0 = Date.parse('2026-02-01T00:00:00Z');
      now.mockReturnValue(t0);
      await insertRaw('00000000-0000-4000-8000-000000000001', 'k1', '{oops', '2026-01-01 00:00:00');
      await insertRaw('00000000-0000-4000-8000-000000000002', 'k2', '{"a":1}', '2026-01-01 00:00:01');
      const olderThan = new Date('2026-01-15T00:00:00Z');

      expect((await outbox.findStale(olderThan, 10)).map(r => r.idempotencyKey)).toEqual(['k2']);
      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);

      // Same wait still running: the page reads, and nothing is logged.
      now.mockReturnValue(t0 + OUTBOX_UNREADABLE_RETRY_MS - 1);
      expect((await outbox.findStale(olderThan, 10)).map(r => r.idempotencyKey)).toEqual(['k2']);
      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);

      now.mockReturnValue(t0 + OUTBOX_UNREADABLE_RETRY_MS);
      expect((await outbox.findStale(olderThan, 10)).map(r => r.idempotencyKey)).toEqual(['k2']);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

// A read that fails because the database said "not now" says nothing about the row: it is read again by the next pass.
describe('WebhookOutboxService.findStale() past a row the database would not read', () => {
  const failing = (rowError: Error) => {
    const find = jest
      .fn()
      .mockRejectedValueOnce(new Error('page read failed'))
      .mockResolvedValueOnce([{ id: 'row-1' }])
      .mockRejectedValueOnce(new Error('page read failed'))
      .mockResolvedValue([{ id: 'row-1' }]);
    const findOneBy = jest.fn().mockRejectedValue(rowError);
    const outbox = new WebhookOutboxService({ find, findOneBy } as unknown as Repository<WebhookOutboxEvent>);
    return { outbox, find };
  };
  const pageWhere = (find: jest.Mock, call: number): Record<string, unknown> =>
    (find.mock.calls[call] as [{ where: Record<string, unknown> }])[0].where;

  it('keeps leaving a row out when its payload does not parse, and not when the database was busy', async () => {
    const olderThan = new Date('2026-02-01T00:00:00Z');
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const parse = failing(new SyntaxError('Unexpected token o in JSON'));
      await parse.outbox.findStale(olderThan, 10);
      await parse.outbox.findStale(olderThan, 10);
      expect(pageWhere(parse.find, 0)).not.toHaveProperty('id');
      expect(pageWhere(parse.find, 2)).toHaveProperty('id');

      const busy = failing(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
      await busy.outbox.findStale(olderThan, 10);
      await busy.outbox.findStale(olderThan, 10);
      expect(pageWhere(busy.find, 2)).not.toHaveProperty('id');
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('remembers at most 1000 unreadable rows, the newest of them', async () => {
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const ids = Array.from({ length: 1001 }, (_, i) => ({ id: `row-${i}` }));
      const find = jest
        .fn()
        .mockRejectedValueOnce(new Error('page read failed'))
        .mockResolvedValueOnce(ids)
        .mockResolvedValue([]);
      const findOneBy = jest.fn().mockRejectedValue(new SyntaxError('Unexpected token o in JSON'));
      const outbox = new WebhookOutboxService({ find, findOneBy } as unknown as Repository<WebhookOutboxEvent>);

      await outbox.findStale(new Date('2026-02-01T00:00:00Z'), 2000);
      await outbox.findStale(new Date('2026-02-01T00:00:00Z'), 2000);

      const left = (pageWhere(find, 2).id as FindOperator<string[]>).value;
      expect(left).toHaveLength(1000);
      expect(left).not.toContain('row-0');
      expect(left).toContain('row-1000');
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe('WebhookOutboxService.openBatch() conflict-ignoring transactional insert (SQLite)', () => {
  let ds: DataSource;
  let outbox: WebhookOutboxService;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure, WebhookOutboxEvent],
      synchronize: true,
    }).initialize();
    outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
  });
  afterEach(() => ds.destroy());

  it('inserts fresh rows, ignores duplicates without aborting an enclosing transaction, and returns newly inserted rows', async () => {
    const row1 = {
      webhookId: 'w1',
      sessionId: 's1',
      event: 'message.received',
      idempotencyKey: 'k1_w1',
      deliveryId: 'd1',
      payload: { id: 'm1' },
    };
    const row2 = {
      webhookId: 'w2',
      sessionId: 's1',
      event: 'message.received',
      idempotencyKey: 'k1_w2',
      deliveryId: 'd2',
      payload: { id: 'm1' },
    };

    const first = await outbox.openBatch([row1]);
    expect(first).not.toBeNull();
    expect(first!.map(r => r.idempotencyKey)).toEqual(['k1_w1']);

    // Inside a transaction, a batch containing one duplicate and one fresh row must succeed
    // without rolling back the enclosing transaction or throwing a unique violation.
    const second = await ds.transaction(async manager => {
      const inserted = await outbox.openBatch([row1, row2], manager);
      await manager.getRepository(WebhookDeliveryFailure).insert({
        webhookId: 'w1',
        sessionId: 's1',
        event: 'message.received',
        url: 'https://a.example',
        idempotencyKey: 'sibling_in_tx',
        deliveryId: 'sib-1',
        attempts: 1,
        lastStatusCode: 500,
        lastError: 'HTTP 500',
      });
      return inserted;
    });

    expect(second).not.toBeNull();
    expect(second!.map(r => r.idempotencyKey)).toEqual(['k1_w2']);
    expect(await ds.getRepository(WebhookOutboxEvent).count()).toBe(2);
    expect(await ds.getRepository(WebhookDeliveryFailure).count({ where: { idempotencyKey: 'sibling_in_tx' } })).toBe(
      1,
    );
  });

  it('propagates non-conflict errors when running inside a caller transaction so the transaction rolls back', async () => {
    await ds.query(`
      CREATE TRIGGER fail_outbox_insert BEFORE INSERT ON webhook_outbox_events
      BEGIN
        SELECT RAISE(ABORT, 'simulated outbox disk error');
      END
    `);

    await expect(
      ds.transaction(async manager => {
        await manager.getRepository(WebhookDeliveryFailure).insert({
          webhookId: 'w1',
          sessionId: 's1',
          event: 'message.received',
          url: 'https://a.example',
          idempotencyKey: 'must_rollback',
          deliveryId: 'rb-1',
          attempts: 1,
          lastStatusCode: 500,
          lastError: 'HTTP 500',
        });
        await outbox.openBatch(
          [
            {
              webhookId: 'w1',
              sessionId: 's1',
              event: 'message.received',
              idempotencyKey: 'bad',
              deliveryId: 'd-bad',
              payload: {},
            },
          ],
          manager,
        );
      }),
    ).rejects.toThrow(/simulated outbox disk error/i);

    expect(await ds.getRepository(WebhookDeliveryFailure).count({ where: { idempotencyKey: 'must_rollback' } })).toBe(
      0,
    );
  });

  it('chunks large batches (>115 rows) below SQLite bind-parameter limits and deduplicates across chunks', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({
      webhookId: `w-${i}`,
      sessionId: 's1',
      event: 'message.received',
      idempotencyKey: `msg_s1_m1_w-${i}`,
      deliveryId: `d-${i}`,
      payload: { id: 'm1', index: i },
    }));

    const paramCounts: number[] = [];
    const runner = ds.createQueryRunner();
    const realQuery = runner.query.bind(runner);
    const querySpy = jest
      .spyOn(runner, 'query')
      .mockImplementation((sql: string, params?: unknown, useStructuredResult?: boolean) => {
        if (/INSERT INTO "webhook_outbox_events"/i.test(sql) && Array.isArray(params)) {
          paramCounts.push(params.length);
        }
        return realQuery(sql, params as never, useStructuredResult as never);
      });

    try {
      const inserted = await outbox.openBatch(rows);
      expect(inserted).not.toBeNull();
      expect(inserted).toHaveLength(120);
      expect(await ds.getRepository(WebhookOutboxEvent).count()).toBe(120);
      // 120 rows at 9 columns each must split into >= 2 chunks, each <= 900 bind variables (< SQLite's 999 limit).
      expect(paramCounts.length).toBeGreaterThanOrEqual(2);
      for (const count of paramCounts) {
        expect(count).toBeLessThanOrEqual(900);
      }

      // Replaying the same 120 rows plus 5 new ones must return only the 5 newly inserted rows.
      const extra = Array.from({ length: 5 }, (_, i) => ({
        webhookId: `w-extra-${i}`,
        sessionId: 's1',
        event: 'message.received',
        idempotencyKey: `msg_s1_m1_w-extra-${i}`,
        deliveryId: `d-extra-${i}`,
        payload: { id: 'm1', extra: i },
      }));
      const second = await outbox.openBatch([...rows, ...extra]);
      expect(second).not.toBeNull();
      expect(second!.map(r => r.webhookId)).toEqual(extra.map(r => r.webhookId));
      expect(await ds.getRepository(WebhookOutboxEvent).count()).toBe(125);
    } finally {
      querySpy.mockRestore();
    }
  });

  it('pruneSettled uses IDX_webhook_outbox_events_state_createdAt, caps maxRows, and handles legacy NULL states in a bounded pass', async () => {
    const outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
    const repo = ds.getRepository(WebhookOutboxEvent);
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const oldSqlDate = oldDate.toISOString().replace('T', ' ').slice(0, 19);

    const seed = (prefix: string, count: number, state: string) =>
      repo.insert(
        Array.from({ length: count }, (_, i) => ({
          webhookId: 'wh-1',
          sessionId: 'sess-1',
          event: 'message.received',
          idempotencyKey: `${prefix}-${i}`,
          deliveryId: `dlv-${prefix}-${i}`,
          payload: null,
          state: state as never,
          attempts: 0,
        })),
      );
    await seed('disp', 8, 'dispatched');
    await seed('fail', 6, 'failed');
    await seed('pend', 2, 'pending');
    await seed('que', 2, 'queued');
    await seed('leg', 5, 'dispatched');
    await ds.query(`UPDATE webhook_outbox_events SET createdAt = ?`, [oldSqlDate]);
    await ds.query(`UPDATE webhook_outbox_events SET state = NULL WHERE idempotencyKey LIKE 'leg-%'`);

    const capturedPlans: string[] = [];
    const spiedRunners = new WeakSet<object>();
    const origQuery = ds.driver.createQueryRunner.bind(ds.driver);
    const queryRunnerSpy = jest.spyOn(ds.driver, 'createQueryRunner').mockImplementation(mode => {
      const qr = origQuery(mode);
      if (!spiedRunners.has(qr)) {
        spiedRunners.add(qr);
        const origQrQuery = qr.query.bind(qr) as (...args: unknown[]) => Promise<never>;
        jest.spyOn(qr, 'query').mockImplementation(async (sql: string, ...rest: unknown[]) => {
          if (/SELECT .* FROM "webhook_outbox_events"/i.test(sql) && /state/i.test(sql)) {
            const plan = (await origQrQuery(`EXPLAIN QUERY PLAN ${sql}`, rest[0])) as unknown as Array<{
              detail: string;
            }>;
            capturedPlans.push(...plan.map(p => p.detail));
          }
          return origQrQuery(sql, ...rest);
        });
      }
      return qr;
    });

    try {
      const firstRun = await outbox.pruneSettled(7, 10);
      expect(firstRun).toBe(10);
      expect(capturedPlans.some(d => /USING INDEX IDX_webhook_outbox_events_state_createdAt/.test(d))).toBe(true);
      expect(capturedPlans.some(d => /^SCAN webhook_outbox_events\b/.test(d))).toBe(false);

      // Pending and queued rows must remain untouched; finishing remaining settled + legacy NULL rows leaves 4.
      const secondRun = await outbox.pruneSettled(7, 50);
      expect(secondRun).toBe(9);
      const remaining = await repo.find();
      expect(remaining.map(r => r.state).sort()).toEqual(['pending', 'pending', 'queued', 'queued']);
    } finally {
      queryRunnerSpy.mockRestore();
      await outbox.onModuleDestroy();
    }
  });
});

describe('WebhookOutboxService.currentMessagePayload() (SQLite)', () => {
  let ds: DataSource;
  let outbox: WebhookOutboxService;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure, WebhookOutboxEvent],
      synchronize: true,
    }).initialize();
    outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
  });
  afterEach(() => ds.destroy());

  // What a dispatch hands a webhook: nested objects, arrays, a field left undefined, a Date and non-ASCII text.
  const message = {
    id: 'true_628111@c.us_3EB0',
    chatId: '628111@c.us',
    fromMe: false,
    type: 'image',
    body: 'caption, café ✓',
    author: undefined,
    timestamp: 1_700_000_000,
    sentAt: new Date('2026-11-27T10:00:00.000Z'),
    media: { mimetype: 'image/jpeg', omitted: true, sizeBytes: 2048 },
    quotedMessage: { id: 'Q-1', body: 'earlier', fromMe: true },
    mentionedIds: ['628222@c.us'],
    isForwarded: false,
  } as Record<string, unknown>;
  const open = (event: string, payload: Record<string, unknown>): Promise<unknown> =>
    outbox.openBatch([
      { webhookId: 'w1', sessionId: 's1', event, idempotencyKey: 'msg_s1_M_w1', deliveryId: 'd1', payload },
    ]);

  it('reads back data that hashes as it did when the row was opened, until something rewrites it', async () => {
    await open('message.received', message);

    const held = await outbox.currentMessagePayload('w1', 'msg_s1_M_w1', 'message.received');
    expect(dataHash(held!)).toBe(dataHash(message));

    await outbox.rewritePendingForMessage('s1', 'M', 'edited text');
    await outbox.markQueued('w1', 'msg_s1_M_w1', 'd2');
    const rewritten = await outbox.currentMessagePayload('w1', 'msg_s1_M_w1', 'message.received');
    expect(rewritten).toMatchObject({ body: 'edited text', edited: true });
    expect(dataHash(rewritten!)).not.toBe(dataHash(message));
  });

  it('answers null once the row is closed, and nothing for another event or a row of another event', async () => {
    await open('message.sent', message);

    expect(await outbox.currentMessagePayload('w1', 'msg_s1_M_w1', 'message.received')).toBeUndefined();
    expect(await outbox.currentMessagePayload('w1', 'msg_s1_M_w1', 'session.status')).toBeUndefined();
    expect(await outbox.currentMessagePayload('w1', 'missing', 'message.sent')).toBeUndefined();

    await outbox.close('w1', 'msg_s1_M_w1', 'dispatched');
    expect(await outbox.currentMessagePayload('w1', 'msg_s1_M_w1', 'message.sent')).toBeNull();
  });

  it('reads a payload that does not parse as no row, and throws when the database cannot answer', async () => {
    await ds.query(
      `INSERT INTO webhook_outbox_events (id, webhookId, sessionId, event, idempotencyKey, deliveryId, payload, state, attempts)
       VALUES ('r1', 'w1', 's1', 'message.received', 'msg_s1_M_w1', 'd1', '{not json', 'pending', 0)`,
    );
    expect(await outbox.currentMessagePayload('w1', 'msg_s1_M_w1', 'message.received')).toBeUndefined();

    await ds.destroy();
    await expect(outbox.currentMessagePayload('w1', 'msg_s1_M_w1', 'message.received')).rejects.toThrow();
    ds = await new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [] }).initialize();
  });
});
