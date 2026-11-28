import { DataSource } from 'typeorm';
import { AddMessageEchoOf1792200000000 } from '../1792200000000-AddMessageEchoOf';

describe('AddMessageEchoOf migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('adds the column and its partial index, keeps existing rows as null, and drops both again', async () => {
    const runner = ds.createQueryRunner();
    await runner.query(`CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "chatId" varchar NOT NULL)`);
    await runner.query(`INSERT INTO "messages" ("id", "chatId") VALUES ('m1', '628111@c.us')`);
    const migration = new AddMessageEchoOf1792200000000();
    const index = async () =>
      (await runner.query(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'IDX_messages_echoOf'`)) as {
        sql: string;
      }[];

    await migration.up(runner);
    await migration.up(runner); // idempotent
    expect(await runner.query(`SELECT "chatId", "echoOf" FROM "messages"`)).toEqual([
      { chatId: '628111@c.us', echoOf: null },
    ]);
    expect((await index()).map(row => row.sql)).toEqual([
      'CREATE INDEX "IDX_messages_echoOf" ON "messages" ("echoOf") WHERE "echoOf" IS NOT NULL',
    ]);

    await migration.down(runner);
    await migration.down(runner); // idempotent
    expect(await runner.hasColumn('messages', 'echoOf')).toBe(false);
    expect(await index()).toEqual([]);
    expect(await runner.query(`SELECT "chatId" FROM "messages"`)).toEqual([{ chatId: '628111@c.us' }]);
    await runner.release();
  });

  it('is a no-op without the table', async () => {
    const runner = ds.createQueryRunner();
    await expect(new AddMessageEchoOf1792200000000().up(runner)).resolves.toBeUndefined();
    await expect(new AddMessageEchoOf1792200000000().down(runner)).resolves.toBeUndefined();
    await runner.release();
  });
});
