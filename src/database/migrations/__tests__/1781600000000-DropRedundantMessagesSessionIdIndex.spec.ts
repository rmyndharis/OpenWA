import { DataSource } from 'typeorm';
import { DropRedundantMessagesSessionIdIndex1781600000000 } from '../1781600000000-DropRedundantMessagesSessionIdIndex';

describe('DropRedundantMessagesSessionIdIndex migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:' });
    await ds.initialize();
    await ds.query(
      `CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    // The redundant single-column index plus the composite that subsumes it.
    await ds.query(`CREATE INDEX "IDX_066163c46cda7e8187f96bc87a" ON "messages" ("sessionId")`);
    await ds.query(`CREATE INDEX "IDX_399833392126349ef0b04b9bed" ON "messages" ("sessionId", "createdAt")`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const indexNames = async (): Promise<string[]> => {
    const rows = await ds.query<{ name: string }[]>(`PRAGMA index_list("messages")`);
    return rows.map(r => r.name).sort();
  };

  it('drops the redundant single-column sessionId index but keeps the composite', async () => {
    const runner = ds.createQueryRunner();
    await new DropRedundantMessagesSessionIdIndex1781600000000().up(runner);

    const idx = await indexNames();
    expect(idx).not.toContain('IDX_066163c46cda7e8187f96bc87a');
    expect(idx).toContain('IDX_399833392126349ef0b04b9bed'); // composite (sessionId, createdAt) retained
  });

  it('is idempotent (re-running up is a no-op) and down() restores the index', async () => {
    const runner = ds.createQueryRunner();
    const migration = new DropRedundantMessagesSessionIdIndex1781600000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined(); // IF EXISTS — safe to re-run

    await migration.down(runner);
    expect(await indexNames()).toContain('IDX_066163c46cda7e8187f96bc87a');
  });
});
