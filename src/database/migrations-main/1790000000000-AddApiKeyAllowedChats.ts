import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/** Adds chat-level API-key scoping without assuming a specific MAIN database driver. */
export class AddApiKeyAllowedChats1790000000000 implements MigrationInterface {
  name = 'AddApiKeyAllowedChats1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('api_keys');
    if (!table || table.findColumnByName('allowedChats')) return;

    await queryRunner.addColumn(table, new TableColumn({ name: 'allowedChats', type: 'text', isNullable: true }));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('api_keys');
    if (!table?.findColumnByName('allowedChats')) return;

    await queryRunner.dropColumn(table, 'allowedChats');
  }
}
