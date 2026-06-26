import { DataSource } from 'typeorm';
import { loadCliEnv } from './load-cli-env';

// Load env with the same precedence as the app (process.env > .env > data/.env.generated), so the
// migration CLI targets the SAME database the dashboard configured — not the default SQLite DB.
loadCliEnv();

const dbType = process.env.DATABASE_TYPE || 'sqlite';

// SQLite configuration
const sqliteDataSource = new DataSource({
  type: 'sqlite',
  database: process.env.DATABASE_NAME || './data/openwa.sqlite',
  // Scoped to the DATA-owned modules only (session/webhook/message/template/engine), mirroring the
  // runtime data connection (app.module.ts). A broad '**' glob would also sweep in the main-owned
  // auth/audit entities and pollute `migration:generate` against the data DB with their DDL.
  entities: [
    __dirname + '/../modules/session/**/*.entity{.ts,.js}',
    __dirname + '/../modules/webhook/**/*.entity{.ts,.js}',
    __dirname + '/../modules/message/**/*.entity{.ts,.js}',
    __dirname + '/../modules/template/**/*.entity{.ts,.js}',
    __dirname + '/../engine/**/*.entity{.ts,.js}',
  ],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
});

// PostgreSQL configuration
export const postgresDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432', 10),
  username: process.env.DATABASE_USERNAME,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME || 'openwa',
  // Scoped to the DATA-owned modules only (session/webhook/message/template/engine), mirroring the
  // runtime data connection (app.module.ts). A broad '**' glob would also sweep in the main-owned
  // auth/audit entities and pollute `migration:generate` against the data DB with their DDL.
  entities: [
    __dirname + '/../modules/session/**/*.entity{.ts,.js}',
    __dirname + '/../modules/webhook/**/*.entity{.ts,.js}',
    __dirname + '/../modules/message/**/*.entity{.ts,.js}',
    __dirname + '/../modules/template/**/*.entity{.ts,.js}',
    __dirname + '/../engine/**/*.entity{.ts,.js}',
  ],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
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
});

// Export the appropriate data source based on DATABASE_TYPE
export default dbType === 'postgres' ? postgresDataSource : sqliteDataSource;
