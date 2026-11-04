import { DataSource } from 'typeorm';
import { AddChatStates1786400000000 } from '../1786400000000-AddChatStates';
import { AddChatStateDeletedAt1791700000000 } from '../1791700000000-AddChatStateDeletedAt';

describe('AddChatStateDeletedAt migration', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('adds the column, keeps existing rows as null, and drops it with the rows it marked', async () => {
    const runner = ds.createQueryRunner();
    await new AddChatStates1786400000000().up(runner);
    await runner.query(`INSERT INTO "chat_states" ("sessionId", "chatId", "pinned") VALUES ('s1', '628@g.us', 1)`);
    const migration = new AddChatStateDeletedAt1791700000000();

    await migration.up(runner);
    await migration.up(runner); // idempotent
    expect(await runner.query(`SELECT "deletedAt", "pinned" FROM "chat_states"`)).toEqual([
      { deletedAt: null, pinned: 1 },
    ]);

    await runner.query(
      `INSERT INTO "chat_states" ("sessionId", "chatId", "deletedAt") VALUES ('s1', '628111@s.whatsapp.net', 1790000000000)`,
    );
    await migration.down(runner);
    expect(await runner.hasColumn('chat_states', 'deletedAt')).toBe(false);
    expect(await runner.query(`SELECT "chatId" FROM "chat_states"`)).toEqual([{ chatId: '628@g.us' }]);
    await runner.release();
  });

  it('is a no-op without the table', async () => {
    const runner = ds.createQueryRunner();
    await expect(new AddChatStateDeletedAt1791700000000().up(runner)).resolves.toBeUndefined();
    await expect(new AddChatStateDeletedAt1791700000000().down(runner)).resolves.toBeUndefined();
    await runner.release();
  });
});
