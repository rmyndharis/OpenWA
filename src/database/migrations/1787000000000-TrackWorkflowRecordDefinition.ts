import { MigrationInterface, QueryRunner } from 'typeorm';

export class TrackWorkflowRecordDefinition1787000000000 implements MigrationInterface {
  name = 'TrackWorkflowRecordDefinition1787000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('workflow_records', 'definitionVersionId')))
      await queryRunner.query('ALTER TABLE "workflow_records" ADD COLUMN "definitionVersionId" varchar');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_records', 'definitionVersionId'))
      await queryRunner.query('ALTER TABLE "workflow_records" DROP COLUMN "definitionVersionId"');
  }
}
