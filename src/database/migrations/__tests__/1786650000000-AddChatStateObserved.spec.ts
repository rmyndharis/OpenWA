import { DataSource } from 'typeorm';
import { AddChatStates1786400000000 } from '../1786400000000-AddChatStates';
import { AddChatStateObserved1786650000000 } from '../1786650000000-AddChatStateObserved';

describe('AddChatStateObserved migration', () => {
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
    await new AddChatStates1786400000000().up(runner);
    await runner.query(`INSERT INTO "chat_states" ("sessionId", "chatId", "pinned") VALUES ('s1', '628@g.us', 1)`);
    const migration = new AddChatStateObserved1786650000000();

    await migration.up(runner);
    await migration.up(runner); // idempotent
    expect(await runner.query(`SELECT "observed", "pinned" FROM "chat_states"`)).toEqual([
      { observed: null, pinned: 1 },
    ]);

    await migration.down(runner);
    expect(await runner.hasColumn('chat_states', 'observed')).toBe(false);
    await runner.release();
  });

  it('is a no-op without the table', async () => {
    const runner = ds.createQueryRunner();
    await expect(new AddChatStateObserved1786650000000().up(runner)).resolves.toBeUndefined();
    await runner.release();
  });
});
