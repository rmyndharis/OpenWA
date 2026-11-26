import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { LoggerService } from '../common/services/logger.service';
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

  // NORMAL is corruption-safe only in WAL: under the rollback journal SQLite kept, FULL is needed.
  it('warns once with the mode in effect when SQLite stays out of WAL, and keeps synchronous = FULL', () => {
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const pragma = jest.fn((source: string) => (source === 'journal_mode = WAL' ? 'delete' : undefined));
      createSqlitePrepareDatabase(dbPath, 'WAL')({ pragma });

      const walWarnings = warn.mock.calls.filter(([message]) => String(message).includes('WAL'));
      expect(walWarnings).toHaveLength(1);
      expect(String(walWarnings[0][0])).toContain('"delete"');
      expect(String(walWarnings[0][0])).toContain('SQLITE_JOURNAL_MODE=DELETE');
      expect(pragma).toHaveBeenCalledWith('synchronous = FULL');
      expect(pragma).not.toHaveBeenCalledWith('synchronous = NORMAL');

      warn.mockClear();
      const inWal = jest.fn(() => 'wal');
      createSqlitePrepareDatabase(dbPath, 'WAL')({ pragma: inWal });
      expect(warn).not.toHaveBeenCalled();
      expect(inWal).toHaveBeenCalledWith('synchronous = NORMAL');
    } finally {
      warn.mockRestore();
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

// A data export holds a read transaction for as long as its download runs, and the write-ahead log
// cannot start over past it, so it grows by everything written meanwhile and kept that size afterwards.
describe('the write-ahead log of a file database', () => {
  const MiB = 1024 * 1024;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owa-sqlite-wal-size-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is held to 64 MiB once it starts over', () => {
    const pragma = jest.fn();
    createSqlitePrepareDatabase(join(dir, 'test.sqlite'), 'WAL')({ pragma });
    expect(pragma).toHaveBeenCalledWith('journal_size_limit = 67108864');
  });

  it('comes back to at most 64 MiB after a long reader has left and two more commits', async () => {
    const dbPath = join(dir, 'test.sqlite');
    const ds = new DataSource({
      type: 'better-sqlite3',
      database: dbPath,
      prepareDatabase: createSqlitePrepareDatabase(dbPath, 'WAL'),
    });
    await ds.initialize();
    type Connection = {
      exec(sql: string): unknown;
      prepare(sql: string): { run(...params: unknown[]): unknown; all(): unknown[] };
      close(): void;
    };
    const writer = (ds.driver as unknown as { databaseConnection: Connection }).databaseConnection;
    const walBytes = (): number => statSync(`${dbPath}-wal`).size;
    try {
      writer.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, b BLOB); CREATE TABLE rows (v TEXT)');
      writer.exec('INSERT INTO blobs (id, b) VALUES (1, zeroblob(1048576))');
      // As an export holds its snapshot: a read-only connection with a read transaction open.
      const reader = new (writer.constructor as new (file: string, options: object) => Connection)(dbPath, {
        readonly: true,
        fileMustExist: true,
      });
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) FROM blobs').all();
      const rewrite = writer.prepare('UPDATE blobs SET b = randomblob(1048576) WHERE id = 1');
      for (let i = 0; i < 96; i++) rewrite.run();
      expect(walBytes()).toBeGreaterThan(90 * MiB);

      reader.close();
      const insert = writer.prepare('INSERT INTO rows (v) VALUES (?)');
      insert.run('first');
      insert.run('second');

      expect(walBytes()).toBeLessThanOrEqual(64 * MiB);
    } finally {
      await ds.destroy();
    }
  });
});
