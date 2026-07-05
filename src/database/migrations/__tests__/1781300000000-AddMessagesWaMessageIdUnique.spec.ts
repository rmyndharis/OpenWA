import { DataSource, QueryRunner } from 'typeorm';
import { AddMessagesWaMessageIdUnique1781300000000 } from '../1781300000000-AddMessagesWaMessageIdUnique';

describe('AddMessagesWaMessageIdUnique migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:' });
    await ds.initialize();
    await ds.query(
      `CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
        `"waMessageId" varchar, "chatId" varchar NOT NULL, "from" varchar NOT NULL, "to" varchar NOT NULL, ` +
        `"body" text, "type" varchar NOT NULL DEFAULT ('text'), "direction" varchar NOT NULL DEFAULT ('outgoing'), ` +
        `"timestamp" bigint, "metadata" text, "status" varchar NOT NULL DEFAULT ('sent'), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await ds.query(`CREATE INDEX "IDX_messages_sessionId_waMessageId" ON "messages" ("sessionId", "waMessageId")`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const insert = (id: string, sessionId: string, waMessageId: string | null, createdAt: string): Promise<unknown> =>
    ds.query(
      `INSERT INTO "messages" ("id","sessionId","waMessageId","chatId","from","to","body","type","direction","timestamp","status","createdAt") ` +
        `VALUES (?,?,?,'c@c.us','c@c.us','me@c.us','hi','text','incoming',1,'sent',?)`,
      [id, sessionId, waMessageId, createdAt],
    );

  it('deletes duplicate (sessionId, waMessageId) rows keeping the earliest, then enforces uniqueness', async () => {
    await insert('id-early', 'sess-1', 'wa-1', '2026-01-01T00:00:00.000Z');
    await insert('id-late', 'sess-1', 'wa-1', '2026-02-01T00:00:00.000Z');
    await insert('id-other', 'sess-1', 'wa-2', '2026-01-01T00:00:00.000Z');

    const runner = ds.createQueryRunner();
    await new AddMessagesWaMessageIdUnique1781300000000().up(runner);

    const rows = (await runner.query(`SELECT id FROM "messages" ORDER BY id`)) as { id: string }[];
    expect(rows.map(r => r.id).sort()).toEqual(['id-early', 'id-other']); // later dup deleted, earliest kept

    await expect(insert('id-new', 'sess-1', 'wa-1', '2026-03-01T00:00:00.000Z')).rejects.toThrow();
    await runner.release();
  });

  it('keeps multiple NULL-waMessageId rows (NULLs are distinct under the unique index)', async () => {
    await insert('p1', 'sess-1', null, '2026-01-01T00:00:00.000Z');
    await insert('p2', 'sess-1', null, '2026-01-01T00:00:01.000Z');

    const runner = ds.createQueryRunner();
    await new AddMessagesWaMessageIdUnique1781300000000().up(runner);

    const rows = (await runner.query(`SELECT id FROM "messages" WHERE "waMessageId" IS NULL`)) as unknown[];
    expect(rows).toHaveLength(2);
    await runner.release();
  });

  it('is idempotent and a no-op when the table is absent', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessagesWaMessageIdUnique1781300000000();
    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined(); // re-run: index already exists
    await ds.query(`DROP TABLE "messages"`);
    await expect(migration.up(runner)).resolves.toBeUndefined(); // absent table
    await runner.release();
  });

  it('lifts the runtime statement_timeout for the migration transaction on Postgres', async () => {
    // The runtime data pool carries a statement_timeout that is inherited by the boot-migration
    // connection; this DELETE / CREATE UNIQUE INDEX over the hot messages table must not be aborted.
    const queries: string[] = [];
    const pgRunner = {
      connection: { options: { type: 'postgres' } },
      hasTable: jest.fn().mockResolvedValue(true),
      query: jest.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve([]);
      }),
    } as unknown as QueryRunner;

    await new AddMessagesWaMessageIdUnique1781300000000().up(pgRunner);

    expect(queries[0]).toBe('SET LOCAL statement_timeout = 0');
  });
});
