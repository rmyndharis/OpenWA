import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { AddMessagesFts1782400000000 } from '../1782400000000-AddMessagesFts';

/**
 * SQLite in-memory coverage for the AddMessagesFts migration:
 *  - the FTS5 external-content table + 3 sync triggers are created and keep the index in sync on
 *    insert/update (incl. the revoke path: clearing `body` drops the row from the index);
 *  - re-running up() is a no-op (IF NOT EXISTS / DROP-then-CREATE idempotency);
 *  - down() removes all four objects;
 *  - the FTS5-absent build (probe returns 0) returns without creating anything and never throws.
 *
 * Postgres is exercised end-to-end in Task 7; the dialect branch is type-checked here via a stub.
 */
describe('AddMessagesFts migration (sqlite)', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
      migrations: [],
    });
    await ds.initialize();
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('creates messages_fts + triggers, keeps them in sync on insert, and drops rows on body clear', async () => {
    const runner = ds.createQueryRunner();
    await new AddMessagesFts1782400000000().up(runner);

    const repo = ds.getRepository(Message);
    await repo.insert({
      sessionId: 's1',
      chatId: 'c1',
      from: 'a@c.us',
      to: 'b@c.us',
      body: 'hello world',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: 1,
    });
    await repo.insert({
      sessionId: 's1',
      chatId: 'c1',
      from: 'a@c.us',
      to: 'b@c.us',
      body: 'banana',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: 2,
    });

    const rows = (await runner.query(
      `SELECT m.body FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?`,
      ['hello'],
    )) as Array<{ body: string }>;
    expect(rows.map(r => r.body)).toEqual(['hello world']);

    // revoke path: clearing body drops it from the index (AFTER UPDATE trigger issues the 'delete' command)
    await repo.update({ body: 'hello world' }, { body: '' });
    const after = (await runner.query(
      `SELECT count(*) AS n FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ?`,
      ['hello'],
    )) as Array<{ n: number }>;
    expect(Number(after[0].n)).toBe(0);

    await runner.release();
  });

  it('is idempotent: re-running up() is a no-op and leaves exactly one messages_fts table', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessagesFts1782400000000();
    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();

    const tables = (await runner.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'`,
    )) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    for (const trig of ['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au']) {
      const triggers = (await runner.query(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`, [
        trig,
      ])) as Array<{ name: string }>;
      expect(triggers).toHaveLength(1);
    }
    await runner.release();
  });

  it('down() drops the virtual table and all three sync triggers', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessagesFts1782400000000();
    await migration.up(runner);
    await migration.down(runner);

    const table = (await runner.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'`,
    )) as Array<{ name: string }>;
    expect(table).toHaveLength(0);
    const triggers = (await runner.query(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('messages_fts_ai','messages_fts_ad','messages_fts_au')`,
    )) as Array<{ name: string }>;
    expect(triggers).toHaveLength(0);
    await runner.release();
  });

  it('does not throw and leaves no FTS schema when FTS5 is unavailable (probe returns 0)', async () => {
    // Simulate a SQLite build compiled without ENABLE_FTS5: the probe returns enabled=0. up() must
    // return early (no CREATE VIRTUAL TABLE) so a non-FTS5 build doesn't crash boot.
    const calls: string[] = [];
    const stub = {
      dataSource: { options: { type: 'better-sqlite3' as const } },
      query: jest.fn((stmt: string) => {
        calls.push(stmt);
        if (stmt.includes("sqlite_compileoption_used('ENABLE_FTS5')")) {
          return [{ enabled: 0 }];
        }
        throw new Error(`unexpected query on FTS5-absent path: ${stmt}`);
      }),
    } as unknown as QueryRunner;

    await expect(new AddMessagesFts1782400000000().up(stub)).resolves.toBeUndefined();
    // Only the probe should have been issued — no CREATE VIRTUAL TABLE / INSERT / trigger DDL.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('sqlite_compileoption_used');
  });
});

/**
 * Dual-DB safety (Task 12): the migration must tolerate repeated up()/down() cycling without leaving
 * partial state. Idempotency on a populated schema is covered above; this block adds the down→up
 * round-trip and asserts the FTS5 probe reports enabled on the actual test SQLite build (so the
 * absent-FTS5 branch is known to be the ONLY thing producing a 0 from that probe).
 */
describe('AddMessagesFts — dual-DB safety', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
      migrations: [],
    });
    await ds.initialize();
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('down() then up() round-trips cleanly (schema re-creatable after teardown)', async () => {
    const qr = ds.createQueryRunner();
    const m = new AddMessagesFts1782400000000();
    await m.up(qr);
    await m.down(qr);
    await m.up(qr);

    const tables = (await qr.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'`,
    )) as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    for (const trig of ['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au']) {
      const triggers = (await qr.query(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`, [
        trig,
      ])) as Array<{ name: string }>;
      expect(triggers).toHaveLength(1);
    }
    await qr.release();
  });

  it('the FTS5 probe reports enabled on the test SQLite build', async () => {
    // The npm sqlite drivers ship with ENABLE_FTS5; this pins that assumption so the absent-FTS5 branch
    // (probe returns 0) is known to be the only path that produces a 0 here — not a stale assumption.
    const rows: Array<{ enabled: number }> = await ds.query(
      `SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled`,
    );
    expect(Number(rows[0].enabled)).toBe(1);
  });
});
