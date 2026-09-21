import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWorkflowInterviewCapacity1787100000000 implements MigrationInterface {
  name = 'AddWorkflowInterviewCapacity1787100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('workflow_appointment_slots', 'capacity')))
      await queryRunner.query(
        'ALTER TABLE "workflow_appointment_slots" ADD COLUMN "capacity" integer NOT NULL DEFAULT 1',
      );
    if (!(await queryRunner.hasColumn('workflow_appointment_slots', 'bookedCount')))
      await queryRunner.query(
        'ALTER TABLE "workflow_appointment_slots" ADD COLUMN "bookedCount" integer NOT NULL DEFAULT 0',
      );
    if (!(await queryRunner.hasColumn('workflow_appointments', 'reminderSentAt'))) {
      const date = queryRunner.dataSource.options.type === 'postgres' ? 'timestamp' : 'text';
      await queryRunner.query(`ALTER TABLE "workflow_appointments" ADD COLUMN "reminderSentAt" ${date}`);
    }
    const appointmentTable = await queryRunner.getTable('workflow_appointments');
    if (appointmentTable?.indices.some(index => index.name === 'UQ_workflow_appointment_slot'))
      await queryRunner.query('DROP INDEX "UQ_workflow_appointment_slot"');
    if (!appointmentTable?.indices.some(index => index.name === 'UQ_workflow_appointment_slot_contact'))
      await queryRunner.query(
        'CREATE UNIQUE INDEX "UQ_workflow_appointment_slot_contact" ON "workflow_appointments" ("slotId", "contactId")',
      );
    await queryRunner.query(
      'UPDATE "workflow_appointment_slots" SET "bookedCount" = (SELECT COUNT(*) FROM "workflow_appointments" a WHERE a."slotId" = "workflow_appointment_slots"."id" AND a."status" = \'CONFIRMADO\')',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const appointmentTable = await queryRunner.getTable('workflow_appointments');
    if (appointmentTable?.indices.some(index => index.name === 'UQ_workflow_appointment_slot_contact'))
      await queryRunner.query('DROP INDEX "UQ_workflow_appointment_slot_contact"');
    // The former slot-only unique index cannot be restored after capacity allowed multiple people
    // in the same slot. Keeping the rows is safer than making rollback fail or delete appointments.
    if (await queryRunner.hasColumn('workflow_appointments', 'reminderSentAt'))
      await queryRunner.query('ALTER TABLE "workflow_appointments" DROP COLUMN "reminderSentAt"');
    if (await queryRunner.hasColumn('workflow_appointment_slots', 'bookedCount'))
      await queryRunner.query('ALTER TABLE "workflow_appointment_slots" DROP COLUMN "bookedCount"');
    if (await queryRunner.hasColumn('workflow_appointment_slots', 'capacity'))
      await queryRunner.query('ALTER TABLE "workflow_appointment_slots" DROP COLUMN "capacity"');
  }
}
