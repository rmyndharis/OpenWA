import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConfigService } from '@nestjs/config';
import { load } from 'js-yaml';
import { DataSource } from 'typeorm';
import { ApiKey } from '../modules/auth/entities/api-key.entity';
import { AuditLog } from '../modules/audit/entities/audit-log.entity';
import { CreateAuthAuditTables1779900000000 } from './migrations-main/1779900000000-CreateAuthAuditTables';
import { AddApiKeyAllowedChats1786600000000 } from './migrations-main/1786600000000-AddApiKeyAllowedChats';
import {
  createMainDataSource,
  MainSchemaMismatchError,
  mainConnectionOptions,
  retryMainConnection,
} from './main-connection';

/**
 * The main connection runs its migration chain by default. Existing installs have a main.sqlite
 * built by synchronize and no migrations ledger, so the first boot must adopt that file in place:
 * keep every row, add the columns an older release lacked, record the chain, and leave one index
 * per indexed column. A file whose schema does not match the release must stop the boot.
 */
describe('main connection', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openwa-main-'));
    file = join(dir, 'main.sqlite');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const SHIPPED = readdirSync(join(__dirname, 'migrations-main'))
    .filter(name => name.endsWith('.ts'))
    .map(name => name.replace(/^(\d+)-(\w+)\.ts$/, '$2$1'))
    .sort();

  const config = (values: Record<string, unknown> = {}): ConfigService =>
    ({
      get: (key: string, fallback?: unknown) => (key in values ? values[key] : fallback),
    }) as unknown as ConfigService;

  /** Boot the file the way the app does (default configuration unless synchronize is asked for). */
  const boot = (synchronize = false): Promise<DataSource> =>
    createMainDataSource(
      mainConnectionOptions(
        config({ 'database.database': file, ...(synchronize && { 'database.synchronize': true }) }),
      ),
    );

  /** Open the file with no schema management at all, to arrange or inspect it. */
  const raw = (): Promise<DataSource> =>
    new DataSource({ type: 'better-sqlite3', database: file, entities: [ApiKey, AuditLog] }).initialize();

  const columns = async (ds: DataSource, table: string): Promise<string[]> =>
    (await ds.query<Array<{ name: string }>>(`PRAGMA table_info("${table}")`)).map(c => c.name);

  /** A main.sqlite as an earlier release left it: built by synchronize, with a scoped key and an audit row. */
  const seedSynchronizeBuilt = async (withAllowedChats: boolean): Promise<void> => {
    const ds = await new DataSource({
      type: 'better-sqlite3',
      database: file,
      entities: [ApiKey, AuditLog],
      synchronize: true,
    }).initialize();
    await ds.query(
      `INSERT INTO api_keys (id, name, keyHash, keyPrefix, allowedSessions, allowedChats) ` +
        `VALUES ('k1', 'scoped', 'h1', 'owa_k1', 's1', '123@g.us')`,
    );
    await ds.query(`INSERT INTO audit_logs (id, action) VALUES ('a1', 'api_key_created')`);
    if (!withAllowedChats) await ds.query(`ALTER TABLE api_keys DROP COLUMN allowedChats`);
    await ds.destroy();
  };

  const ledger = async (ds: DataSource): Promise<string[]> =>
    (await ds.query<Array<{ name: string }>>(`SELECT name FROM migrations`)).map(r => r.name).sort();

  /** Indexed columns per table, one entry per index: a duplicate index shows up as a repeated entry. */
  const indexedColumns = async (ds: DataSource, table: string): Promise<string[]> => {
    const indexes = await ds.query<Array<{ name: string; origin: string }>>(`PRAGMA index_list("${table}")`);
    const columns: string[] = [];
    for (const index of indexes.filter(i => i.origin === 'c')) {
      const info = await ds.query<Array<{ name: string }>>(`PRAGMA index_info("${index.name}")`);
      columns.push(info.map(c => c.name).join(','));
    }
    return columns.sort();
  };

  const expectOneIndexPerColumn = async (ds: DataSource): Promise<void> => {
    expect(await indexedColumns(ds, 'api_keys')).toEqual(['keyHash']);
    expect(await indexedColumns(ds, 'audit_logs')).toEqual(['action', 'apiKeyId', 'createdAt', 'sessionId']);
  };

  it('defaults to the migration chain on a fresh file', async () => {
    const ds = await boot();
    try {
      expect(await ledger(ds)).toEqual(SHIPPED);
      await ds
        .getRepository(ApiKey)
        .save({ id: 'k1', name: 'n', keyHash: 'h', keyPrefix: 'p', allowedChats: ['1@g.us'] });
      expect((await ds.getRepository(ApiKey).findOneByOrFail({ id: 'k1' })).allowedChats).toEqual(['1@g.us']);
      await expectOneIndexPerColumn(ds);
    } finally {
      await ds.destroy();
    }
  });

  it('adopts a synchronize-built file from the previous release without losing a row or a scope', async () => {
    await seedSynchronizeBuilt(true);

    const ds = await boot();
    try {
      expect(await ledger(ds)).toEqual(SHIPPED);
      const key = await ds.getRepository(ApiKey).findOneByOrFail({ id: 'k1' });
      expect(key.allowedSessions).toEqual(['s1']);
      expect(key.allowedChats).toEqual(['123@g.us']);
      expect(await ds.getRepository(AuditLog).count()).toBe(1);
      await expectOneIndexPerColumn(ds);
    } finally {
      await ds.destroy();
    }

    // A second boot has nothing left to run.
    const again = await boot();
    try {
      expect(await again.showMigrations()).toBe(false);
    } finally {
      await again.destroy();
    }
  });

  it('keeps an index on every column when an earlier release had synchronize replace the migrated ones', async () => {
    // An earlier release migrated the file, then a synchronize boot swapped the migration-named
    // indexes for generated ones while the ledger kept CreateAuthAuditTables recorded.
    const migrated = await new DataSource({
      type: 'better-sqlite3',
      database: file,
      entities: [ApiKey, AuditLog],
      migrations: [CreateAuthAuditTables1779900000000, AddApiKeyAllowedChats1786600000000],
      migrationsRun: true,
    }).initialize();
    await migrated.destroy();
    const synchronized = await new DataSource({
      type: 'better-sqlite3',
      database: file,
      entities: [ApiKey, AuditLog],
      synchronize: true,
    }).initialize();
    await synchronized.destroy();

    const ds = await boot();
    try {
      expect(await ledger(ds)).toEqual(SHIPPED);
      await expectOneIndexPerColumn(ds);
    } finally {
      await ds.destroy();
    }
  });

  it('adds the chat-scope column to a file from a release that predates it', async () => {
    await seedSynchronizeBuilt(false);

    const ds = await boot();
    try {
      expect(await ledger(ds)).toEqual(SHIPPED);
      const key = await ds.getRepository(ApiKey).findOneByOrFail({ id: 'k1' });
      expect(key.allowedSessions).toEqual(['s1']);
      expect(key.allowedChats).toBeNull();
      await expectOneIndexPerColumn(ds);
    } finally {
      await ds.destroy();
    }
  });

  it('reads MAIN_DATABASE_SYNCHRONIZE=true as synchronize after the chain', async () => {
    expect(mainConnectionOptions(config()).synchronize).toBe(false);
    expect(mainConnectionOptions(config({ 'database.synchronize': true })).synchronize).toBe(true);

    const ds = await boot(true);
    try {
      expect(await ledger(ds)).toEqual(SHIPPED);
      expect(await ds.driver.createSchemaBuilder().log()).toEqual(expect.objectContaining({ upQueries: [] }));
    } finally {
      await ds.destroy();
    }
    const again = await boot(true);
    try {
      expect((await again.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
    } finally {
      await again.destroy();
    }
  });

  it('keeps the connection name Nest resolves the main DataSource by at shutdown', () => {
    expect(mainConnectionOptions(config()).name).toBe('main');
  });

  describe('schema mismatch', () => {
    /** A file this release migrated, then rebuilt by a release older than the chat-scope column. */
    const rebuiltByOlderRelease = async (): Promise<void> => {
      await (await boot()).destroy();
      const ds = await raw();
      await ds.query(
        `INSERT INTO api_keys (id, name, keyHash, keyPrefix, allowedChats) VALUES ('k1', 'n', 'h1', 'p', '123@g.us')`,
      );
      await ds.query(`ALTER TABLE api_keys DROP COLUMN allowedChats`);
      await ds.destroy();
    };

    it.each([false, true])(
      'refuses a file that lost a recorded column instead of re-adding it empty (synchronize=%s)',
      async synchronize => {
        await rebuiltByOlderRelease();

        const failure = boot(synchronize);
        await expect(failure).rejects.toBeInstanceOf(MainSchemaMismatchError);
        await expect(failure).rejects.toThrow(/api_keys\.allowedChats/);
        // Names both causes: a rollback that dropped the values, and a new entity column no migration creates.
        await expect(failure).rejects.toThrow(/restore the file from the backup/);
        await expect(failure).rejects.toThrow(/no migrations-main migration creates yet/);
        // An operator without that backup is pointed at the documented way to re-create the column empty.
        await expect(failure).rejects.toThrow(/without a backup, docs\/05-database-design\.md section 5\.6/);

        const ds = await raw();
        try {
          expect(await columns(ds, 'api_keys')).not.toContain('allowedChats');
        } finally {
          await ds.destroy();
        }
      },
    );

    it.each([false, true])('refuses a file a newer release migrated (synchronize=%s)', async synchronize => {
      await (await boot()).destroy();
      let ds = await raw();
      await ds.query(`INSERT INTO migrations (timestamp, name) VALUES (1799999999999, 'Future1799999999999')`);
      await ds.query(`ALTER TABLE api_keys ADD COLUMN "futureColumn" varchar`);
      await ds.destroy();

      const failure = boot(synchronize);
      await expect(failure).rejects.toBeInstanceOf(MainSchemaMismatchError);
      await expect(failure).rejects.toThrow(/Future1799999999999/);

      ds = await raw();
      try {
        expect(await columns(ds, 'api_keys')).toContain('futureColumn');
      } finally {
        await ds.destroy();
      }
    });

    it.each([false, true])(
      'upgrades a migrated file from before the chat-scope column (synchronize=%s)',
      async synchronize => {
        await (await boot()).destroy();
        let ds = await raw();
        await ds.query(`DELETE FROM migrations WHERE name <> 'CreateAuthAuditTables1779900000000'`);
        await ds.query(`ALTER TABLE api_keys DROP COLUMN allowedChats`);
        await ds.destroy();

        ds = await boot(synchronize);
        try {
          expect(await ledger(ds)).toEqual(SHIPPED);
          expect(await columns(ds, 'api_keys')).toContain('allowedChats');
        } finally {
          await ds.destroy();
        }
      },
    );

    const forgetLostColumn = `DELETE FROM migrations WHERE name = 'AddApiKeyAllowedChats1786600000000'`;

    it('boots again once the lost column is removed from the ledger, re-creating it empty', async () => {
      await rebuiltByOlderRelease();
      let ds = await raw();
      await ds.query(forgetLostColumn);
      await ds.destroy();

      ds = await boot();
      try {
        expect(await ledger(ds)).toEqual(SHIPPED);
        expect((await ds.getRepository(ApiKey).findOneByOrFail({ id: 'k1' })).allowedChats).toBeNull();
      } finally {
        await ds.destroy();
      }
    });

    it('documents that remedy for a source install and for the compose deployment', () => {
      const root = join(__dirname, '..', '..');
      const doc = readFileSync(join(root, 'docs', '05-database-design.md'), 'utf8');
      const remedy = doc.split('\n').find(line => line.includes(forgetLostColumn)) ?? '';
      // The refusal names the configured path, which the remedy must send the operator to.
      expect(remedy).toContain('MAIN_DATABASE_NAME');
      expect(remedy).toContain(`sqlite3 data/main.sqlite "${forgetLostColumn}"`);

      // On compose the file lives in a named volume, so a host path cannot reach it and the
      // stopped (or crash-looping) container cannot be exec'd into: a one-off run of the service can.
      const compose = load(readFileSync(join(root, 'docker-compose.yml'), 'utf8')) as {
        services: Record<string, { volumes?: string[] }>;
      };
      const [service, mount] = Object.entries(compose.services)
        .flatMap(([name, svc]) =>
          (svc.volumes ?? []).filter(v => v.startsWith('openwa-data:')).map(v => [name, v.split(':')[1]]),
        )
        .at(0) ?? ['', ''];
      expect(service).not.toBe('');
      expect(remedy).toContain(`docker compose stop ${service}`);
      expect(remedy).toContain(
        `docker compose run --rm --no-deps ${service} sqlite3 ${mount}/main.sqlite "${forgetLostColumn}"`,
      );
    });

    it('is described in the upgrade guide as running the main chain at every boot', () => {
      const guide = readFileSync(join(__dirname, '..', '..', 'docs', '14-migration-guide.md'), 'utf8').replace(
        /\s+/g,
        ' ',
      );
      expect(guide).toContain('The Main (auth/audit) connection runs its own `migrations-main/` chain at every boot.');
      expect(guide).not.toMatch(/Main \(auth\/audit\) connection defaults to synchronize/);
    });

    it('closes the connection it opened when it refuses', async () => {
      await rebuiltByOlderRelease();
      const destroy = jest.spyOn(DataSource.prototype, 'destroy');
      try {
        await expect(boot()).rejects.toBeInstanceOf(MainSchemaMismatchError);
        expect(destroy).toHaveBeenCalledTimes(1);
      } finally {
        destroy.mockRestore();
      }
    });

    it('fails the boot at once on a mismatch but retries anything else', () => {
      expect(retryMainConnection(new MainSchemaMismatchError('x'))).toBe(false);
      expect(retryMainConnection(new Error('SQLITE_BUSY'))).toBe(true);
    });
  });
});
