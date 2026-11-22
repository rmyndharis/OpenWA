// The fs namespace object is frozen, so chmodSync cannot be spyOn'd; wrap it in a mock that
// delegates to the real implementation unless a test overrides one call.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, chmodSync: jest.fn(actual.chmodSync) };
});

import * as fs from 'fs';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SqlitePermissionsBoot, tightenSqliteFilePermissions } from './sqlite-file-permissions';
import { createSqlitePrepareDatabase } from './sqlite-pragmas';

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('tightenSqliteFilePermissions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owa-sqlite-perm-'));
  });
  afterEach(() => {
    chmodSync(dir, 0o755); // a 0o500 test dir must still be cleanable
    rmSync(dir, { recursive: true, force: true });
  });

  it('tightens an existing database file and its WAL/journal sidecars to owner-only', () => {
    const db = join(dir, 'openwa.sqlite');
    writeFileSync(db, '', { mode: 0o644 });
    writeFileSync(`${db}-wal`, '', { mode: 0o644 });
    writeFileSync(`${db}-shm`, '', { mode: 0o644 });
    writeFileSync(`${db}-journal`, '', { mode: 0o644 });

    const tightened = tightenSqliteFilePermissions([db], () => undefined);

    expect(tightened).toEqual([db, `${db}-wal`, `${db}-shm`, `${db}-journal`]);
    for (const path of tightened) expect(modeOf(path)).toBe(0o600);
  });

  it('skips files that do not exist without touching anything', () => {
    expect(tightenSqliteFilePermissions([join(dir, 'absent.sqlite')], () => undefined)).toEqual([]);
    expect(existsSync(join(dir, 'absent.sqlite'))).toBe(false);
  });

  it('is best-effort: an untightenable file warns and does not throw', () => {
    const db = join(dir, 'main.sqlite');
    writeFileSync(db, '', { mode: 0o644 });
    (fs.chmodSync as jest.Mock).mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted');
    });

    const warnings: string[] = [];
    expect(() => tightenSqliteFilePermissions([db], m => warnings.push(m))).not.toThrow();

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('main.sqlite');
    expect(warnings[0]).toContain('EPERM');
  });
});

describe('SqlitePermissionsBoot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owa-sqlite-boot-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const configReturning = (values: Record<string, string>): ConfigService =>
    ({ get: (key: string, defaultValue?: string) => values[key] ?? defaultValue }) as unknown as ConfigService;

  it('tightens both bundled files when the data connection is SQLite', () => {
    const main = join(dir, 'main.sqlite');
    const data = join(dir, 'openwa.sqlite');
    writeFileSync(main, '', { mode: 0o644 });
    writeFileSync(data, '', { mode: 0o644 });
    const boot = new SqlitePermissionsBoot(
      configReturning({ 'database.database': main, 'dataDatabase.type': 'sqlite', 'dataDatabase.database': data }),
    );

    boot.onApplicationBootstrap();

    expect(modeOf(main)).toBe(0o600);
    expect(modeOf(data)).toBe(0o600);
  });

  it('skips the data file when the data connection is Postgres (no local file to tighten)', () => {
    const main = join(dir, 'main.sqlite');
    const data = join(dir, 'should-not-be-touched.sqlite');
    writeFileSync(main, '', { mode: 0o644 });
    writeFileSync(data, '', { mode: 0o644 });
    const boot = new SqlitePermissionsBoot(
      configReturning({ 'database.database': main, 'dataDatabase.type': 'postgres', 'dataDatabase.database': data }),
    );

    boot.onApplicationBootstrap();

    expect(modeOf(main)).toBe(0o600);
    expect(modeOf(data)).toBe(0o644);
  });

  it('falls back to the documented default paths when config supplies none', () => {
    const boot = new SqlitePermissionsBoot(configReturning({}));
    // Must not throw even when neither default file exists (e.g. a fresh checkout before first boot).
    expect(() => boot.onApplicationBootstrap()).not.toThrow();
  });

  describe('beforeApplicationShutdown WAL checkpoint', () => {
    const fakeDataSource = (opts: { type: string; database?: string; isInitialized?: boolean; query?: jest.Mock }) =>
      ({
        isInitialized: opts.isInitialized ?? true,
        options: { type: opts.type, database: opts.database },
        query: opts.query ?? jest.fn().mockResolvedValue([]),
      }) as unknown;

    it('runs PRAGMA wal_checkpoint(TRUNCATE) on initialized file-backed SQLite DataSources in WAL mode', async () => {
      const mainQuery = jest.fn().mockResolvedValue([]);
      const dataQuery = jest.fn().mockResolvedValue([]);
      const mainDs = fakeDataSource({
        type: 'better-sqlite3',
        database: join(dir, 'main.sqlite'),
        query: mainQuery,
      });
      const dataDs = fakeDataSource({
        type: 'better-sqlite3',
        database: join(dir, 'openwa.sqlite'),
        query: dataQuery,
      });
      const boot = new SqlitePermissionsBoot(
        configReturning({ 'database.journalMode': 'WAL' }),
        mainDs as never,
        dataDs as never,
      );

      await (boot as unknown as { beforeApplicationShutdown: () => Promise<void> }).beforeApplicationShutdown();

      expect(mainQuery).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
      expect(dataQuery).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
    });

    it('skips checkpoint when journalMode is DELETE, for Postgres, for :memory:, or when uninitialized', async () => {
      const mainQuery = jest.fn().mockResolvedValue([]);
      const dataQuery = jest.fn().mockResolvedValue([]);

      const deleteBoot = new SqlitePermissionsBoot(
        configReturning({ 'database.journalMode': 'DELETE' }),
        fakeDataSource({ type: 'better-sqlite3', database: join(dir, 'main.sqlite'), query: mainQuery }) as never,
        fakeDataSource({ type: 'better-sqlite3', database: join(dir, 'openwa.sqlite'), query: dataQuery }) as never,
      );
      await (deleteBoot as unknown as { beforeApplicationShutdown: () => Promise<void> }).beforeApplicationShutdown();
      expect(mainQuery).not.toHaveBeenCalled();
      expect(dataQuery).not.toHaveBeenCalled();

      const pgAndMemBoot = new SqlitePermissionsBoot(
        configReturning({ 'database.journalMode': 'WAL' }),
        fakeDataSource({ type: 'better-sqlite3', database: ':memory:', query: mainQuery }) as never,
        fakeDataSource({ type: 'postgres', database: 'openwa', query: dataQuery }) as never,
      );
      await (pgAndMemBoot as unknown as { beforeApplicationShutdown: () => Promise<void> }).beforeApplicationShutdown();
      expect(mainQuery).not.toHaveBeenCalled();
      expect(dataQuery).not.toHaveBeenCalled();

      const uninitBoot = new SqlitePermissionsBoot(
        configReturning({ 'database.journalMode': 'WAL' }),
        fakeDataSource({
          type: 'better-sqlite3',
          database: join(dir, 'main.sqlite'),
          isInitialized: false,
          query: mainQuery,
        }) as never,
      );
      await (uninitBoot as unknown as { beforeApplicationShutdown: () => Promise<void> }).beforeApplicationShutdown();
      expect(mainQuery).not.toHaveBeenCalled();
    });

    it('is best-effort: swallows checkpoint errors and still checkpoints remaining connections', async () => {
      const mainQuery = jest.fn().mockRejectedValue(new Error('SQLITE_BUSY'));
      const dataQuery = jest.fn().mockResolvedValue([]);
      const boot = new SqlitePermissionsBoot(
        configReturning({ 'database.journalMode': 'WAL' }),
        fakeDataSource({ type: 'better-sqlite3', database: join(dir, 'main.sqlite'), query: mainQuery }) as never,
        fakeDataSource({ type: 'better-sqlite3', database: join(dir, 'openwa.sqlite'), query: dataQuery }) as never,
      );

      await expect(
        (boot as unknown as { beforeApplicationShutdown: () => Promise<void> }).beforeApplicationShutdown(),
      ).resolves.toBeUndefined();
      expect(dataQuery).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
    });

    it('warns when PRAGMA wal_checkpoint(TRUNCATE) reports busy or incomplete checkpoint, and stays silent when complete', async () => {
      const busyQuery = jest.fn().mockResolvedValue([{ busy: 1, log: 5, checkpointed: 2 }]);
      const partialQuery = jest.fn().mockResolvedValue([{ busy: 0, log: 4, checkpointed: 1 }]);
      const bootIncomplete = new SqlitePermissionsBoot(
        configReturning({ 'database.journalMode': 'WAL' }),
        fakeDataSource({ type: 'better-sqlite3', database: join(dir, 'main.sqlite'), query: busyQuery }) as never,
        fakeDataSource({ type: 'better-sqlite3', database: join(dir, 'openwa.sqlite'), query: partialQuery }) as never,
      );
      const warnSpy = jest
        .spyOn((bootIncomplete as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);

      await bootIncomplete.beforeApplicationShutdown();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('main');
      expect(warnSpy.mock.calls[0]?.[0]).toContain('busy=1');
      expect(warnSpy.mock.calls[1]?.[0]).toContain('data');
      expect(warnSpy.mock.calls[1]?.[0]).toContain('checkpointed=1');

      const okQuery = jest.fn().mockResolvedValue([{ busy: 0, log: 3, checkpointed: 3 }]);
      const bootOk = new SqlitePermissionsBoot(
        configReturning({ 'database.journalMode': 'WAL' }),
        fakeDataSource({ type: 'better-sqlite3', database: join(dir, 'main.sqlite'), query: okQuery }) as never,
      );
      const okWarnSpy = jest
        .spyOn((bootOk as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      await bootOk.beforeApplicationShutdown();
      expect(okWarnSpy).not.toHaveBeenCalled();
    });

    it('truncates a live WAL sidecar to zero bytes on a real better-sqlite3 DataSource', async () => {
      const dbPath = join(dir, 'live-wal.sqlite');
      const ds = new DataSource({
        type: 'better-sqlite3',
        database: dbPath,
        prepareDatabase: createSqlitePrepareDatabase(dbPath, 'WAL'),
      });
      await ds.initialize();
      try {
        await ds.query('PRAGMA wal_autocheckpoint = 0');
        await ds.query('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
        await ds.query("INSERT INTO notes (body) VALUES ('uncheckpointed')");
        expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

        const boot = new SqlitePermissionsBoot(configReturning({ 'database.journalMode': 'WAL' }), ds);
        await boot.beforeApplicationShutdown();

        expect(statSync(`${dbPath}-wal`).size).toBe(0);
      } finally {
        await ds.destroy();
      }
    });
  });
});
