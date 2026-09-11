import { DataSource } from 'typeorm';
import { AddClientMappings1786500000000 } from '../1786500000000-AddClientMappings';

describe('AddClientMappings migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('creates and drops the table', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddClientMappings1786500000000();

    await migration.up(runner);
    expect(await runner.hasTable('client_mappings')).toBe(true);

    await migration.down(runner);
    expect(await runner.hasTable('client_mappings')).toBe(false);

    await runner.release();
  });

  it('up() is idempotent when the table already exists (hasTable guard)', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddClientMappings1786500000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.not.toThrow();
    expect(await runner.hasTable('client_mappings')).toBe(true);

    await runner.release();
  });

  it('enforces (sessionId, jid, kind) uniqueness but allows two teammate rows with no sessionId', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddClientMappings1786500000000();
    await migration.up(runner);

    await runner.query(
      `INSERT INTO "client_mappings" ("id", "sessionId", "jid", "kind", "name", "company") ` +
        `VALUES ('m1', 's1', '628@c.us', 'contact', 'Alice', 'Acme')`,
    );
    await expect(
      runner.query(
        `INSERT INTO "client_mappings" ("id", "sessionId", "jid", "kind", "name", "company") ` +
          `VALUES ('m2', 's1', '628@c.us', 'contact', 'Alice again', 'Acme')`,
      ),
    ).rejects.toThrow();

    // Documented DB-level gap (see entity doc comment): NULL sessionId rows are not considered equal
    // by the unique index, so two teammate rows with the same jid do NOT collide here — the service
    // layer is what actually enforces teammate-jid uniqueness.
    await runner.query(
      `INSERT INTO "client_mappings" ("id", "sessionId", "jid", "kind", "name", "company") ` +
        `VALUES ('m3', NULL, 'alice@acme.com', 'teammate', 'Alice', 'Acme')`,
    );
    await expect(
      runner.query(
        `INSERT INTO "client_mappings" ("id", "sessionId", "jid", "kind", "name", "company") ` +
          `VALUES ('m4', NULL, 'alice@acme.com', 'teammate', 'Alice dup', 'Acme')`,
      ),
    ).resolves.toBeDefined();

    await runner.release();
  });

  it('defaults status to active and sentimentTracking to true', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddClientMappings1786500000000();
    await migration.up(runner);

    await runner.query(
      `INSERT INTO "client_mappings" ("id", "sessionId", "jid", "kind", "name", "company") ` +
        `VALUES ('m5', 's1', '629@g.us', 'group', 'Client Group', 'Acme')`,
    );
    const rows = (await runner.query(
      `SELECT "status", "sentimentTracking" FROM "client_mappings" WHERE "id" = 'm5'`,
    )) as Array<{ status: string; sentimentTracking: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(Number(rows[0].sentimentTracking)).toBe(1);

    await runner.release();
  });
});
