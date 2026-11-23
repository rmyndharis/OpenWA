import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { createSqlitePrepareDatabase, resolveSqliteJournalMode } from './sqlite-pragmas';

const modeOf = (filePath: string): number => statSync(filePath).mode & 0o777;

describe('resolveSqliteJournalMode', () => {
  it('defaults to WAL when unset or blank', () => {
    expect(resolveSqliteJournalMode(undefined)).toBe('WAL');
    expect(resolveSqliteJournalMode('')).toBe('WAL');
    expect(resolveSqliteJournalMode('   ')).toBe('WAL');
  });

  it('honors explicit WAL and DELETE modes', () => {
    expect(resolveSqliteJournalMode('WAL')).toBe('WAL');
    expect(resolveSqliteJournalMode('DELETE')).toBe('DELETE');
  });
});

describe('createSqlitePrepareDatabase', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owa-sqlite-pragmas-'));
    dbPath = join(dir, 'test.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tightens the database file to 0600 before enabling WAL so sidecars inherit 0600, and sets synchronous=NORMAL', async () => {
    const ds = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      prepareDatabase: createSqlitePrepareDatabase(dbPath, 'WAL'),
    });
    await ds.initialize();
    try {
      await ds.query('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
      await ds.query("INSERT INTO items (name) VALUES ('hello')");

      const [{ journal_mode: mode }] = await ds.query<Array<{ journal_mode: string }>>('PRAGMA journal_mode');
      const [{ synchronous }] = await ds.query<Array<{ synchronous: number }>>('PRAGMA synchronous');
      expect(mode.toLowerCase()).toBe('wal');
      expect(synchronous).toBe(1);

      expect(modeOf(dbPath)).toBe(0o600);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    } finally {
      await ds.destroy();
    }
  });

  it('explicitly switches an existing WAL database back to DELETE mode with synchronous=FULL', async () => {
    const walDs = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      prepareDatabase: createSqlitePrepareDatabase(dbPath, 'WAL'),
    });
    await walDs.initialize();
    await walDs.query('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    await walDs.query("INSERT INTO items (name) VALUES ('from-wal')");
    await walDs.destroy();

    // Even if file permissions drifted before reopen, DELETE mode tightens and switches journal mode.
    chmodSync(dbPath, 0o644);
    const deleteDs = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      prepareDatabase: createSqlitePrepareDatabase(dbPath, 'DELETE'),
    });
    await deleteDs.initialize();
    try {
      const [{ journal_mode: mode }] = await deleteDs.query<Array<{ journal_mode: string }>>('PRAGMA journal_mode');
      const [{ synchronous }] = await deleteDs.query<Array<{ synchronous: number }>>('PRAGMA synchronous');
      expect(mode.toLowerCase()).toBe('delete');
      expect(synchronous).toBe(2);
      expect(modeOf(dbPath)).toBe(0o600);
      const rows = await deleteDs.query<Array<{ name: string }>>('SELECT name FROM items');
      expect(rows).toEqual([{ name: 'from-wal' }]);
    } finally {
      await deleteDs.destroy();
    }
  });

  it('skips :memory: databases without invoking pragmas or filesystem chmod', () => {
    const pragma = jest.fn();
    const prepare = createSqlitePrepareDatabase(':memory:', 'WAL');
    prepare({ pragma });
    expect(pragma).not.toHaveBeenCalled();
  });
});

describe('TypeORM CLI data-source SQLITE_JOURNAL_MODE validation', () => {
  const ORIGINAL_MODE = process.env.SQLITE_JOURNAL_MODE;

  afterEach(() => {
    if (ORIGINAL_MODE === undefined) delete process.env.SQLITE_JOURNAL_MODE;
    else process.env.SQLITE_JOURNAL_MODE = ORIGINAL_MODE;
  });

  it.each(['delete', 'wal', ' WAL ', 'TRUNCATE'])(
    'rejects invalid SQLITE_JOURNAL_MODE=%j in both data-source.ts and data-source-main.ts',
    badValue => {
      process.env.SQLITE_JOURNAL_MODE = badValue;
      expect(() => {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('./data-source');
        });
      }).toThrow(/SQLITE_JOURNAL_MODE/);
      expect(() => {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('./data-source-main');
        });
      }).toThrow(/SQLITE_JOURNAL_MODE/);
    },
  );
});
