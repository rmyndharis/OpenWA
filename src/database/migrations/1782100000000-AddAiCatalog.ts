import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class AddAiCatalog1782100000000 implements MigrationInterface {
  name = 'AddAiCatalog1782100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('ai_catalog_items')) return;

    await queryRunner.createTable(
      new Table({
        name: 'ai_catalog_items',
        columns: [
          { name: 'id', type: 'varchar', isPrimary: true, generationStrategy: 'uuid', isGenerated: true },
          { name: 'sessionId', type: 'varchar' },
          { name: 'sku', type: 'varchar' },
          { name: 'name', type: 'varchar' },
          { name: 'description', type: 'text' },
          { name: 'price', type: 'float', isNullable: true },
          { name: 'currency', type: 'varchar', isNullable: true },
          { name: 'category', type: 'varchar', isNullable: true },
          { name: 'stock', type: 'varchar', isNullable: true },
          { name: 'attributes', type: 'text', isNullable: true },
          { name: 'embeddingJson', type: 'text', isNullable: true },
          { name: 'available', type: 'boolean', default: true },
          { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
          { name: 'updatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'ai_catalog_items',
      new TableIndex({ name: 'IDX_ai_catalog_items_sessionId', columnNames: ['sessionId'] }),
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('ai_catalog_items', true);
  }
}
