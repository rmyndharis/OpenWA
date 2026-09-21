import { MigrationInterface, QueryRunner } from 'typeorm';

/** Keeps appointment notifications linked to a location even when its display name changes. */
export class AddWorkflowAppointmentSlotLocationId1788800000000 implements MigrationInterface {
  name = 'AddWorkflowAppointmentSlotLocationId1788800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('workflow_appointment_slots', 'locationId')))
      await queryRunner.query('ALTER TABLE "workflow_appointment_slots" ADD COLUMN "locationId" varchar NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_appointment_slots', 'locationId'))
      await queryRunner.query('ALTER TABLE "workflow_appointment_slots" DROP COLUMN "locationId"');
  }
}
