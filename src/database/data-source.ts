import { DataSource } from 'typeorm';
import { config } from 'dotenv';

// Load environment variables
config();

const dbType = process.env.DATABASE_TYPE || 'sqlite';

// SQLite configuration (better-sqlite3 driver; node-sqlite3 driver removed in typeorm 1.0)
const sqliteDataSource = new DataSource({
  type: 'better-sqlite3',
  database: process.env.DATABASE_NAME || './data/openwa.sqlite',
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
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
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
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
