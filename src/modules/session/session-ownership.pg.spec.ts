/* istanbul ignore file: PG-gated, only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { SessionOwnershipService } from './session-ownership.service';
import { postgresUtcExtra } from '../../database/postgres-utc';

/**
 * Verifies against a real PostgreSQL server that lease claims, expiry checks, takeovers, and
 * heartbeat duplicate-NODE_ID detection are evaluated strictly on PostgreSQL's UTC database clock
 * rather than each node's local process clock.
 *
 * Node B runs with Date.now() shifted +120s ahead of real DB time (twice the 60s lease TTL).
 * With process-clock leases, Node B would immediately see Node A's fresh claim as expired and steal
 * it; with DB-clock leases, Node B cannot steal it and Node A's renewals never false-positive
 * duplicate_node_id under the same skew.
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';

(POSTGRES_ENABLED ? describe : describe.skip)('SessionOwnershipService DB-clock leases (postgres)', () => {
  const schema = `session_lease_clk_${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: DataSource;
  let poolA: DataSource;
  let poolB: DataSource;
  let repoA: Repository<Session>;
  let repoB: Repository<Session>;

  const cfgFor = (nodeId: string, leaseTtlMs = 60_000) =>
    ({
      get: (key: string) =>
        ({
          'session.nodeId': nodeId,
          'session.nodeUrl': `http://${nodeId}.internal:2785`,
          'session.leaseTtlMs': leaseTtlMs,
        })[key],
    }) as never;

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
    };
    admin = await new DataSource(connection).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);

    const scoped = {
      ...connection,
      schema,
      entities: [Session],
      synchronize: true,
      extra: postgresUtcExtra(undefined, { searchPath: `${schema},public` }),
    };
    poolA = await new DataSource(scoped).initialize();
    poolB = await new DataSource({ ...scoped, synchronize: false }).initialize();
    repoA = poolA.getRepository(Session);
    repoB = poolB.getRepository(Session);
  }, 60_000);

  beforeEach(async () => {
    await repoA.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (poolB?.isInitialized) await poolB.destroy();
    if (poolA?.isInitialized) await poolA.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  it('prevents a +120s clock-skewed peer from stealing a fresh DB-clock lease and avoids false duplicate_node_id on renew', async () => {
    const session = await repoA.save(
      repoA.create({
        name: 'pg-clock-skew-session',
        status: SessionStatus.READY,
        phone: '628111',
        config: {},
      }),
    );

    const nodeA = new SessionOwnershipService(repoA, cfgFor('node-a', 60_000));
    const nodeB = new SessionOwnershipService(repoB, cfgFor('node-b', 60_000));

    expect(nodeA.isPostgres).toBe(true);
    expect(nodeB.isPostgres).toBe(true);
    await expect(nodeA.claim(session.id)).resolves.toBe(true);

    // Shift both Date.now() and new Date() +120s ahead (double the 60s lease TTL) while keeping
    // real timers so PostgreSQL socket and query timeouts operate normally.
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'hrtime',
        'performance',
      ],
      now: Date.now() + 120_000,
    });

    // Node B with a +120s skewed clock must see Node A's lease as live and fail to steal or release it.
    await expect(nodeB.claim(session.id)).resolves.toBe(false);
    await expect(nodeB.isHeldByOtherNode(session.id)).resolves.toBe(true);
    await expect(nodeB.heldByOtherNodes()).resolves.toEqual([session.id]);
    await expect(nodeB.lapsedHeldByOthers()).resolves.toEqual([]);
    await expect(nodeB.stopExpiredForeignClaim(session.id)).resolves.toBe(false);
    await nodeB.release(session.id);

    const liveOwner = await nodeB.findLiveOwner(session.id);
    expect(liveOwner?.nodeId).toBe('node-a');
    const claimedRow = await repoB.findOneByOrFail({ id: session.id });
    const dbNow = await nodeB.getDbNow();
    expect(nodeB.heldByOtherLiveNode(claimedRow, dbNow)).toBe(true);
    await expect(nodeA.hasLiveOwnClaim(session.id)).resolves.toBe(true);
    await expect(nodeA.prepareStart(session.id, null)).resolves.toBe(true);

    // Node A renewing under the same +120s clock skew must stay quiet (zero duplicate_node_id).
    const errorSpy = jest
      .spyOn((nodeA as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error')
      .mockImplementation(() => undefined);

    for (let i = 0; i < 4; i++) {
      await nodeA.renew();
    }

    const duplicateLogs = errorSpy.mock.calls.filter(
      c => (c[2] as { action?: string } | undefined)?.action === 'duplicate_node_id',
    );
    expect(duplicateLogs).toHaveLength(0);
    expect((await repoA.findOneByOrFail({ id: session.id })).nodeId).toBe('node-a');
  });
});
