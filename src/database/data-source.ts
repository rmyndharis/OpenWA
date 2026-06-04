import { DataSource, DataSourceOptions } from 'typeorm';
import { config } from 'dotenv';
import { readDataDbConfig } from '../config/database.config';

// Load environment variables before reading DB config.
config();

const db = readDataDbConfig();

// Entity/migration scope is CLI-specific (schema diffing for the "data" DB);
// connection params come from the shared single source. synchronize is always
// false here — the migration CLI must never auto-sync.
const entities = [__dirname + '/../**/*.entity{.ts,.js}'];
const migrations = [__dirname + '/migrations/*{.ts,.js}'];

const options: DataSourceOptions =
  db.type === 'postgres'
    ? {
        type: 'postgres',
        host: db.host,
        port: db.port,
        username: db.username,
        password: db.password,
        database: db.database,
        entities,
        migrations,
        synchronize: false,
        logging: db.logging,
        ssl: db.ssl ? { rejectUnauthorized: db.sslRejectUnauthorized } : false,
        extra: { max: db.poolSize },
      }
    : {
        // better-sqlite3 driver (node-sqlite3 driver removed in typeorm 1.0)
        type: 'better-sqlite3',
        database: db.database,
        entities,
        migrations,
        synchronize: false,
        logging: db.logging,
      };

export default new DataSource(options);
