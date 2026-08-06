import { DataSource } from 'typeorm';
import { AddMessagesCreatedAtIndex1785123853000 } from '../1785123853000-AddMessagesCreatedAtIndex';

describe('AddMessagesCreatedAtIndex migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    // Pre-migration shape: the messages table with only the composite (sessionId, createdAt).
    await ds.query(
      `CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
        `"direction" varchar NOT NULL DEFAULT ('outgoing'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await ds.query(`CREATE INDEX "IDX_399833392126349ef0b04b9bed" ON "messages" ("sessionId", "createdAt")`);
    // A few hundred rows spread over 60 days so the planner sees a real range predicate.
    const rows: string[] = [];
    for (let i = 0; i < 200; i++) {
      const d = new Date(Date.now() - (i % 60) * 86400000).toISOString().replace('T', ' ').slice(0, 23);
      rows.push(`('id${i}', 's${i % 5}', '${i % 2 ? 'incoming' : 'outgoing'}', '${d}')`);
    }
    await ds.query(`INSERT INTO "messages" ("id","sessionId","direction","createdAt") VALUES ${rows.join(',')}`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const indexNames = async (): Promise<string[]> => {
    const rows = await ds.query<{ name: string }[]>(`PRAGMA index_list("messages")`);
    return rows.map(r => r.name).sort();
  };

  it('creates the standalone createdAt index and keeps the composite', async () => {
    const runner = ds.createQueryRunner();
    await new AddMessagesCreatedAtIndex1785123853000().up(runner);

    const idx = await indexNames();
    expect(idx).toContain('IDX_messages_createdAt');
    expect(idx).toContain('IDX_399833392126349ef0b04b9bed');
  });

  it('is idempotent (re-running up is a no-op) and down() drops the index', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessagesCreatedAtIndex1785123853000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined(); // IF NOT EXISTS — safe to re-run
    expect(await indexNames()).toContain('IDX_messages_createdAt');

    await migration.down(runner);
    expect(await indexNames()).not.toContain('IDX_messages_createdAt');
  });

  it('the createdAt-only range predicate used by the stats aggregates is served by the index', async () => {
    const runner = ds.createQueryRunner();
    await new AddMessagesCreatedAtIndex1785123853000().up(runner);

    const since = new Date(Date.now() - 86400000).toISOString().replace('T', ' ').slice(0, 23);
    const plan = await ds.query<{ detail: string }[]>(
      `EXPLAIN QUERY PLAN SELECT "direction", COUNT(*) FROM "messages" WHERE "createdAt" >= '${since}' GROUP BY "direction"`,
    );
    expect(plan.map(p => p.detail).join(' | ')).toMatch(
      /SEARCH messages USING (COVERING )?INDEX IDX_messages_createdAt/,
    );
  });
});
