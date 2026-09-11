import { DataSource } from 'typeorm';
import { AddClientMappings1786500000000 } from '../1786500000000-AddClientMappings';
import { AddClientMappingPhoneUniqueness1786600000000 } from '../1786600000000-AddClientMappingPhoneUniqueness';

describe('AddClientMappingPhoneUniqueness migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await new AddClientMappings1786500000000().up(ds.createQueryRunner());
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const insert = async (
    runner: ReturnType<DataSource['createQueryRunner']>,
    row: Partial<{
      id: string;
      sessionId: string;
      jid: string;
      kind: string;
      name: string;
      phone: string | null;
      company: string;
      team: string | null;
      role: string | null;
      notes: string | null;
      updatedAt: string;
    }>,
  ): Promise<void> => {
    const cols: Record<string, string | null | undefined> = {
      kind: 'contact',
      name: 'x',
      company: 'Unknown',
      ...row,
    };
    const entries = Object.entries(cols).filter((entry): entry is [string, string | null] => entry[1] !== undefined);
    const keys = entries.map(([k]) => k);
    const values = entries.map(([, v]) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`));
    await runner.query(
      `INSERT INTO "client_mappings" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${values.join(', ')})`,
    );
  };

  it('adds aliasJids and enforces one row per (sessionId, phone)', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddClientMappingPhoneUniqueness1786600000000();
    await migration.up(runner);

    await insert(runner, { id: 'm1', sessionId: 's1', jid: '628@c.us', phone: '628' });
    await expect(insert(runner, { id: 'm2', sessionId: 's1', jid: '999@lid', phone: '628' })).rejects.toThrow();

    // A different phone, or the same phone in a different session, is unaffected.
    await expect(insert(runner, { id: 'm3', sessionId: 's1', jid: '629@c.us', phone: '629' })).resolves.toBeUndefined();
    await expect(insert(runner, { id: 'm4', sessionId: 's2', jid: '628@c.us', phone: '628' })).resolves.toBeUndefined();

    // Groups/teammates carry no phone at all, so any number of NULL-phone rows coexist.
    await expect(
      insert(runner, { id: 'm5', sessionId: 's1', jid: '120363@g.us', kind: 'group', phone: null }),
    ).resolves.toBeUndefined();
    await expect(
      insert(runner, { id: 'm6', sessionId: 's1', jid: '120364@g.us', kind: 'group', phone: null }),
    ).resolves.toBeUndefined();

    await runner.release();
  });

  it('is idempotent when run twice (hasColumn/IF NOT EXISTS guards)', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddClientMappingPhoneUniqueness1786600000000();
    await migration.up(runner);
    await expect(migration.up(runner)).resolves.not.toThrow();
    await runner.release();
  });

  it('merges a pre-existing duplicate phone before the index is created (the same-contact-two-jids bug)', async () => {
    const runner = ds.createQueryRunner();
    // Seed the exact shape of the pre-existing bug: same phone, two jids, one row richer than the
    // other — BEFORE the migration runs, same as this fix landing against already-broken live data.
    await insert(runner, {
      id: 'lid-row',
      sessionId: 's1',
      jid: '30378471473326@lid',
      phone: '919999367045',
      name: 'Alex Rivera',
      company: 'Unknown',
      updatedAt: '2026-09-05T10:00:00.000Z',
    });
    await insert(runner, {
      id: 'phone-row',
      sessionId: 's1',
      jid: '919999367045@c.us',
      phone: '919999367045',
      name: 'Alex Rivera',
      company: 'Acme',
      team: 'Sales',
      updatedAt: '2026-09-05T15:59:07.000Z',
    });

    const migration = new AddClientMappingPhoneUniqueness1786600000000();
    await migration.up(runner);

    const rows = (await runner.query(
      `SELECT "id", "jid", "company", "team", "aliasJids" FROM "client_mappings" WHERE "phone" = '919999367045'`,
    )) as Array<{ id: string; jid: string; company: string; team: string | null; aliasJids: string | null }>;

    // The richer row (real company/team, not the "Unknown" placeholder) survives...
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('phone-row');
    expect(rows[0].jid).toBe('919999367045@c.us');
    expect(rows[0].company).toBe('Acme');
    expect(rows[0].team).toBe('Sales');
    // ...and the deleted row's jid is not silently lost — it is remembered as an alias.
    const aliases = JSON.parse(rows[0].aliasJids as string) as string[];
    expect(aliases.sort()).toEqual(['30378471473326@lid', '919999367045@c.us'].sort());

    // Now that the duplicate is gone, the index enforces no new one can appear.
    await expect(
      insert(runner, { id: 'new-dup', sessionId: 's1', jid: '111@lid', phone: '919999367045' }),
    ).rejects.toThrow();

    await runner.release();
  });

  it('down() drops the index and the aliasJids column', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddClientMappingPhoneUniqueness1786600000000();
    await migration.up(runner);
    await migration.down(runner);

    // The index no longer blocks a duplicate phone...
    await insert(runner, { id: 'a', sessionId: 's1', jid: '1@c.us', phone: '1' });
    await expect(insert(runner, { id: 'b', sessionId: 's1', jid: '2@lid', phone: '1' })).resolves.toBeUndefined();

    // ...and the column is gone.
    const columns = (await runner.query(`PRAGMA table_info("client_mappings")`)) as Array<{ name: string }>;
    expect(columns.some(c => c.name === 'aliasJids')).toBe(false);

    await runner.release();
  });
});
