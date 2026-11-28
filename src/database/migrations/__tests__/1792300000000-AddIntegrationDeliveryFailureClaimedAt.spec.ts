import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AddIntegrationFabric1781900000000 } from '../1781900000000-AddIntegrationFabric';
import { AddIntegrationDeliveryFailureClaimedAt1792300000000 } from '../1792300000000-AddIntegrationDeliveryFailureClaimedAt';

/** On SQLite, and on PostgreSQL in a schema of its own when DATABASE_TYPE=postgres. */
describe('AddIntegrationDeliveryFailureClaimedAt migration', () => {
  const pg = process.env.DATABASE_TYPE === 'postgres';
  const server = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
  };
  let ds: DataSource;
  let admin: DataSource | undefined;
  let schema: string;

  beforeEach(async () => {
    schema = `claimed_at_${randomUUID().replace(/-/g, '')}`;
    admin = pg ? await new DataSource(server).initialize() : undefined;
    if (admin) await admin.query(`CREATE SCHEMA "${schema}"`);
    ds = await new DataSource(
      pg
        ? { ...server, schema, extra: { options: `-c search_path=${schema},public` } }
        : { type: 'better-sqlite3', database: ':memory:' },
    ).initialize();
  });

  afterEach(async () => {
    await ds.destroy();
    if (admin) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  /** The column's type as the database reports it. */
  const columnType = async (): Promise<string | undefined> => {
    if (pg) {
      const rows = await ds.query<Array<{ data_type: string }>>(
        `SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
        [schema, 'integration_delivery_failures', 'claimedAt'],
      );
      return rows[0]?.data_type;
    }
    const rows = await ds.query<Array<{ name: string; type: string }>>(
      `PRAGMA table_info("integration_delivery_failures")`,
    );
    return rows.find(row => row.name === 'claimedAt')?.type;
  };

  it('adds the column, keeps existing rows as not taken, and drops it again', async () => {
    const runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
    await runner.query(
      `INSERT INTO "integration_delivery_failures" ("id", "direction", "pluginId", "instanceId", "attempts", "lastError") ` +
        `VALUES ('f1', 'inbound', 'plug', 'inst', 1, 'unavailable')`,
    );
    const migration = new AddIntegrationDeliveryFailureClaimedAt1792300000000();

    await migration.up(runner);
    await migration.up(runner); // idempotent
    expect(await runner.query(`SELECT "id", "claimedAt" FROM "integration_delivery_failures"`)).toEqual([
      { id: 'f1', claimedAt: null },
    ]);

    await migration.down(runner);
    expect(await runner.hasColumn('integration_delivery_failures', 'claimedAt')).toBe(false);
    expect(await runner.query(`SELECT "id" FROM "integration_delivery_failures"`)).toEqual([{ id: 'f1' }]);
    await runner.release();
  });

  // The type the entity declares (dateColumnType), so the take time compares as a time on each dialect.
  it('adds a timestamp on PostgreSQL and text on SQLite', async () => {
    const runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);

    await new AddIntegrationDeliveryFailureClaimedAt1792300000000().up(runner);

    expect((await columnType())?.toLowerCase()).toBe(pg ? 'timestamp without time zone' : 'text');
    await runner.release();
  });

  it('is a no-op without the table', async () => {
    const runner = ds.createQueryRunner();
    await expect(new AddIntegrationDeliveryFailureClaimedAt1792300000000().up(runner)).resolves.toBeUndefined();
    await expect(new AddIntegrationDeliveryFailureClaimedAt1792300000000().down(runner)).resolves.toBeUndefined();
    await runner.release();
  });
});
