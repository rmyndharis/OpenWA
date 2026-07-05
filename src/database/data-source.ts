import { DataSource, DataSourceOptions } from 'typeorm';
import * as path from 'path';
import { loadCliEnv } from './load-cli-env';

// Load env with the same precedence as the app (process.env > .env > data/.env.generated), so the
// migration CLI targets the SAME database the dashboard configured — not the default SQLite DB.
loadCliEnv();

const dbType = process.env.DATABASE_TYPE || 'sqlite';

const sourceGlob = (...segments: string[]): string => path.join(__dirname, ...segments).replace(/\\/g, '/');

// Scoped to the DATA-owned modules only (session/webhook/message/template/engine/integration), mirroring
// the runtime data connection (app.module.ts). A broad '**' glob would also sweep in the main-owned
// auth/audit entities and pollute `migration:generate` against the data DB with their DDL.
const dataEntities = [
  sourceGlob('..', 'modules', 'session', '**', '*.entity{.ts,.js}'),
  sourceGlob('..', 'modules', 'webhook', '**', '*.entity{.ts,.js}'),
  sourceGlob('..', 'modules', 'message', '**', '*.entity{.ts,.js}'),
  sourceGlob('..', 'modules', 'template', '**', '*.entity{.ts,.js}'),
  sourceGlob('..', 'engine', '**', '*.entity{.ts,.js}'),
  sourceGlob('..', 'modules', 'integration', '**', '*.entity{.ts,.js}'),
];
const dataMigrations = [sourceGlob('migrations', '*{.ts,.js}')];

// SQLite configuration
const sqliteDataSourceOptions: DataSourceOptions = {
  type: 'sqlite',
  database: process.env.DATABASE_NAME || './data/openwa.sqlite',
  entities: dataEntities,
  migrations: dataMigrations,
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
};

// PostgreSQL configuration.
//
// Exported as plain DataSourceOptions, NOT a DataSource instance: the TypeORM CLI's loadDataSource()
// rejects a data-source file that exports more than one DataSource instance ("must contain only one
// export of DataSource"). Keeping the postgres config as an options object leaves exactly one instance
// export (the default below) so every `migration:*` command resolves it.
export const postgresDataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  username: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME || 'openwa',
  entities: dataEntities,
  migrations: dataMigrations,
  synchronize: false, // Never auto-sync in production
  logging: process.env.DATABASE_LOGGING === 'true',
  ssl:
    process.env.DATABASE_SSL === 'true'
      ? {
          rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
        }
      : false,
  extra: {
    max: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
    // Pool resilience only. NO statement_timeout here: this connection runs migrations, and a
    // long CREATE INDEX / backfill must not be aborted mid-flight.
    idleTimeoutMillis: parseInt(process.env.DATABASE_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS || '10000', 10),
  },
};

// Exactly ONE DataSource instance is exported (the default), selected by DATABASE_TYPE.
export default new DataSource(dbType === 'postgres' ? postgresDataSourceOptions : sqliteDataSourceOptions);
