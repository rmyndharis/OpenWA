import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/** Adds the reusable-location snapshot shown in appointments and notifications. */
export class AddWorkflowSlotDetails1787700000000 implements MigrationInterface {
  name = 'AddWorkflowSlotDetails1787700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_appointment_slots'))) return;
    for (const name of ['instruction', 'responsible', 'mapsUrl']) {
      if (!(await queryRunner.hasColumn('workflow_appointment_slots', name))) {
        await queryRunner.addColumn(
          'workflow_appointment_slots',
          new TableColumn({ name, type: 'varchar', isNullable: true }),
        );
      }
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_appointment_slots'))) return;
    for (const name of ['mapsUrl', 'responsible', 'instruction']) {
      if (await queryRunner.hasColumn('workflow_appointment_slots', name)) {
        await queryRunner.dropColumn('workflow_appointment_slots', name);
      }
    }
  }
}
