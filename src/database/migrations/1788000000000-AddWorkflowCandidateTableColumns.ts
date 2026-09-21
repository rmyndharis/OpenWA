import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores the shared candidate-table order and default visibility for a workflow department. */
export class AddWorkflowCandidateTableColumns1788000000000 implements MigrationInterface {
  name = 'AddWorkflowCandidateTableColumns1788000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_departments', 'candidateTableColumns')) return;
    await queryRunner.query(
      `ALTER TABLE "workflow_departments" ADD COLUMN "candidateTableColumns" text NOT NULL DEFAULT '[]'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_departments', 'candidateTableColumns'))
      await queryRunner.query('ALTER TABLE "workflow_departments" DROP COLUMN "candidateTableColumns"');
  }
}
