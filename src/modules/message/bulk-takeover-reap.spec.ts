import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource, type DataSourceOptions, type EntityManager, type Repository } from 'typeorm';
import { BetterSqlite3QueryRunner } from 'typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { BatchStatus, MessageBatch } from './entities/message-batch.entity';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { BulkMessageService } from './bulk-message.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { LoggerService } from '../../common/services/logger.service';
import { postgresUtcExtra } from '../../database/postgres-utc';

const TTL_MS = 60_000;

/**
 * The node that takes over a session whose holder vanished fails the batches that holder left unfinished, inside
 * the transaction of its claim. A database that cannot answer that reap loses none of them: on PostgreSQL the claim
 * fails with it and is taken again with its reap, and on SQLite, where only this node's own earlier identity can be
 * taken over, the boot that takes it fails every unfinished batch of a session it may claim.
 */
describe('the takeover reap of a vanished node, refused by the database', () => {
  const pg = process.env.DATABASE_TYPE === 'postgres';
  let db: DataSource;
  let schema: string | undefined;
  let sessions: Repository<Session>;
  let batches: Repository<MessageBatch>;

  beforeAll(async () => {
    if (pg) {
      schema = `bulk_takeover_reap_${randomUUID().replace(/-/g, '')}`;
      const options: DataSourceOptions = {
        type: 'postgres',
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
        schema,
        entities: [Session, MessageBatch],
        extra: postgresUtcExtra(),
      };
      const setup = await new DataSource(options).initialize();
      await setup.query(`CREATE SCHEMA "${schema}"`);
      await setup.destroy();
      db = await new DataSource({ ...options, synchronize: true }).initialize();
    } else {
      db = await new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [Session, MessageBatch],
        synchronize: true,
      }).initialize();
    }
    sessions = db.getRepository(Session);
    batches = db.getRepository(MessageBatch);
  });

  afterAll(async () => {
    if (schema) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.destroy();
  });

  beforeEach(() => {
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await batches.clear();
    await sessions.clear();
  });

  /** A session `node-a` ran a batch for, then vanished: its lease lapsed a moment ago. */
  async function abandoned(): Promise<{ sessionId: string; batchId: string }> {
    const session = await sessions.save(
      sessions.create({
        name: `left-${randomUUID().slice(0, 8)}`,
        status: SessionStatus.READY,
        phone: '628111',
        config: {},
        nodeId: 'node-a',
        claimedAt: new Date(Date.now() - 5 * TTL_MS),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      }),
    );
    const batch = await batches.save(
      batches.create({
        batchId: 'left-behind',
        sessionId: session.id,
        status: BatchStatus.PROCESSING,
        messages: [{ chatId: '628222@c.us', type: 'text', content: { text: 'hello' } }],
        progress: { total: 1, pending: 1, sent: 0, failed: 0, cancelled: 0 },
        results: [],
      }),
    );
    return { sessionId: session.id, batchId: batch.batchId };
  }

  /** The node that takes it over, with its adoption reap registered as the gateway registers it. */
  function node(nodeId: string) {
    const config = { get: (key: string, fallback?: unknown) => ({ 'session.nodeId': nodeId })[key] ?? fallback };
    const ownership = new SessionOwnershipService(sessions, config as never);
    const bulk = new BulkMessageService(
      batches,
      new EngineRegistry(),
      {} as never,
      {} as never,
      {} as never,
      ownership,
    );
    bulk.onModuleInit();
    return { ownership, bulk };
  }

  const statusOf = async (batchId: string): Promise<BatchStatus> => (await batches.findOneByOrFail({ batchId })).status;

  (pg ? it.skip : it)('on SQLite, fails the batch at the boot that took the session over', async () => {
    const { sessionId, batchId } = await abandoned();
    const b = node('node-b');
    // The reap's write is refused once, inside the claim's transaction, which goes on.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied below with the runner as `this`
    const query = BetterSqlite3QueryRunner.prototype.query;
    let refused = false;
    jest.spyOn(BetterSqlite3QueryRunner.prototype, 'query').mockImplementation(function (
      this: BetterSqlite3QueryRunner,
      ...args: Parameters<BetterSqlite3QueryRunner['query']>
    ) {
      if (!refused && /^\s*UPDATE "message_batches"/i.test(String(args[0]))) {
        refused = true;
        return Promise.reject(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' }));
      }
      return query.apply(this, args);
    } as never);

    await expect(b.ownership.claim(sessionId)).resolves.toBe(true);
    expect(refused).toBe(true);
    expect(await statusOf(batchId)).toBe(BatchStatus.PROCESSING);
    await b.bulk.onApplicationBootstrap();

    expect(await statusOf(batchId)).toBe(BatchStatus.FAILED);
  });

  (pg ? it : it.skip)('on PostgreSQL, fails the claim with it, and the next claim reaps the batch', async () => {
    const { sessionId, batchId } = await abandoned();
    const b = node('node-b');
    // The database drops the connection the reap runs on.
    const reap = b.bulk.reapProcessingBatches.bind(b.bulk);
    jest
      .spyOn(b.bulk, 'reapProcessingBatches')
      .mockImplementationOnce(async (_sessionId: string, _reason: string, manager?: EntityManager) => {
        await manager!.query('SELECT pg_terminate_backend(pg_backend_pid())');
        return 0;
      })
      .mockImplementation(reap);

    await expect(b.ownership.claim(sessionId)).rejects.toThrow();
    expect((await sessions.findOneByOrFail({ id: sessionId })).nodeId).toBe('node-a');
    expect(await statusOf(batchId)).toBe(BatchStatus.PROCESSING);
    await expect(b.ownership.claim(sessionId)).resolves.toBe(true);

    expect(await statusOf(batchId)).toBe(BatchStatus.FAILED);
  });
});
