import { MigrationInterface, QueryRunner, Table } from 'typeorm';

export class AddSessionPool1782000000000 implements MigrationInterface {
  name = 'AddSessionPool1782000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'session_pools',
        columns: [
          { name: 'id', type: 'varchar', isPrimary: true, generationStrategy: 'uuid', isGenerated: true },
          { name: 'name', type: 'varchar', length: '100' },
          { name: 'targetStandbyCount', type: 'integer', default: 1 },
          { name: 'productionSessionIds', type: 'text', default: "'[]'" },
          { name: 'standbySessionIds', type: 'text', default: "'[]'" },
          { name: 'autoFailover', type: 'boolean', default: true },
          { name: 'standbyWarmupSeconds', type: 'integer', default: 60 },
          { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
        ],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('session_pools');
  }
}
