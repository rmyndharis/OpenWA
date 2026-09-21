import { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds the interview phase to appointment slots while preserving existing schedules as phase one. */
export class AddWorkflowInterviewPhase1788700000000 implements MigrationInterface {
  name = 'AddWorkflowInterviewPhase1788700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('workflow_appointment_slots', 'interviewPhase')))
      await queryRunner.query(
        `ALTER TABLE "workflow_appointment_slots" ADD COLUMN "interviewPhase" varchar NOT NULL DEFAULT 'FASE_1_ENTREVISTA_SIMPLES'`,
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_appointment_slots', 'interviewPhase'))
      await queryRunner.query('ALTER TABLE "workflow_appointment_slots" DROP COLUMN "interviewPhase"');
  }
}
