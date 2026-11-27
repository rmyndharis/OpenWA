import { DataSource } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';
import { AddApiKeyDeniedPermissions1794000000000 } from '../1794000000000-AddApiKeyDeniedPermissions';

describe('AddApiKeyDeniedPermissions migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const columns = async (): Promise<string[]> => {
    const qr = ds.createQueryRunner();
    const rows = (await qr.query(`PRAGMA table_info("api_keys")`)) as Array<{ name: string }>;
    await qr.release();
    return rows.map(row => row.name);
  };

  it('adds a nullable deniedPermissions column without narrowing existing keys', async () => {
    const qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    expect(await columns()).not.toContain('deniedPermissions');

    await new AddApiKeyDeniedPermissions1794000000000().up(qr);
    expect(await columns()).toContain('deniedPermissions');
    await qr.query("INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('1', 'k', 'hash', 'pref')");
    const rows = (await qr.query("SELECT deniedPermissions FROM api_keys WHERE id = '1'")) as Array<{
      deniedPermissions: string | null;
    }>;
    expect(rows[0].deniedPermissions).toBeNull();
    await qr.release();
  });

  it('is idempotent', async () => {
    const qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    const migration = new AddApiKeyDeniedPermissions1794000000000();
    await migration.up(qr);
    await expect(migration.up(qr)).resolves.not.toThrow();
    await qr.release();
  });

  it('down() drops the column', async () => {
    const qr = ds.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(qr);
    const migration = new AddApiKeyDeniedPermissions1794000000000();
    await migration.up(qr);
    await migration.down(qr);
    expect(await columns()).not.toContain('deniedPermissions');
    await qr.release();
  });
});
