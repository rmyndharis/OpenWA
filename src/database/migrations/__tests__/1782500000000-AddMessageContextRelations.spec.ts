import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AddMessageContextRelations1782500000000 } from '../1782500000000-AddMessageContextRelations';

describe('AddMessageContextRelations migration', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('creates idempotent typed quote/current-reaction tables and removes them on down', async () => {
    const runner = dataSource.createQueryRunner();
    const migration = new AddMessageContextRelations1782500000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();
    const quotes = await runner.getTable('message_quotes');
    const reactions = await runner.getTable('message_reactions');
    expect(quotes?.columns.map(column => column.name)).toEqual(
      expect.arrayContaining(['messageId', 'sessionId', 'quotedWaMessageId', 'body']),
    );
    expect(reactions?.primaryColumns.map(column => column.name)).toEqual(['messageId', 'senderId']);

    await runner.query(
      `INSERT INTO message_reactions (messageId, senderId, sessionId, emoji) VALUES ('m1', 'a@lid', 's1', '👍')`,
    );
    await expect(
      runner.query(
        `INSERT INTO message_reactions (messageId, senderId, sessionId, emoji) VALUES ('m1', 'a@lid', 's1', '🎉')`,
      ),
    ).rejects.toThrow();

    await migration.down(runner);
    expect(await runner.hasTable('message_quotes')).toBe(false);
    expect(await runner.hasTable('message_reactions')).toBe(false);
    await runner.release();
  });
});
