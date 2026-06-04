/**
 * Single source of truth for database connection parameters.
 *
 * Both the NestJS runtime config (`configuration.ts`, consumed by the TypeORM
 * factories in `app.module.ts`) and the standalone CLI DataSource
 * (`database/data-source.ts`, used by the `migration:*` scripts) derive their
 * connection settings from here, so the two can no longer drift.
 *
 * Connection params only — context-specific knobs (entity scope, `synchronize`
 * defaults, `migrationsRun`) stay with each caller, since the runtime and the
 * migration CLI legitimately differ on those.
 */
export type DataDbType = 'sqlite' | 'postgres';

export interface DataDbConfig {
  type: DataDbType;
  /** SQLite file path, or the PostgreSQL database name. */
  database: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  synchronize: boolean;
  logging: boolean;
  poolSize: number;
  ssl: boolean;
  sslRejectUnauthorized: boolean;
}

/** Pluggable "data" datasource (user data: sessions, webhooks, messages). */
export function readDataDbConfig(): DataDbConfig {
  const type: DataDbType = process.env.DATABASE_TYPE === 'postgres' ? 'postgres' : 'sqlite';
  return {
    type,
    // Type-aware default: a PostgreSQL database name vs a SQLite file path.
    // (Previously the runtime config defaulted this to the SQLite path even for
    // Postgres, while the CLI defaulted to 'openwa' — this unifies on 'openwa'.)
    database: process.env.DATABASE_NAME || (type === 'postgres' ? 'openwa' : './data/openwa.sqlite'),
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    synchronize: process.env.DATABASE_SYNCHRONIZE === 'true',
    logging: process.env.DATABASE_LOGGING === 'true',
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
    ssl: process.env.DATABASE_SSL === 'true',
    sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
}

export interface MainDbConfig {
  type: 'sqlite';
  database: string;
  synchronize: boolean;
  logging: boolean;
}

/** Internal "main" datasource (auth + audit) — always embedded SQLite. */
export function readMainDbConfig(): MainDbConfig {
  return {
    type: 'sqlite',
    database: './data/main.sqlite',
    synchronize: true,
    logging: process.env.DATABASE_LOGGING === 'true',
  };
}
