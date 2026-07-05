import { DataSource } from 'typeorm';
import { AddBaileysStoredMessages1781000000000 } from '../1781000000000-AddBaileysStoredMessages';

describe('AddBaileysStoredMessages migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    // A `sessions` table must exist for the FK; create a minimal stand-in.
    ds = new DataSource({ type: 'sqlite', database: ':memory:' });
    await ds.initialize();
    await ds.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL)`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('creates and drops the table + indexes', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddBaileysStoredMessages1781000000000();

    await migration.up(runner);
    expect(await runner.hasTable('baileys_stored_messages')).toBe(true);

    await migration.down(runner);
    expect(await runner.hasTable('baileys_stored_messages')).toBe(false);

    await runner.release();
  });

  it('down() does not throw when the named indexes were never created (synchronize-bootstrapped DB)', async () => {
    const runner = ds.createQueryRunner();
    // No up(): the named indexes never existed (a synchronize-built schema uses hash-named ones).
    await expect(new AddBaileysStoredMessages1781000000000().down(runner)).resolves.toBeUndefined();
    await runner.release();
  });
});
