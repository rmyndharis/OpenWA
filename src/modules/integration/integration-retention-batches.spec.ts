import { DataSource } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IntegrationRetentionService } from './integration-retention.service';
import { IngressReconcilerService } from './ingress-reconciler.service';
import { PRUNE_BATCH_SIZE } from '../../common/utils/batched-prune';

/**
 * SQLite runs a statement on the event loop, so the rows one DELETE removes are the time the whole process stands
 * still. The ingress dedup log and the integration dead letters are pruned in statements of a bounded size that give
 * the loop up between them, however large the backlog of expired rows is (see webhook-retention-batches.spec.ts).
 */
describe('integration retention prune on SQLite', () => {
  const BACKLOG = PRUNE_BATCH_SIZE * 2 + 100;
  let ds: DataSource;
  let log: Array<number | 'tick'>;

  const recordDeletes = (source: DataSource): void => {
    const connection = (source.driver as unknown as { databaseConnection: { prepare: (sql: string) => unknown } })
      .databaseConnection;
    const prepare = connection.prepare.bind(connection);
    connection.prepare = (sql: string) => {
      const statement = prepare(sql) as { run: (...args: unknown[]) => { changes: number } };
      if (/^\s*DELETE\b/i.test(sql)) {
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

  const eventRows = (
    count: number,
    daysOld: number,
    prefix: string,
    state: string,
    payload: string,
  ): Promise<unknown> =>
    ds.query(
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${count})
       INSERT INTO ingress_events (id, instanceId, pluginId, providerDeliveryId, route, payload, payloadHash, sessionId, dispatchState, dispatchAttempts, lastDispatchAt, createdAt)
       SELECT lower(hex(randomblob(16))), 'inst', 'plug', '${prefix}-' || i, 'chatwoot', ${payload}, 'h', NULL, '${state}', 0, NULL, datetime('now', '-${daysOld} days') FROM c`,
    );

  const failureRows = (count: number, daysOld: number): Promise<unknown> =>
    ds.query(
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${count})
       INSERT INTO integration_delivery_failures (id, direction, pluginId, instanceId, sessionId, deliveryId, attempts, lastError, payload, redriven, createdAt)
       SELECT lower(hex(randomblob(16))), 'inbound', 'plug', 'inst', NULL, 'd-' || i, 3, 'e', NULL, 1, datetime('now', '-${daysOld} days') FROM c`,
    );

  const service = (): IntegrationRetentionService =>
    new IntegrationRetentionService(ds.getRepository(IngressEvent), ds.getRepository(IntegrationDeliveryFailure), {
      deadLetterAgedPending: () => Promise.resolve(0),
    } as unknown as IngressReconcilerService);

  beforeEach(async () => {
    log = [];
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [IngressEvent, IntegrationDeliveryFailure],
      synchronize: true,
    });
    await ds.initialize();
    recordDeletes(ds);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('removes expired dedup rows and dead letters in bounded statements, and keeps what is still owed a dispatch', async () => {
    const payload = `'{"headers":{},"query":{},"body":"{}","rawBody":"{}"}'`;
    await eventRows(BACKLOG, 30, 'settled', 'dispatched', 'NULL');
    // An aged row still holding its payload while it is pending is kept for the hand-off; once it has none it goes.
    await eventRows(3, 30, 'owed', 'pending', payload);
    await eventRows(2, 30, 'emptied', 'pending', 'NULL');
    await eventRows(4, 1, 'recent', 'dispatched', 'NULL');
    await failureRows(BACKLOG, 200);
    await failureRows(5, 10);

    await expect(service().pruneOlderThan(7, 90)).resolves.toEqual({ events: BACKLOG + 2, failures: BACKLOG });

    expect(statements()).toEqual([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 100, PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 102]);
    expect(await ds.getRepository(IngressEvent).count()).toBe(3 + 4);
    expect(await ds.getRepository(IntegrationDeliveryFailure).count()).toBe(5);
  });

  it('gives up the event loop between statements, so a timer fires between any two of them', async () => {
    await failureRows(BACKLOG, 200);
    const timer = setInterval(() => log.push('tick'), 1);

    try {
      await service().pruneOlderThan(7, 90);
    } finally {
      clearInterval(timer);
    }

    const at = log.flatMap((entry, index) => (entry === 'tick' ? [] : [index]));
    expect(at).toHaveLength(3);
    for (let i = 1; i < at.length; i++) {
      expect(log.slice(at[i - 1], at[i])).toContain('tick');
    }
  });

  it('stops between statements once the service is destroyed, and still runs the hand-off', async () => {
    await failureRows(BACKLOG, 200);
    const failures = ds.getRepository(IntegrationDeliveryFailure);
    const handOff = jest.fn().mockResolvedValue(0);
    const retention = new IntegrationRetentionService(ds.getRepository(IngressEvent), failures, {
      deadLetterAgedPending: handOff,
    } as unknown as IngressReconcilerService);
    const remove = failures.delete.bind(failures) as (ids: string[]) => Promise<unknown>;
    jest.spyOn(failures, 'delete').mockImplementationOnce(((ids: string[]) => {
      retention.onModuleDestroy();
      return remove(ids);
    }) as never);

    await expect(retention.pruneOlderThan(7, 90)).resolves.toEqual({ events: 0, failures: PRUNE_BATCH_SIZE });

    expect(await failures.count()).toBe(BACKLOG - PRUNE_BATCH_SIZE);
    expect(handOff).toHaveBeenCalledTimes(1);
  });
});
