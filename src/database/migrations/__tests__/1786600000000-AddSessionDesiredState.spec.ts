import { DataSource } from 'typeorm';
import { AddSessionDesiredState1786600000000 } from '../1786600000000-AddSessionDesiredState';

describe('AddSessionDesiredState migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL, "name" varchar NOT NULL)`);
    await ds.query(`INSERT INTO "sessions" ("id", "name") VALUES ('s1', 'main')`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('adds a nullable column that reads NULL on existing rows, and drops it again', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddSessionDesiredState1786600000000();

    await migration.up(runner);
    expect(await runner.hasColumn('sessions', 'desiredState')).toBe(true);
    const rows = (await runner.query(`SELECT "desiredState" FROM "sessions"`)) as Array<{ desiredState: unknown }>;
    expect(rows).toEqual([{ desiredState: null }]);

    await migration.down(runner);
    expect(await runner.hasColumn('sessions', 'desiredState')).toBe(false);
    await runner.release();
  });

  it('up() and down() are idempotent', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddSessionDesiredState1786600000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.not.toThrow();
    await migration.down(runner);
    await expect(migration.down(runner)).resolves.not.toThrow();
    await runner.release();
  });
});
