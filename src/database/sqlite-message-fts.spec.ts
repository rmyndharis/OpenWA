import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, QueryRunner, TableColumn } from 'typeorm';
import { Message, MessageDirection } from '../modules/message/entities/message.entity';
import { Session } from '../modules/session/entities/session.entity';
import { AddMessagesFts1782400000000 } from './migrations/1782400000000-AddMessagesFts';
import { RepairSqliteMessageFts1791600000000 } from './migrations/1791600000000-RepairSqliteMessageFts';
import { createBootDataSource } from './pg-boot-migrations';
import { repairSqliteMessageFts } from './sqlite-message-fts';

const row = (id: string, body: string | null) => ({
  id,
  sessionId: 's',
  chatId: 'c',
  from: 'sender',
  to: 'recipient',
  body: body as string,
  type: 'text',
  direction: MessageDirection.OUTGOING,
});
const matches = async (ds: DataSource, term: string): Promise<string[]> =>
  (
    await ds.query<Array<{ id: string }>>(
      `SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?`,
      [term],
    )
  )
    .map(message => message.id)
    .sort();
const integrity = (ds: DataSource) =>
  ds.query(`INSERT INTO "messages_fts"("messages_fts", "rank") VALUES ('integrity-check', 1)`);

describe('SQLite message full-text repair', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    }).initialize();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await ds.destroy();
  });

  const migrate = async (migration: { up(runner: QueryRunner): Promise<void> }) => {
    const runner = ds.createQueryRunner();
    try {
      await runner.startTransaction();
      await migration.up(runner);
      await runner.commitTransaction();
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  };
  /** The 1782400000000 state: rows that predate the index, `lead` first, and a NULL-body row the backfill skips. */
  const legacy = async (tail: readonly (string | null)[]) => {
    await ds
      .getRepository(Message)
      .insert([
        row('lead', 'discarded'),
        row('alpha', 'alpha survivor'),
        ...tail.map((body, index) => row(`tail-${index}`, body)),
      ]);
    await migrate(new AddMessagesFts1782400000000());
  };
  /** A table rebuild: it copies the rows without their rowid, so the survivors of a deleted row move up. */
  const rebuild = async () => {
    await ds.getRepository(Message).delete({ id: 'lead' });
    const runner = ds.createQueryRunner();
    try {
      await runner.addColumn('messages', new TableColumn({ name: 'rebuilt', type: 'text', isNullable: true }));
    } finally {
      await runner.release();
    }
    const rows = await ds.query<Array<{ id: string; rid: number }>>(
      'SELECT id, rowid AS rid FROM messages ORDER BY rowid',
    );
    expect(rows[0]).toEqual({ id: 'alpha', rid: 1 });
  };

  it.each([
    ['one trailing NULL', [null]],
    ['several trailing NULLs', [null, null, null]],
    ['trailing empty body', ['']],
    ['NULL then empty body', [null, '']],
    ['nonempty tail', ['bravo tail']],
  ] as const)('repairs rebuilt row identities with %s', async (_name, tail) => {
    await legacy(tail);
    expect(await matches(ds, 'alpha')).toEqual(['alpha']);
    await rebuild();
    await repairSqliteMessageFts(ds);
    expect(await matches(ds, 'alpha')).toEqual(['alpha']);
    await expect(integrity(ds)).resolves.toBeDefined();
  });

  it('repairs the index a second backfill doubled', async () => {
    await ds.getRepository(Message).insert([row('alpha', 'alpha one'), row('bravo', 'bravo two')]);
    await migrate(new AddMessagesFts1782400000000());
    // A synchronize-built index adopted by the migration chain meets the backfill a second time.
    await ds.query(`INSERT INTO "messages_fts"("rowid", "body") SELECT "rowid", "body" FROM "messages"`);
    await expect(integrity(ds)).rejects.toMatchObject({ driverError: { code: 'SQLITE_CORRUPT_VTAB' } });

    await repairSqliteMessageFts(ds);

    await expect(integrity(ds)).resolves.toBeDefined();
    expect(await matches(ds, 'alpha')).toEqual(['alpha']);
  });

  it('repairs a legacy NULL-body document through the migration', async () => {
    await legacy([null]);
    await expect(integrity(ds)).rejects.toMatchObject({ driverError: { code: 'SQLITE_CORRUPT_VTAB' } });

    await migrate(new RepairSqliteMessageFts1791600000000());

    await expect(integrity(ds)).resolves.toBeDefined();
    await ds.getRepository(Message).update({ id: 'tail-0' }, { body: 'edited nullable' });
    expect(await matches(ds, 'edited')).toEqual(['tail-0']);
    await ds.getRepository(Message).delete({ id: 'tail-0' });
    expect(await matches(ds, 'edited')).toEqual([]);
  });

  it('leaves a healthy index alone', async () => {
    await legacy([null]);
    await repairSqliteMessageFts(ds);
    const query = jest.spyOn(ds, 'query');
    await repairSqliteMessageFts(ds);
    expect(query.mock.calls.filter(([sql]) => sql.includes("VALUES ('rebuild')"))).toEqual([]);
    expect(await matches(ds, 'alpha')).toEqual(['alpha']);
  });

  it('does nothing when the full-text table is absent', async () => {
    await migrate(new RepairSqliteMessageFts1791600000000());
    await repairSqliteMessageFts(ds);
    expect(await ds.query("SELECT name FROM sqlite_master WHERE name='messages_fts'")).toEqual([]);
  });

  it('does nothing on PostgreSQL', async () => {
    const query = jest.fn();
    const runner = { dataSource: { options: { type: 'postgres' } }, query } as unknown as QueryRunner;
    await new RepairSqliteMessageFts1791600000000().up(runner);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('SQLite message full-text repair failures', () => {
  it.each(['SQLITE_BUSY', 'SQLITE_IOERR', 'SQLITE_ERROR', 'SQLITE_CORRUPT', undefined])(
    'propagates an unrelated %s error without rebuilding',
    async code => {
      const failure = Object.assign(new Error('database disk image is malformed'), { code });
      const database = {
        query: jest
          .fn()
          .mockResolvedValueOnce([{ name: 'messages_fts' }])
          .mockRejectedValueOnce(failure),
      };
      await expect(repairSqliteMessageFts(database)).rejects.toBe(failure);
      expect(database.query).toHaveBeenCalledTimes(2);
    },
  );

  it('propagates a rebuild failure', async () => {
    const mismatch = { driverError: { code: 'SQLITE_CORRUPT_VTAB' } };
    const failure = Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' });
    const database = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ name: 'messages_fts' }])
        .mockRejectedValueOnce(mismatch)
        .mockRejectedValueOnce(failure),
    };
    await expect(repairSqliteMessageFts(database)).rejects.toBe(failure);
    expect(database.query).toHaveBeenCalledTimes(3);
  });
});

describe('SQLite boot with synchronize', () => {
  it('still boots when the repair itself fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openwa-fts-sync-'));
    const options = {
      type: 'better-sqlite3' as const,
      database: join(directory, 'data.sqlite'),
      entities: [Session, Message],
      synchronize: true,
    };
    let ds: DataSource | undefined;
    try {
      ds = await new DataSource(options).initialize();
      const runner = ds.createQueryRunner();
      try {
        await new AddMessagesFts1782400000000().up(runner);
      } finally {
        await runner.release();
      }
      await ds.destroy();
      ds = await createBootDataSource(options, {
        createDataSource: built => {
          const source = new DataSource(built);
          const query = source.query.bind(source);
          jest.spyOn(source, 'query').mockImplementation(async (sql, ...parameters) => {
            if (sql.includes('integrity-check'))
              throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
            return query(sql, ...parameters);
          });
          return source;
        },
      });
      expect(ds.isInitialized).toBe(true);
    } finally {
      if (ds?.isInitialized) await ds.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('repairs the kept index after synchronize (table rebuild=%s)', async rebuilt => {
    const directory = await mkdtemp(join(tmpdir(), 'openwa-fts-sync-'));
    const options = {
      type: 'better-sqlite3' as const,
      database: join(directory, 'data.sqlite'),
      entities: [Session, Message],
      synchronize: true,
    };
    let ds: DataSource | undefined;
    try {
      ds = await new DataSource(options).initialize();
      await ds
        .getRepository(Message)
        .insert([row('lead', 'discarded'), row('alpha', 'alpha survivor'), row('nullable', null)]);
      const runner = ds.createQueryRunner();
      try {
        await new AddMessagesFts1782400000000().up(runner);
      } finally {
        await runner.release();
      }
      if (rebuilt) {
        await ds.getRepository(Message).delete({ id: 'lead' });
        await ds.query('ALTER TABLE messages ADD COLUMN legacy_extra text');
      }
      await ds.destroy();
      ds = await createBootDataSource(options);
      expect(ds.isInitialized).toBe(true);
      expect(await matches(ds, 'alpha')).toEqual(['alpha']);
      await expect(integrity(ds)).resolves.toBeDefined();
    } finally {
      if (ds?.isInitialized) await ds.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
