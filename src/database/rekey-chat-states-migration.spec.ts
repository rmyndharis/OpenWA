// NOTE: kept OUT of src/database/migrations/ on purpose: the TypeORM migrations glob
// (`migrations/*{.ts,.js}`) would otherwise load this spec as a migration under ts-node
// (the CLI datasource / start:dev) and crash on `describe`.
import { DataSource, QueryRunner } from 'typeorm';
import { ReKeyChatStatesBySessionId1786500000000 } from './migrations/1786500000000-ReKeyChatStatesBySessionId';

// A real SQLite database rather than a mocked query runner: this migration rewrites rows, so the
// statement itself is the thing under test.
describe('ReKeyChatStatesBySessionId migration', () => {
  const ALICE_ID = '8f5b1d9e-0c4a-4e21-9d6b-2a7c3f0e1b44';
  const BOB_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
  const migration = new ReKeyChatStatesBySessionId1786500000000();

  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], migrations: [] });
    await dataSource.initialize();
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY, "name" varchar NOT NULL UNIQUE)`);
    await queryRunner.query(
      `CREATE TABLE "chat_states" ("sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, "archived" boolean NOT NULL DEFAULT (0), PRIMARY KEY ("sessionId", "chatId"))`,
    );
    await queryRunner.query(
      `INSERT INTO sessions ("id", "name") VALUES ('${ALICE_ID}', 'alice'), ('${BOB_ID}', 'bob')`,
    );
  });

  afterEach(async () => {
    await queryRunner.release();
    await dataSource.destroy();
  });

  const states = (): Promise<Array<{ sessionId: string; chatId: string }>> =>
    queryRunner.query('SELECT "sessionId", "chatId" FROM chat_states ORDER BY "chatId", "sessionId"') as Promise<
      Array<{ sessionId: string; chatId: string }>
    >;

  it('moves every name-keyed row onto its session id', async () => {
    await queryRunner.query(
      `INSERT INTO chat_states ("sessionId", "chatId") VALUES ('alice', 'c1@c.us'), ('bob', 'c2@c.us')`,
    );

    await migration.up(queryRunner);

    expect(await states()).toEqual([
      { sessionId: ALICE_ID, chatId: 'c1@c.us' },
      { sessionId: BOB_ID, chatId: 'c2@c.us' },
    ]);
  });

  it('is idempotent: a second run leaves the already-migrated rows alone', async () => {
    await queryRunner.query(`INSERT INTO chat_states ("sessionId", "chatId") VALUES ('alice', 'c1@c.us')`);

    await migration.up(queryRunner);
    await migration.up(queryRunner);

    expect(await states()).toEqual([{ sessionId: ALICE_ID, chatId: 'c1@c.us' }]);
  });

  it('leaves rows of a deleted session untouched', async () => {
    await queryRunner.query(`INSERT INTO chat_states ("sessionId", "chatId") VALUES ('gone', 'c1@c.us')`);

    await migration.up(queryRunner);

    expect(await states()).toEqual([{ sessionId: 'gone', chatId: 'c1@c.us' }]);
  });

  it('skips a row whose target key is already taken instead of breaking the primary key', async () => {
    await queryRunner.query(
      `INSERT INTO chat_states ("sessionId", "chatId") VALUES ('alice', 'c1@c.us'), ('${ALICE_ID}', 'c1@c.us')`,
    );

    await expect(migration.up(queryRunner)).resolves.toBeUndefined();

    expect(await states()).toEqual([
      { sessionId: ALICE_ID, chatId: 'c1@c.us' },
      { sessionId: 'alice', chatId: 'c1@c.us' },
    ]);
  });

  it('is a no-op when chat_states does not exist yet (fresh database mid-bootstrap)', async () => {
    await queryRunner.query('DROP TABLE chat_states');

    await expect(migration.up(queryRunner)).resolves.toBeUndefined();
  });

  it('down() puts the rows back on the session name', async () => {
    await queryRunner.query(`INSERT INTO chat_states ("sessionId", "chatId") VALUES ('alice', 'c1@c.us')`);

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(await states()).toEqual([{ sessionId: 'alice', chatId: 'c1@c.us' }]);
  });
});
