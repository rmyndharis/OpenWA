import { DataSource, QueryRunner } from 'typeorm';
import { AddTemplateNameUnique1781100000000 } from '../1781100000000-AddTemplateNameUnique';

describe('AddTemplateNameUnique migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:' });
    await ds.initialize();
    // Minimal templates table mirroring the AddTemplates sqlite schema.
    await ds.query(
      `CREATE TABLE "templates" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
        `"name" varchar(100) NOT NULL, "body" text NOT NULL, "header" text, "footer" text, ` +
        `"createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL)`,
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const insert = (id: string, sessionId: string, name: string, createdAt: string): Promise<unknown> =>
    ds.query(
      `INSERT INTO "templates" ("id","sessionId","name","body","header","footer","createdAt","updatedAt") ` +
        `VALUES (?, ?, ?, 'body', NULL, NULL, ?, ?)`,
      [id, sessionId, name, createdAt, createdAt],
    );

  it('creates the composite unique index and is idempotent', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddTemplateNameUnique1781100000000();

    await migration.up(runner);
    const index = (await runner.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='IDX_templates_session_name'`,
    )) as unknown[];
    expect(index).toHaveLength(1);

    // Re-run must not throw (idempotent).
    await expect(migration.up(runner)).resolves.toBeUndefined();
    await runner.release();
  });

  it('deduplicates pre-existing (sessionId, name) collisions losslessly, keeping the earliest', async () => {
    await insert('id-early', 'sess-1', 'welcome', '2026-01-01T00:00:00.000Z');
    await insert('id-late', 'sess-1', 'welcome', '2026-02-01T00:00:00.000Z');
    await insert('id-other', 'sess-1', 'promo', '2026-01-01T00:00:00.000Z');

    const runner = ds.createQueryRunner();
    await new AddTemplateNameUnique1781100000000().up(runner);

    // No rows lost — all three bodies survive.
    const all = (await runner.query(`SELECT id, name FROM "templates" ORDER BY id`)) as { id: string; name: string }[];
    expect(all).toHaveLength(3);

    const byId = Object.fromEntries(all.map(r => [r.id, r.name]));
    expect(byId['id-early']).toBe('welcome'); // earliest keeps the clean name
    expect(byId['id-late']).toBe('welcome-dup-id-late'); // later duplicate renamed losslessly
    expect(byId['id-other']).toBe('promo'); // unrelated row untouched

    // The unique index now rejects a fresh duplicate.
    await expect(
      runner.query(
        `INSERT INTO "templates" ("id","sessionId","name","body","header","footer","createdAt","updatedAt") ` +
          `VALUES ('id-new','sess-1','welcome','body',NULL,NULL,'2026-03-01T00:00:00.000Z','2026-03-01T00:00:00.000Z')`,
      ),
    ).rejects.toThrow();

    await runner.release();
  });

  it('is a no-op when the templates table does not exist', async () => {
    await ds.query(`DROP TABLE "templates"`);
    const runner = ds.createQueryRunner();
    await expect(new AddTemplateNameUnique1781100000000().up(runner)).resolves.toBeUndefined();
    await runner.release();
  });

  it('lifts the runtime statement_timeout for the migration transaction on Postgres', async () => {
    // The runtime data pool's statement_timeout is inherited by the boot-migration connection; this
    // dedup UPDATE / CREATE UNIQUE INDEX over templates must not be aborted mid-flight.
    const queries: string[] = [];
    const pgRunner = {
      connection: { options: { type: 'postgres' } },
      hasTable: jest.fn().mockResolvedValue(true),
      query: jest.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve([]);
      }),
    } as unknown as QueryRunner;

    await new AddTemplateNameUnique1781100000000().up(pgRunner);

    expect(queries[0]).toBe('SET LOCAL statement_timeout = 0');
  });
});
