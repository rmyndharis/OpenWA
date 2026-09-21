import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWorkflowRecordMenu1787300000000 implements MigrationInterface {
  name = 'AddWorkflowRecordMenu1787300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_instances', 'recordMenu')) return;
    await queryRunner.query(`ALTER TABLE "workflow_instances" ADD COLUMN "recordMenu" text NOT NULL DEFAULT '{}'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_instances', 'recordMenu'))
      await queryRunner.query('ALTER TABLE "workflow_instances" DROP COLUMN "recordMenu"');
  }
}
