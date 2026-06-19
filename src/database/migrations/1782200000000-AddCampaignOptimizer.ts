import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class AddCampaignOptimizer1782200000000 implements MigrationInterface {
  name = 'AddCampaignOptimizer1782200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('campaigns'))) {
      await queryRunner.createTable(
        new Table({
          name: 'campaigns',
          columns: [
            { name: 'id', type: 'varchar', isPrimary: true, generationStrategy: 'uuid', isGenerated: true },
            { name: 'sessionId', type: 'varchar' },
            { name: 'name', type: 'varchar', length: '200' },
            { name: 'enrollmentCount', type: 'integer', default: 0 },
            { name: 'completionRate', type: 'float', isNullable: true },
            { name: 'unsubscribeRate', type: 'float', isNullable: true },
            { name: 'replyRate', type: 'float', isNullable: true },
            { name: 'stepFunnel', type: 'text', isNullable: true },
            { name: 'steps', type: 'text', isNullable: true },
            { name: 'lastOptimizedEnrollmentCount', type: 'integer', default: 0 },
            { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
            { name: 'updatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
          ],
        }),
        true,
      );
      await queryRunner.createIndex(
        'campaigns',
        new TableIndex({ name: 'IDX_campaigns_sessionId', columnNames: ['sessionId'] }),
      );
    }

    if (!(await queryRunner.hasTable('campaign_optimizations'))) {
      await queryRunner.createTable(
        new Table({
          name: 'campaign_optimizations',
          columns: [
            { name: 'id', type: 'varchar', isPrimary: true, generationStrategy: 'uuid', isGenerated: true },
            { name: 'campaignId', type: 'varchar' },
            { name: 'insights', type: 'text' },
            { name: 'recommendations', type: 'text' },
            { name: 'abtestSuggestion', type: 'text', isNullable: true },
            { name: 'completionRate', type: 'float', isNullable: true },
            { name: 'unsubscribeRate', type: 'float', isNullable: true },
            { name: 'replyRate', type: 'float', isNullable: true },
            { name: 'generatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
          ],
        }),
        true,
      );
      await queryRunner.createIndex(
        'campaign_optimizations',
        new TableIndex({ name: 'IDX_campaign_optimizations_campaignId', columnNames: ['campaignId'] }),
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('campaign_optimizations', true);
    await queryRunner.dropTable('campaigns', true);
  }
}
