import { DataSource } from 'typeorm';
import { config } from 'dotenv';

// Load environment variables
config();

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
const postgresDataSource = new DataSource({
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
  },
});

// Export the appropriate data source based on DATABASE_TYPE
export default dbType === 'postgres' ? postgresDataSource : sqliteDataSource;
