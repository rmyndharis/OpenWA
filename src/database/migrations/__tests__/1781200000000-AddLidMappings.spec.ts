import { DataSource } from 'typeorm';
import { AddLidMappings1781200000000 } from '../1781200000000-AddLidMappings';

describe('AddLidMappings migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('creates and drops the table + phone index', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddLidMappings1781200000000();

    await migration.up(runner);
    expect(await runner.hasTable('lid_mappings')).toBe(true);

    await migration.down(runner);
    expect(await runner.hasTable('lid_mappings')).toBe(false);

    await runner.release();
  });

  it('up() is idempotent when the table already exists (hasTable guard)', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddLidMappings1781200000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.not.toThrow();
    expect(await runner.hasTable('lid_mappings')).toBe(true);

    await runner.release();
  });

  it('down() is safe when the index is absent (IF EXISTS)', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddLidMappings1781200000000();

    // Simulate the `synchronize` path: a table with no explicitly-named IDX_lid_mappings_phone index.
    await runner.query(`CREATE TABLE "lid_mappings" ("lid" varchar PRIMARY KEY NOT NULL, "phone" varchar)`);
    await expect(migration.down(runner)).resolves.not.toThrow();
    expect(await runner.hasTable('lid_mappings')).toBe(false);

    await runner.release();
  });
});
