import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores appointment dates and reschedule details in the immutable recruitment history. */
export class AddWorkflowRecruitmentEventMetadata1788400000000 implements MigrationInterface {
  name = 'AddWorkflowRecruitmentEventMetadata1788400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_recruitment_events', 'metadata')) return;
    await queryRunner.query(
      `ALTER TABLE "workflow_recruitment_events" ADD COLUMN "metadata" text NOT NULL DEFAULT '{}'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_recruitment_events', 'metadata'))
      await queryRunner.query('ALTER TABLE "workflow_recruitment_events" DROP COLUMN "metadata"');
  }
}
