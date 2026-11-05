import { DataSource } from 'typeorm';
import { AddStatusMediaPathIndex1791800000000 } from '../1791800000000-AddStatusMediaPathIndex';

describe('AddStatusMediaPathIndex migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    // The status_updates table, with only the columns this index needs.
    await ds.query(
      `CREATE TABLE "status_updates" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
        `"mediaPath" varchar NULL)`,
    );
    // Many stories carry no media; a handful have a stored file.
    const rows: string[] = [];
    for (let i = 0; i < 200; i++) {
      rows.push(`('id${i}', 's1', ${i % 20 === 0 ? `'statuses/s1/${i}.jpg'` : 'NULL'})`);
    }
    await ds.query(`INSERT INTO "status_updates" ("id","sessionId","mediaPath") VALUES ${rows.join(',')}`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const indexNames = async (): Promise<string[]> => {
    const rows = await ds.query<{ name: string }[]>(`PRAGMA index_list("status_updates")`);
    return rows.map(r => r.name).sort();
  };

  it('creates the partial mediaPath index', async () => {
    const runner = ds.createQueryRunner();
    await new AddStatusMediaPathIndex1791800000000().up(runner);

    expect(await indexNames()).toContain('IDX_status_updates_mediaPath');
    // Partial: the column is NULL for every story without stored media, which a full index would carry for nothing.
    const [created] = await ds.query<{ sql: string }[]>(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'IDX_status_updates_mediaPath'`,
    );
    expect(created.sql).toContain('WHERE "mediaPath" IS NOT NULL');
  });

  it('is idempotent (re-running up is a no-op) and down() drops the index', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddStatusMediaPathIndex1791800000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();
    expect(await indexNames()).toContain('IDX_status_updates_mediaPath');

    await migration.down(runner);
    expect(await indexNames()).not.toContain('IDX_status_updates_mediaPath');
  });

  it('the orphan sweep mediaPath IN (...) predicate is served by the index, not a table scan', async () => {
    const runner = ds.createQueryRunner();
    await new AddStatusMediaPathIndex1791800000000().up(runner);

    const plan = await ds.query<{ detail: string }[]>(
      `EXPLAIN QUERY PLAN SELECT "mediaPath" FROM "status_updates" WHERE "mediaPath" IN ('statuses/s1/0.jpg', 'statuses/s1/20.jpg')`,
    );
    const detail = plan.map(r => r.detail).join(' ');
    expect(detail).toContain('IDX_status_updates_mediaPath');
    expect(detail).not.toContain('SCAN');
  });
});
