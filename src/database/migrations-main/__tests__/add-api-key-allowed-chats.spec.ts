import { DataSource } from 'typeorm';
import { CreateAuthAuditTables1779900000000 } from '../1779900000000-CreateAuthAuditTables';
import { AddApiKeyAllowedChats1790000000000 } from '../1790000000000-AddApiKeyAllowedChats';

describe('AddApiKeyAllowedChats migration', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
  });

  afterEach(async () => dataSource.destroy());

  it('preserves existing rows across repeatable up/down operations', async () => {
    const queryRunner = dataSource.createQueryRunner();
    await new CreateAuthAuditTables1779900000000().up(queryRunner);
    await queryRunner.query(`INSERT INTO "api_keys" ("id", "name", "keyHash", "keyPrefix") VALUES (?, ?, ?, ?)`, [
      'existing-id',
      'Existing key',
      'existing-hash',
      'existing-pref',
    ]);
    const migration = new AddApiKeyAllowedChats1790000000000();

    await migration.up(queryRunner);
    await expect(migration.up(queryRunner)).resolves.not.toThrow();
    expect((await queryRunner.getTable('api_keys'))?.findColumnByName('allowedChats')?.isNullable).toBe(true);
    expect(await queryRunner.query(`SELECT "id", "allowedChats" FROM "api_keys"`)).toEqual([
      { id: 'existing-id', allowedChats: null },
    ]);

    await queryRunner.query(`UPDATE "api_keys" SET "allowedChats" = ? WHERE "id" = ?`, [
      '5511999990000@c.us',
      'existing-id',
    ]);
    await migration.down(queryRunner);
    await expect(migration.down(queryRunner)).resolves.not.toThrow();
    expect((await queryRunner.getTable('api_keys'))?.findColumnByName('allowedChats')).toBeUndefined();
    expect(await queryRunner.query(`SELECT "id", "name" FROM "api_keys"`)).toEqual([
      { id: 'existing-id', name: 'Existing key' },
    ]);
    await queryRunner.release();
  });
});
