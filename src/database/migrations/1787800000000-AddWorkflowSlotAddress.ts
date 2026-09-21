import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/** Keeps the written address used when an appointment slot was created. */
export class AddWorkflowSlotAddress1787800000000 implements MigrationInterface {
  name = 'AddWorkflowSlotAddress1787800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (
      (await queryRunner.hasTable('workflow_appointment_slots')) &&
      !(await queryRunner.hasColumn('workflow_appointment_slots', 'address'))
    ) {
      await queryRunner.addColumn(
        'workflow_appointment_slots',
        new TableColumn({ name: 'address', type: 'varchar', isNullable: true }),
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (
      (await queryRunner.hasTable('workflow_appointment_slots')) &&
      (await queryRunner.hasColumn('workflow_appointment_slots', 'address'))
    ) {
      await queryRunner.dropColumn('workflow_appointment_slots', 'address');
    }
  }
}
