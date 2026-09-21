import { Client, ClientConfig } from 'pg';
import { DataSource, DataSourceOptions } from 'typeorm';
import { assertDataConnectionUtc, postgresUtcExtra } from './postgres-utc';

// The postgres data connection runs its boot migrations while holding a session-scoped Postgres
// advisory lock, so replicas that boot at the same time serialize instead of racing DDL against
// the shared migrations ledger: the lock holder applies the chain while every other process waits
// inside pg_advisory_lock, then sees a filled ledger and applies nothing. This replaces TypeORM's
// built-in migrationsRun for that connection only (it has no cross-process serialization); the
// sqlite connections keep @nestjs/typeorm's default construction + initialize path unchanged.
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
  createLockClient?: (config: ClientConfig) => AdvisoryLockClient;
}

type PostgresOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/**
 * dataSourceFactory for the 'data' connection. Postgres boot migrations execute here, under the
 * advisory lock, BEFORE the DataSource is handed to any provider — same ordering the built-in
 * migrationsRun gave (it finished inside DataSource.initialize()). Non-postgres options take
 * @nestjs/typeorm's default path: construct only, let the wrapper initialize as before. The
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
  const createLockClient = deps.createLockClient ?? (config => new Client(config));

  if (options?.type !== 'postgres') {
    // useFactory always resolves a full options object; the optional parameter is the library's
    // defensive typing, not a state this connection can actually boot in.
    return createDataSource(options as DataSourceOptions);
  }

  // This connection's migrations run HERE, under the lock — neutralize migrationsRun so the
  // DataSource itself never starts them unsynchronized inside initialize(). The UTC pin is merged in
  // at the same point, because this is the one place the runtime postgres data connection is built
  // (the migration CLI's own data source carries it directly).
  const dataSource = createDataSource({
    ...options,
    migrationsRun: false,
    extra: { ...(options.extra as Record<string, unknown> | undefined), ...postgresUtcExtra() },
  });
  try {
    await dataSource.initialize();
    // Before any migration writes a row: a connection whose UTC pin did not take stores timestamps in
    // one zone and reads them in another, which nothing downstream can detect (see postgres-utc.ts).
    await assertDataConnectionUtc(dataSource);
    const lockClient = createLockClient(lockClientConfig(options));
    try {
      await lockClient.connect();
      await lockClient.query('SELECT pg_advisory_lock($1, $2)', [...POSTGRES_BOOT_MIGRATION_LOCK_KEYS]);
      try {
        // Same transaction mode DataSource.initialize() passes for the built-in migrationsRun.
        await dataSource.runMigrations({ transaction: options.migrationsTransactionMode });
      } finally {
        // Session-scoped lock: even when the unlock call itself fails, end() below tears the
        // session — and with it the lock — down, so no crashed boot can leave it held.
        await lockClient
          .query('SELECT pg_advisory_unlock($1, $2)', [...POSTGRES_BOOT_MIGRATION_LOCK_KEYS])
          .catch(() => undefined);
      }
    } finally {
      await lockClient.end().catch(() => undefined);
    }
  } catch (error) {
    // Same failure handling as DataSource.initialize()'s own migrate step: never leave a
    // half-open DataSource behind (the boot retry loop would stack their pools). The error still
    // fails boot via the factory's rejection.
    await dataSource.destroy().catch(() => undefined);
    throw error;
  }
  return dataSource;
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
    // This client's only statements are pg_advisory_lock/unlock, and statement_timeout applies to
    // ANY command — including the wait inside pg_advisory_lock — so it must be OFF here. A config
    // `statement_timeout: 0` would NOT do it: pg drops falsy values from the startup packet, so
    // disable it via the startup `options` string instead, which also overrides any role- or
    // database-level default the server may carry. (lock_timeout never applies to advisory locks,
    // so it needs no override.)
    options: '-c statement_timeout=0',
  };
}
