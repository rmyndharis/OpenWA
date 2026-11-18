import { DataSource } from 'typeorm';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookService } from './webhook.service';
import { PRUNE_BATCH_SIZE } from '../../common/utils/batched-prune';

/**
 * SQLite runs a statement on the event loop, so the rows one statement changes are the time the whole process
 * (requests, sockets, engines, deliveries) stands still. A backlog (a start after a long stop, a shorter retention
 * window, receivers that were down for days) is removed in statements of a bounded size that give the loop up
 * between them, as a session delete does, not in one statement that holds it for the whole backlog.
 */
describe('webhook retention prunes on SQLite', () => {
  const BACKLOG = PRUNE_BATCH_SIZE * 2 + 100;
  let ds: DataSource;
  /** The rows each DELETE or UPDATE statement changed, whichever API issued it, and where a timer fired. */
  let log: Array<number | 'tick'>;

  const record = (source: DataSource): void => {
    const connection = (source.driver as unknown as { databaseConnection: { prepare: (sql: string) => unknown } })
      .databaseConnection;
    const prepare = connection.prepare.bind(connection);
    connection.prepare = (sql: string) => {
      const statement = prepare(sql) as { run: (...args: unknown[]) => { changes: number } };
      if (/^\s*(DELETE|UPDATE)\b/i.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = (...args: unknown[]) => {
          const result = run(...args);
          log.push(result.changes);
          return result;
        };
      }
      return statement;
    };
  };

  const statements = (): number[] => log.filter((entry): entry is number => entry !== 'tick');

  const outboxRows = (count: number, state: string, daysOld: number, prefix: string): Promise<unknown> =>
    ds.query(
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${count})
       INSERT INTO webhook_outbox_events (id, webhookId, sessionId, event, idempotencyKey, deliveryId, payload, state, attempts, lastAttemptAt, createdAt)
       SELECT lower(hex(randomblob(16))), 'wh-1', 'sess-1', 'message.ack', '${prefix}-' || i, 'dlv-${prefix}-' || i, NULL, '${state}', 0, NULL, datetime('now', '-${daysOld} days') FROM c`,
    );

  const failureRows = (count: number, daysOld: number, prefix: string, payload = 'NULL'): Promise<unknown> =>
    ds.query(
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${count})
       INSERT INTO webhook_delivery_failures (id, webhookId, sessionId, event, url, idempotencyKey, deliveryId, attempts, lastStatusCode, lastError, payload, createdAt)
       SELECT lower(hex(randomblob(16))), 'wh-1', 'sess-1', 'message.received', 'https://receiver.example/hook', '${prefix}-' || i, 'dlv-${prefix}-' || i, 3, 503, 'HTTP 503: unavailable', ${payload}, datetime('now', '-${daysOld} days') FROM c`,
    );

  beforeEach(async () => {
    log = [];
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [WebhookOutboxEvent, WebhookDeliveryFailure],
      synchronize: true,
    });
    await ds.initialize();
    record(ds);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('removes a backlog of settled outbox rows in bounded statements, and keeps every row that can be replayed', async () => {
    await outboxRows(BACKLOG, 'dispatched', 30, 'old');
    await outboxRows(3, 'pending', 30, 'held');
    await outboxRows(2, 'queued', 30, 'queued');
    await outboxRows(4, 'dispatched', 1, 'recent');
    const service = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));

    await expect(service.pruneSettled(7)).resolves.toBe(BACKLOG);

    expect(statements()).toEqual([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 100]);
    expect(await ds.getRepository(WebhookOutboxEvent).count()).toBe(3 + 2 + 4);
  });

  it('removes a backlog of expired delivery failures in bounded statements, and keeps the recent ones', async () => {
    await failureRows(BACKLOG, 200, 'old');
    await failureRows(6, 5, 'recent');
    const failures = ds.getRepository(WebhookDeliveryFailure);
    const service = new WebhookService(null as never, failures, null as never, null as never, null as never);

    await expect(service.pruneDeliveryFailures(90)).resolves.toBe(BACKLOG);

    expect(statements()).toEqual([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 100]);
    expect(await failures.count()).toBe(6);
  });

  it('clears the replay payload of a backlog of rows in bounded statements, and keeps the rows', async () => {
    await failureRows(BACKLOG, 10, 'old', `'{"event":"message.received"}'`);
    await failureRows(6, 0, 'recent', `'{"event":"message.received"}'`);
    const failures = ds.getRepository(WebhookDeliveryFailure);
    const service = new WebhookService(null as never, failures, null as never, null as never, null as never);

    await expect(service.pruneDeliveryFailurePayloads(72)).resolves.toBe(BACKLOG);

    expect(statements()).toEqual([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 100]);
    expect(await failures.count()).toBe(BACKLOG + 6);
    const held = await ds.query<Array<{ held: number }>>(
      `SELECT count(*) AS held FROM webhook_delivery_failures WHERE payload IS NOT NULL`,
    );
    expect(held[0].held).toBe(6);
  });

  it('gives up the event loop between statements, so a timer fires between any two of them', async () => {
    await failureRows(BACKLOG, 200, 'old');
    const failures = ds.getRepository(WebhookDeliveryFailure);
    const service = new WebhookService(null as never, failures, null as never, null as never, null as never);
    const timer = setInterval(() => log.push('tick'), 1);

    try {
      await service.pruneDeliveryFailures(90);
    } finally {
      clearInterval(timer);
    }

    const at = log.flatMap((entry, index) => (entry === 'tick' ? [] : [index]));
    expect(at).toHaveLength(3);
    for (let i = 1; i < at.length; i++) {
      expect(log.slice(at[i - 1], at[i])).toContain('tick');
    }
  });

  it('stops between statements once the service is destroyed', async () => {
    await failureRows(BACKLOG, 200, 'old');
    const failures = ds.getRepository(WebhookDeliveryFailure);
    const service = new WebhookService(null as never, failures, null as never, null as never, null as never);
    const remove = failures.delete.bind(failures) as (ids: string[]) => Promise<unknown>;
    jest.spyOn(failures, 'delete').mockImplementationOnce(((ids: string[]) => {
      service.onModuleDestroy();
      return remove(ids);
    }) as never);

    await expect(service.pruneDeliveryFailures(90)).resolves.toBe(PRUNE_BATCH_SIZE);

    expect(await failures.count()).toBe(BACKLOG - PRUNE_BATCH_SIZE);
  });
});
