import { DataSource } from 'typeorm';
import { AddBaileysStoredMessagesSessionCreatedIdIndex1786800000000 } from '../1786800000000-AddBaileysStoredMessagesSessionCreatedIdIndex';

describe('AddBaileysStoredMessagesSessionCreatedIdIndex migration', () => {
  let ds: DataSource;
  const OLD = 'IDX_baileys_stored_messages_session_created';
  const NEW = 'IDX_baileys_stored_messages_session_created_id';

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    // The table and indexes as AddBaileysStoredMessages created them.
    await ds.query(
      `CREATE TABLE "baileys_stored_messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
        `"waMessageId" varchar NOT NULL, "serializedMessage" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
    );
    await ds.query(
      `CREATE UNIQUE INDEX "UQ_baileys_stored_messages_session_wamsg" ON "baileys_stored_messages" ("sessionId", "waMessageId")`,
    );
    await ds.query(`CREATE INDEX "${OLD}" ON "baileys_stored_messages" ("sessionId", "createdAt")`);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  const indexNames = async (): Promise<string[]> => {
    const rows = await ds.query<{ name: string }[]>(`PRAGMA index_list("baileys_stored_messages")`);
    return rows.map(r => r.name);
  };
  const plan = async (sql: string): Promise<string> =>
    (await ds.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${sql}`)).map(r => r.detail).join(' | ');

  // The cap trim's cutoff lookup (BaileysMessageStoreService.enforceLimit).
  const cutoffQuery =
    `SELECT "id", "createdAt" FROM "baileys_stored_messages" WHERE "sessionId" = 's1' ` +
    `ORDER BY "createdAt" DESC, "id" DESC LIMIT 1 OFFSET 5000`;

  it('replaces the (sessionId, createdAt) index with (sessionId, createdAt, id)', async () => {
    await new AddBaileysStoredMessagesSessionCreatedIdIndex1786800000000().up(ds.createQueryRunner());

    const names = await indexNames();
    expect(names).toContain(NEW);
    expect(names).not.toContain(OLD);
    const columns = await ds.query<{ name: string }[]>(`PRAGMA index_info("${NEW}")`);
    expect(columns.map(c => c.name)).toEqual(['sessionId', 'createdAt', 'id']);
  });

  it('drops the redundant unnamed (sessionId, createdAt) index a synchronized table carries', async () => {
    await ds.query(
      `CREATE INDEX "IDX_ae44b476c522450bd395615a7c" ON "baileys_stored_messages" ("sessionId", "createdAt")`,
    );

    await new AddBaileysStoredMessagesSessionCreatedIdIndex1786800000000().up(ds.createQueryRunner());

    expect(await indexNames()).not.toContain('IDX_ae44b476c522450bd395615a7c');
  });

  it('is idempotent, and down() restores the old index', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddBaileysStoredMessagesSessionCreatedIdIndex1786800000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();

    await migration.down(runner);
    await expect(migration.down(runner)).resolves.toBeUndefined();
    const names = await indexNames();
    expect(names).toContain(OLD);
    expect(names).not.toContain(NEW);
  });

  it('serves the cap cutoff from the index without a sort', async () => {
    // Baseline: the old index leaves the id tiebreak to a temp B-tree.
    expect(await plan(cutoffQuery)).toContain('TEMP B-TREE');

    await new AddBaileysStoredMessagesSessionCreatedIdIndex1786800000000().up(ds.createQueryRunner());

    const after = await plan(cutoffQuery);
    expect(after).toContain(`COVERING INDEX ${NEW}`);
    expect(after).not.toContain('TEMP B-TREE');
  });
});
