import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores event subscriptions and structured phone parts for each appointment notification recipient. */
export class AddWorkflowAppointmentNotifications1788200000000 implements MigrationInterface {
  name = 'AddWorkflowAppointmentNotifications1788200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_instances', 'appointmentNotifications')) return;
    await queryRunner.query(
      `ALTER TABLE "workflow_instances" ADD COLUMN "appointmentNotifications" text NOT NULL DEFAULT '[]'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_instances', 'appointmentNotifications'))
      await queryRunner.query('ALTER TABLE "workflow_instances" DROP COLUMN "appointmentNotifications"');
  }
}
