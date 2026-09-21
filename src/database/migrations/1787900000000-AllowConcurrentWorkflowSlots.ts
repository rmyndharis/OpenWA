import { MigrationInterface, QueryRunner, TableIndex } from 'typeorm';

/** Allows independent meetings to share the same workflow date and time. */
export class AllowConcurrentWorkflowSlots1787900000000 implements MigrationInterface {
  name = 'AllowConcurrentWorkflowSlots1787900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_appointment_slots'))) return;
    const table = await queryRunner.getTable('workflow_appointment_slots');
    const index = table?.indices.find(item => item.name === 'UQ_workflow_slot_instance_start');
    if (index) await queryRunner.dropIndex(table!, index);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_appointment_slots'))) return;
    const table = await queryRunner.getTable('workflow_appointment_slots');
    if (table?.indices.some(item => item.name === 'UQ_workflow_slot_instance_start')) return;
    const duplicates: unknown = await queryRunner.query(
      'SELECT "instanceId", "startsAt" FROM "workflow_appointment_slots" GROUP BY "instanceId", "startsAt" HAVING COUNT(*) > 1 LIMIT 1',
    );
    if (Array.isArray(duplicates) && duplicates.length) {
      throw new Error('Não é possível restaurar a restrição antiga: existem reuniões simultâneas cadastradas.');
    }
    await queryRunner.createIndex(
      'workflow_appointment_slots',
      new TableIndex({
        name: 'UQ_workflow_slot_instance_start',
        columnNames: ['instanceId', 'startsAt'],
        isUnique: true,
      }),
    );
  }
}
