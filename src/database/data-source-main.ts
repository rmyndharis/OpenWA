import { DataSource } from 'typeorm';
import { config } from 'dotenv';

// Load environment variables (mirrors data-source.ts).
config();

/**
 * Standalone TypeORM CLI DataSource for the MAIN connection (auth + audit).
 *
 * The app runs the main connection as a separate, ALWAYS-SQLite connection (app.module.ts), distinct
 * from the pluggable data connection. The default data-source.ts CLI only manages the data
 * connection's migrations, so without this the CLI could not run/generate the main-owned migrations
 * (migrations-main) — which matters the moment boot auto-migration is turned off
 * (MAIN_DATABASE_SYNCHRONIZE=false), where the schema must be managed via the CLI instead.
 *
 * Mirrors the runtime main connection exactly: SQLite at ./data/main.sqlite, auth/audit entities,
 * migrations-main. synchronize is always false here — the CLI manages schema via migrations.
 *
 * Usage: `npm run migration:run:main` (dev) / `migration:run:main:prod` (compiled).
 */
const mainDataSource = new DataSource({
  type: 'sqlite',
  // Hardcoded to match the runtime main path (configuration.ts), so the CLI and the app never target
  // different main databases.
  database: './data/main.sqlite',
  entities: [__dirname + '/../modules/auth/**/*.entity{.ts,.js}', __dirname + '/../modules/audit/**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations-main/*{.ts,.js}'],
  synchronize: false,
  logging: process.env.DATABASE_LOGGING === 'true',
});

export default mainDataSource;
