import { MigrationInterface, QueryRunner } from 'typeorm';

/** Persists retryable candidate-to-interview-location proximity assessments. */
export class AddWorkflowCandidateProximity1788500000000 implements MigrationInterface {
  name = 'AddWorkflowCandidateProximity1788500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const date = pg ? 'timestamp' : 'text';
    if (!(await queryRunner.hasColumn('workflow_records', 'proximityStatus')))
      await queryRunner.query('ALTER TABLE "workflow_records" ADD COLUMN "proximityStatus" varchar');
    if (!(await queryRunner.hasColumn('workflow_records', 'proximityData')))
      await queryRunner.query('ALTER TABLE "workflow_records" ADD COLUMN "proximityData" text');
    if (!(await queryRunner.hasColumn('workflow_records', 'proximityAttempts')))
      await queryRunner.query(
        'ALTER TABLE "workflow_records" ADD COLUMN "proximityAttempts" integer NOT NULL DEFAULT 0',
      );
    if (!(await queryRunner.hasColumn('workflow_records', 'proximityNextAttemptAt')))
      await queryRunner.query(`ALTER TABLE "workflow_records" ADD COLUMN "proximityNextAttemptAt" ${date}`);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_workflow_record_proximity_due" ON "workflow_records" ("proximityStatus", "proximityNextAttemptAt")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_workflow_record_proximity_due"');
    for (const column of ['proximityNextAttemptAt', 'proximityAttempts', 'proximityData', 'proximityStatus']) {
      if (await queryRunner.hasColumn('workflow_records', column))
        await queryRunner.query(`ALTER TABLE "workflow_records" DROP COLUMN "${column}"`);
    }
  }
}
