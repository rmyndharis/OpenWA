import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWorkflowDepartmentMessages1787400000000 implements MigrationInterface {
  name = 'AddWorkflowDepartmentMessages1787400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_departments', 'messages')) return;
    await queryRunner.query(`ALTER TABLE "workflow_departments" ADD COLUMN "messages" text NOT NULL DEFAULT '{}'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_departments', 'messages'))
      await queryRunner.query('ALTER TABLE "workflow_departments" DROP COLUMN "messages"');
  }
}
