import { Client, ClientConfig } from 'pg';
import { DataSource, DataSourceOptions } from 'typeorm';
import { createLogger } from '../common/services/logger.service';
import { assertDataConnectionUtc, postgresUtcExtra } from './postgres-utc';
import { DeduplicateTerminalWebhookFailures1787200000000 } from './migrations/1787200000000-DeduplicateTerminalWebhookFailures';
import { repairSqliteMessageFts } from './sqlite-message-fts';

const logger = createLogger('PgBootMigrations');

// The postgres data connection runs its boot migrations while holding a session-scoped Postgres
// advisory lock, so replicas that boot at the same time serialize instead of racing DDL against
// the shared migrations ledger: the lock holder applies the chain while every other process waits
// inside pg_advisory_lock, then sees a filled ledger and applies nothing. This replaces TypeORM's
// built-in migrationsRun for that connection only (it has no cross-process serialization); the
// sqlite connection without synchronize keeps @nestjs/typeorm's default construction + initialize
// path; with synchronize (the dev and e2e setup) it is initialized here, the terminal-failure dedupe
// runs, and only then does the schema sync.
//
// Lock key in the two-int4 form — exact in JavaScript (a single bigint key would exceed
// Number.MAX_SAFE_INTEGER). The values are fixed so every process and version agrees:
//   0x4f5741 = "OWA" in ASCII bytes   0x626f6f74 = "boot" in ASCII bytes
export const POSTGRES_BOOT_MIGRATION_LOCK_KEYS: readonly [number, number] = [0x4f5741, 0x626f6f74];

// Just the pg client surface used here; doubles as the mock seam for the unit spec. Function
// properties (not method signatures) — these are callback holders, nothing binds `this`.
export interface AdvisoryLockClient {
  connect: () => Promise<unknown>;
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  end: () => Promise<unknown>;
}

// Test seams over the two constructions this module performs.
export interface BootDataSourceDeps {
  createDataSource?: (options: DataSourceOptions) => DataSource;
  createLockClient?: (config: ClientConfig, onLost: (error: Error) => void) => AdvisoryLockClient;
}

type PostgresOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/**
 * dataSourceFactory for the 'data' connection. Postgres boot migrations execute here, under the
 * advisory lock, BEFORE the DataSource is handed to any provider — same ordering the built-in
 * migrationsRun gave (it finished inside DataSource.initialize()). SQLite with synchronize is
 * initialized here, deduplicates terminal webhook failures and then synchronizes; other non-postgres
 * options take @nestjs/typeorm's default path: construct only, let the wrapper initialize. The
 * wrapper also skips its own initialize() for the postgres branch because the DataSource comes
 * back already initialized, and keeps applying retryAttempts/retryDelay to this whole factory.
 *
 * It is also where the postgres data connection's UTC pin is applied and then verified, for the same
 * reason: this is the only place that connection is constructed at runtime.
 */
export async function createBootDataSource(
  options: DataSourceOptions | undefined,
  deps: BootDataSourceDeps = {},
): Promise<DataSource> {
  const createDataSource = deps.createDataSource ?? (opts => new DataSource(opts));
  const createLockClient = deps.createLockClient ?? createPgLockClient;

  if (options?.type === 'better-sqlite3' && options.synchronize) {
    const dataSource = createDataSource({ ...options, synchronize: false });
    try {
      await dataSource.initialize();
      const runner = dataSource.createQueryRunner();
      try {
        if (await runner.hasTable('webhook_delivery_failures')) {
          await new DeduplicateTerminalWebhookFailures1787200000000().up(runner);
        }
      } finally {
        await runner.release();
      }
      await dataSource.synchronize();
      // synchronize rebuilds `messages` without its rowids, so the index it kept can now name other messages.
      // Never fail boot over the index: if this repair fails, the search provider's own start-up check re-indexes
      // what it finds orphaned, and the next boot repairs the rest.
      await repairSqliteMessageFts(dataSource).catch((error: unknown) =>
        logger.error(`Failed to repair the SQLite message full-text index: ${String(error)}`),
      );
      return dataSource;
    } catch (error) {
      if (dataSource.isInitialized) await dataSource.destroy().catch(() => undefined);
      throw error;
    }
  }

  if (options?.type !== 'postgres') {
    // useFactory always resolves a full options object; the optional parameter is the library's
    // defensive typing, not a state this connection can actually boot in.
    return createDataSource(options as DataSourceOptions);
  }

  // This connection's migrations run HERE, under the lock — neutralize migrationsRun so the
  // DataSource itself never starts them unsynchronized inside initialize(). The UTC pin is merged in
  // at the same point, because this is the one place the runtime postgres data connection is built
  // (the migration CLI's own data source carries it directly).
  //
  // The session settings the pools carry in the config (statement_timeout, and a non-public schema's
  // search_path in the startup `options`) are taken out of the startup packet and set by statement in
  // the same connect hook as the zone: PgBouncer refuses statement_timeout in the startup packet even in
  // session mode, and does not give a startup search_path to every client it hands a server connection.
  const runtimeExtra = (options.extra ?? {}) as ClientConfig;
  const searchPath = options.schema && options.schema !== 'public' ? `${options.schema},public` : undefined;
  const build = (statementTimeoutMs?: number): DataSource => {
    const pool: ClientConfig = { ...runtimeExtra };
    delete pool.statement_timeout;
    if (searchPath) delete pool.options;
    return createDataSource({
      ...options,
      migrationsRun: false,
      extra: { ...pool, ...postgresUtcExtra(pool.connectionTimeoutMillis, { statementTimeoutMs, searchPath }) },
    });
  };

  // statement_timeout bounds live runtime queries, so every statement on a pool that sets it inherits
  // the limit. A backfill or index build over a large table can legitimately run longer, so the chain
  // runs on its own short-lived pool without it (as the migration CLI does), and the runtime DataSource
  // is built only once the chain is applied.
  const migrator = build();
  try {
    await migrator.initialize();
    // Before any migration writes a row: a connection whose UTC pin did not take stores timestamps in
    // one zone and reads them in another, which nothing downstream can detect (see postgres-utc.ts).
    await assertDataConnectionUtc(migrator);
    // A holder whose lock connection drops has lost the lock with it, so another replica can start
    // the same chain. Stop this one where it stands: tearing the migration pool down fails its
    // in-flight statement and rolls the current migration back, and the boot fails so the retry loop
    // reruns it under a new lock. A waiter needs nothing extra: its pending lock query rejects.
    let holding = false;
    let lockLost = false;
    const lockClient = createLockClient(lockClientConfig(options), () => {
      if (!holding) return;
      lockLost = true;
      void migrator.destroy().catch(() => undefined);
    });
    try {
      await lockClient.connect();
      // statement_timeout applies to any command, the wait inside pg_advisory_lock included, so it is
      // turned off for this session, over any role or database default. By statement rather than in the
      // startup packet, which PgBouncer refuses; unlike the setting below, a failure here fails the boot.
      await lockClient.query('SET statement_timeout = 0');
      // The holder sends nothing between lock and unlock, so a role- or database-level
      // idle_session_timeout (PostgreSQL 14+) would end the session, and the boot, mid-chain. Set
      // after connect rather than in the startup options: PostgreSQL 12 and 13 reject an unknown
      // setting there as FATAL, while here the error is harmless and swallowed.
      await lockClient.query('SET idle_session_timeout = 0').catch(() => undefined);
      await lockClient.query('SELECT pg_advisory_lock($1, $2)', [...POSTGRES_BOOT_MIGRATION_LOCK_KEYS]);
      holding = true;
      try {
        // Same transaction mode DataSource.initialize() passes for the built-in migrationsRun.
        await migrator.runMigrations({ transaction: options.migrationsTransactionMode });
        if (lockLost) throw new Error('Boot migration lock connection lost while migrating; retrying the boot');
      } finally {
        holding = false;
        // Session-scoped lock: even when the unlock call itself fails, end() below tears the
        // session — and with it the lock — down, so no crashed boot can leave it held.
        await lockClient
          .query('SELECT pg_advisory_unlock($1, $2)', [...POSTGRES_BOOT_MIGRATION_LOCK_KEYS])
          .catch(() => undefined);
      }
    } finally {
      await lockClient.end().catch(() => undefined);
    }
  } finally {
    // The migration pool never outlives this block: on success the runtime DataSource below replaces
    // it, and on failure a half-open one would stack pools across the boot retry loop. The failure
    // still fails boot via the factory's rejection; a teardown error never masks it.
    await migrator.destroy().catch(() => undefined);
  }

  const dataSource = build(runtimeExtra.statement_timeout || undefined);
  try {
    await dataSource.initialize();
    await assertDataConnectionUtc(dataSource);
  } catch (error) {
    await dataSource.destroy().catch(() => undefined);
    throw error;
  }
  return dataSource;
}

// pg emits 'error' on the client when its socket drops while the client is not ending (a failover,
// pg_terminate_backend, an idle-timeout on the silent wait inside pg_advisory_lock). Unheard, that
// emit throws from the socket handler and exits the process. A waiter's pending lock query rejects on
// its own, so the factory's cleanup and Nest's retry loop take it from there; a holder is stopped by
// onLost, since it lost the lock with the socket.
function createPgLockClient(config: ClientConfig, onLost: (error: Error) => void): AdvisoryLockClient {
  const client = new Client(config);
  client.on('error', (error: Error) => {
    logger.warn(`Boot migration lock connection lost: ${error.message}`);
    onLost(error);
  });
  return client;
}

function lockClientConfig(options: PostgresOptions): ClientConfig {
  const extra = (options.extra ?? {}) as { connectionTimeoutMillis?: number };
  return {
    host: options.host,
    port: options.port,
    user: options.username,
    password: options.password,
    database: options.database,
    // Same ssl shape TypeORM's postgres driver forwards to pg; cast only because the two
    // packages type their TLS options independently.
    ssl: options.ssl as ClientConfig['ssl'],
    // Bound a stuck connect like the pool does (app.module's extra carries the same setting).
    connectionTimeoutMillis: extra.connectionTimeoutMillis ?? 10000,
    // No UTC pin here on purpose: this client only ever calls pg_advisory_lock/unlock, so it neither
    // binds nor reads a timestamp and its session zone cannot reach a column.
    // No startup `options` either: statement_timeout is turned off by a SET after connect (see
    // createBootDataSource), which PgBouncer accepts where it refuses the startup parameter. lock_timeout
    // never applies to advisory locks, so it needs no override.
  };
}
