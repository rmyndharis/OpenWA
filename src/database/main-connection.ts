import { join } from 'path';
import type { ConfigService } from '@nestjs/config';
import { DataSource, MigrationExecutor, type DataSourceOptions } from 'typeorm';

/**
 * Raised when main.sqlite does not match this release: its migrations ledger records a migration this
 * release does not ship (a newer release has upgraded it), or a column the entities need is missing
 * after every shipped migration ran (an older release has rebuilt the table, or an entity column has no
 * migrations-main migration yet). Booting on
 * would either misread the newer schema or read the missing column as NULL, so boot stops instead.
 */
export class MainSchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MainSchemaMismatchError';
  }
}

/** Retrying cannot fix a schema mismatch, so it fails the boot at once instead of nine times. */
export const retryMainConnection = (err: unknown): boolean => !(err instanceof MainSchemaMismatchError);

/**
 * TypeORM options for the main (auth/audit) connection, which is always a node-local SQLite file.
 *
 * Schema management defaults to the main-owned migration chain (migrations-main), like the data
 * connection. The chain is idempotent, so a file an earlier release built with synchronize is
 * adopted in place on the first boot: existing tables are kept, missing columns are added, and the
 * migrations ledger is written. MAIN_DATABASE_SYNCHRONIZE=true additionally synchronizes after the
 * chain. createMainDataSource runs both, with the schema checks, before any provider reads the file.
 */
export function mainConnectionOptions(
  configService: ConfigService,
): DataSourceOptions & { name: string; toRetry: (err: unknown) => boolean } {
  return {
    // Nest's TypeOrmCoreModule resolves the DataSource to close at shutdown from these options.
    name: 'main',
    type: 'better-sqlite3',
    database: configService.get<string>('database.database', './data/main.sqlite'),
    entities: [
      join(__dirname, '..', 'modules/auth/**/*.entity{.ts,.js}'),
      join(__dirname, '..', 'modules/audit/**/*.entity{.ts,.js}'),
    ],
    // Dedicated migrations dir for the main connection only (must NOT run the data-connection
    // migrations, which target session/webhook/message tables).
    migrations: [join(__dirname, 'migrations-main/*{.ts,.js}')],
    // Read by createMainDataSource, which owns the schema steps (initialize() never runs them).
    synchronize: configService.get<boolean>('database.synchronize', false),
    logging: configService.get<boolean>('database.logging', false),
    toRetry: retryMainConnection,
  };
}

/**
 * dataSourceFactory for the main connection. Order: refuse a ledger from a newer release, run the
 * migration chain (in both modes, so every file carries a ledger), refuse a missing entity column,
 * then synchronize if MAIN_DATABASE_SYNCHRONIZE=true. The missing-column check is what stops a key
 * scope column an older release dropped from coming back as NULL; it runs before synchronize, so a
 * new entity column needs its migrations-main migration even in synchronize mode. A file that was
 * rolled back and upgraded again before any release with this check first booted it has no ledger
 * row for the lost column, and is not detected. Never delete or rename a migrations-main file: a ledger row this
 * release no longer ships reads as a newer release's.
 */
export async function createMainDataSource(options?: DataSourceOptions): Promise<DataSource> {
  // useFactory always resolves a full options object; the optional parameter is the library's typing.
  const opts = options as DataSourceOptions;
  const ds = new DataSource({ ...opts, synchronize: false, migrationsRun: false });
  await ds.initialize();
  try {
    const shipped = new Set(ds.migrations.map(m => m.name));
    const unknown = (await new MigrationExecutor(ds).getExecutedMigrations())
      .map(m => m.name)
      .filter(name => !shipped.has(name));
    if (unknown.length) {
      throw new MainSchemaMismatchError(
        `${String(opts.database)} records migration(s) this release does not ship (${unknown.join(', ')}): a ` +
          'newer OpenWA release has upgraded it. Run that release, or restore the file from the backup taken ' +
          'before the upgrade (docs/14-migration-guide.md, section 14.6).',
      );
    }

    await ds.runMigrations({ transaction: 'all' });

    const missing: string[] = [];
    for (const metadata of ds.entityMetadatas) {
      const rows = await ds.query<Array<{ name: string }>>(`PRAGMA table_info("${metadata.tableName}")`);
      const present = new Set(rows.map(r => r.name));
      for (const column of metadata.columns) {
        if (!present.has(column.databaseName)) missing.push(`${metadata.tableName}.${column.databaseName}`);
      }
    }
    if (missing.length) {
      throw new MainSchemaMismatchError(
        `${String(opts.database)} lacks ${missing.join(', ')} after every shipped migrations-main migration ` +
          'ran. Either an older OpenWA release has rebuilt the table and the values it held are gone (restore ' +
          'the file from the backup taken before the downgrade, docs/14-migration-guide.md, section 14.6; ' +
          'without a backup, docs/05-database-design.md section 5.6 re-creates the column empty, and each ' +
          "key's chat scope must then be re-applied), or " +
          'an entity declares a column that no migrations-main migration creates yet (add one: ' +
          'MAIN_DATABASE_SYNCHRONIZE=true does not add columns the chain lacks).',
      );
    }

    if (opts.synchronize) await ds.synchronize();
    return ds;
  } catch (err) {
    await ds.destroy().catch(() => undefined);
    throw err;
  }
}
