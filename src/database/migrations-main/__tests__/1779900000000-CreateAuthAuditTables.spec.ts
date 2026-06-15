import { DataSource } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';

/**
 * Regression lock: the main-connection migration must create the
 * api_keys + audit_logs schema so that running with MAIN_DATABASE_SYNCHRONIZE=false
 * does NOT leave a fresh install without an auth table (total auth failure at boot).
 */
describe('CreateAuthAuditTables migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('creates api_keys + audit_logs (so auth works without synchronize)', async () => {
    const qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);

    const tables = (await qr.query("SELECT name FROM sqlite_master WHERE type='table'")) as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain('api_keys');
    expect(names).toContain('audit_logs');

    const indexes = (await qr.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='api_keys'",
    )) as Array<{ name: string }>;
    expect(indexes.some(i => i.name === 'IDX_api_keys_keyHash')).toBe(true);

    // An API key row inserts and gets its column defaults — i.e. auth can read/write it.
    await qr.query("INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('1', 'k', 'hash', 'pref')");
    const rows = (await qr.query("SELECT role, isActive, usageCount FROM api_keys WHERE id = '1'")) as Array<{
      role: string;
      isActive: number;
      usageCount: number;
    }>;
    expect(rows[0].role).toBe('operator');
    expect(rows[0].usageCount).toBe(0);

    await qr.release();
  });

  it('is idempotent (safe to run on a DB that already has the tables)', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateAuthAuditTables1779900000000();
    await migration.up(qr);
    // running again must NOT throw (CREATE TABLE IF NOT EXISTS)
    await expect(migration.up(qr)).resolves.not.toThrow();
    await qr.release();
  });

  it('down() drops both tables', async () => {
    const qr = ds.createQueryRunner();
    const migration = new CreateAuthAuditTables1779900000000();
    await migration.up(qr);
    await migration.down(qr);

    const tables = (await qr.query("SELECT name FROM sqlite_master WHERE type='table'")) as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).not.toContain('api_keys');
    expect(names).not.toContain('audit_logs');

    await qr.release();
  });
});
