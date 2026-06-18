import { DataSource } from 'typeorm';
import { AddMessageStatus1770108659848 } from '../1770108659848-AddMessageStatus';

describe('AddMessageStatus baseline migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('creates the full baseline schema on an empty DB (fresh deploy)', async () => {
    const runner = ds.createQueryRunner();
    await new AddMessageStatus1770108659848().up(runner);

    expect(await runner.hasTable('sessions')).toBe(true);
    expect(await runner.hasTable('webhooks')).toBe(true);
    expect(await runner.hasTable('messages')).toBe(true);
    expect(await runner.hasTable('message_batches')).toBe(true);

    await runner.release();
  });

  it('is a no-op when sessions already exists (synchronize-created DB adopting migrations)', async () => {
    const runner = ds.createQueryRunner();
    // Simulate a synchronize-created DB: the schema is already present, but the
    // migrations tracking table is empty, so TypeORM tries to run this baseline.
    await runner.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL)`);

    // Must NOT throw "table sessions already exists" — the baseline should detect the
    // existing schema and skip (TypeORM still records it as applied).
    await expect(new AddMessageStatus1770108659848().up(runner)).resolves.toBeUndefined();

    await runner.release();
  });
});
