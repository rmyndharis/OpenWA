import { DataSource } from 'typeorm';
import { AddWebhookDeliveryFailures1781700000000 } from '../1781700000000-AddWebhookDeliveryFailures';

describe('AddWebhookDeliveryFailures migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const tableExists = async (): Promise<boolean> => {
    const rows = await ds.query<{ name: string }[]>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_delivery_failures'`,
    );
    return rows.length > 0;
  };

  it('creates the table (insertable shape), is idempotent, and down() reverses it', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddWebhookDeliveryFailures1781700000000();

    await migration.up(runner);
    expect(await tableExists()).toBe(true);

    // Column shape sanity: a minimal row (nullables omitted, createdAt defaulted) inserts cleanly.
    await ds.query(
      `INSERT INTO "webhook_delivery_failures" ("id","webhookId","sessionId","event","url","attempts","lastError") ` +
        `VALUES ('id1','wh','s1','message.received','https://r/h',3,'HTTP 503: x')`,
    );

    await expect(migration.up(runner)).resolves.toBeUndefined(); // hasTable guard → no-op on re-run

    await migration.down(runner);
    expect(await tableExists()).toBe(false);
  });

  it('down() does not throw when the index was never created (synchronize-bootstrapped DB)', async () => {
    const runner = ds.createQueryRunner();
    // No up(): the named index never existed, so a bare DROP INDEX would error — down() must tolerate it.
    await expect(new AddWebhookDeliveryFailures1781700000000().down(runner)).resolves.toBeUndefined();
  });
});
