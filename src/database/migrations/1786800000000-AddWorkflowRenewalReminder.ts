import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWorkflowRenewalReminder1786800000000 implements MigrationInterface {
  name = 'AddWorkflowRenewalReminder1786800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_records', 'reminderSentAt')) return;
    const date = queryRunner.dataSource.options.type === 'postgres' ? 'timestamp' : 'text';
    await queryRunner.query(`ALTER TABLE "workflow_records" ADD COLUMN "reminderSentAt" ${date}`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_records', 'reminderSentAt'))
      await queryRunner.query('ALTER TABLE "workflow_records" DROP COLUMN "reminderSentAt"');
  }
}
