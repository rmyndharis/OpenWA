import { DataSource } from 'typeorm';
import { AddWebhookOutboxEngineRef1792100000000 } from '../1792100000000-AddWebhookOutboxEngineRef';

describe('AddWebhookOutboxEngineRef migration', () => {
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
    await runner.query(
      `CREATE TABLE "webhook_outbox_events" ("id" varchar PRIMARY KEY NOT NULL, "event" varchar NOT NULL)`,
    );
    await runner.query(`INSERT INTO "webhook_outbox_events" ("id", "event") VALUES ('o1', 'message.sent')`);
    const migration = new AddWebhookOutboxEngineRef1792100000000();

    await migration.up(runner);
    await migration.up(runner); // idempotent
    expect(await runner.query(`SELECT "event", "engineRef" FROM "webhook_outbox_events"`)).toEqual([
      { event: 'message.sent', engineRef: null },
    ]);

    await migration.down(runner);
    await migration.down(runner); // idempotent
    expect(await runner.hasColumn('webhook_outbox_events', 'engineRef')).toBe(false);
    await runner.release();
  });

  it('is a no-op without the table', async () => {
    const runner = ds.createQueryRunner();
    await expect(new AddWebhookOutboxEngineRef1792100000000().up(runner)).resolves.toBeUndefined();
    await expect(new AddWebhookOutboxEngineRef1792100000000().down(runner)).resolves.toBeUndefined();
    await runner.release();
  });
});
