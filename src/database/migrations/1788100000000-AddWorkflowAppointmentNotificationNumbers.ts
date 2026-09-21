import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores the WhatsApp recipients notified about appointment lifecycle events for each flow. */
export class AddWorkflowAppointmentNotificationNumbers1788100000000 implements MigrationInterface {
  name = 'AddWorkflowAppointmentNotificationNumbers1788100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_instances', 'appointmentNotificationNumbers')) return;
    await queryRunner.query(
      `ALTER TABLE "workflow_instances" ADD COLUMN "appointmentNotificationNumbers" text NOT NULL DEFAULT '[]'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_instances', 'appointmentNotificationNumbers'))
      await queryRunner.query('ALTER TABLE "workflow_instances" DROP COLUMN "appointmentNotificationNumbers"');
  }
}
