import { DataSource } from 'typeorm';
import { AddMessageEngineRef1792000000000 } from '../1792000000000-AddMessageEngineRef';

describe('AddMessageEngineRef migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('adds the column, keeps existing rows as null, and drops it again', async () => {
    const runner = ds.createQueryRunner();
    await runner.query(`CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "chatId" varchar NOT NULL)`);
    await runner.query(`INSERT INTO "messages" ("id", "chatId") VALUES ('m1', '628111@c.us')`);
    const migration = new AddMessageEngineRef1792000000000();

    await migration.up(runner);
    await migration.up(runner); // idempotent
    expect(await runner.query(`SELECT "chatId", "engineRef" FROM "messages"`)).toEqual([
      { chatId: '628111@c.us', engineRef: null },
    ]);

    await migration.down(runner);
    await migration.down(runner); // idempotent
    expect(await runner.hasColumn('messages', 'engineRef')).toBe(false);
    expect(await runner.query(`SELECT "chatId" FROM "messages"`)).toEqual([{ chatId: '628111@c.us' }]);
    await runner.release();
  });

  it('is a no-op without the table', async () => {
    const runner = ds.createQueryRunner();
    await expect(new AddMessageEngineRef1792000000000().up(runner)).resolves.toBeUndefined();
    await expect(new AddMessageEngineRef1792000000000().down(runner)).resolves.toBeUndefined();
    await runner.release();
  });
});
