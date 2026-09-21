import { MigrationInterface, QueryRunner } from 'typeorm';

/** Prevents an older proximity request from overwriting a newer candidate/address calculation. */
export class AddWorkflowProximityRevision1788600000000 implements MigrationInterface {
  name = 'AddWorkflowProximityRevision1788600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('workflow_records', 'proximityRevision')))
      await queryRunner.query(
        'ALTER TABLE "workflow_records" ADD COLUMN "proximityRevision" integer NOT NULL DEFAULT 0',
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_records', 'proximityRevision'))
      await queryRunner.query('ALTER TABLE "workflow_records" DROP COLUMN "proximityRevision"');
  }
}
