import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

export class HardenWorkflowHubRelations1787200000000 implements MigrationInterface {
  name = 'HardenWorkflowHubRelations1787200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.addForeignKey(queryRunner, 'workflow_instances', {
      name: 'FK_workflow_instance_current_version',
      columnNames: ['currentVersionId'],
      referencedTableName: 'workflow_versions',
      referencedColumnNames: ['id'],
      onDelete: 'SET NULL',
    });
    await this.addForeignKey(queryRunner, 'workflow_records', {
      name: 'FK_workflow_record_definition_version',
      columnNames: ['definitionVersionId'],
      referencedTableName: 'workflow_versions',
      referencedColumnNames: ['id'],
      onDelete: 'SET NULL',
    });
    await this.addForeignKey(queryRunner, 'workflow_appointment_slots', {
      name: 'FK_workflow_slot_held_run',
      columnNames: ['heldByRunId'],
      referencedTableName: 'workflow_runs',
      referencedColumnNames: ['id'],
      onDelete: 'SET NULL',
    });
    await this.addForeignKey(queryRunner, 'workflow_appointments', {
      name: 'FK_workflow_appointment_instance',
      columnNames: ['instanceId'],
      referencedTableName: 'workflow_instances',
      referencedColumnNames: ['id'],
      onDelete: 'CASCADE',
    });
    await this.addForeignKey(queryRunner, 'workflow_appointments', {
      name: 'FK_workflow_appointment_record',
      columnNames: ['recordId'],
      referencedTableName: 'workflow_records',
      referencedColumnNames: ['id'],
      onDelete: 'SET NULL',
    });

    await queryRunner.query(
      'UPDATE "workflow_appointment_slots" SET "bookedCount" = (SELECT COUNT(*) FROM "workflow_appointments" a WHERE a."slotId" = "workflow_appointment_slots"."id" AND a."status" = \'CONFIRMADO\')',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [tableName, names] of [
      ['workflow_appointments', ['FK_workflow_appointment_record', 'FK_workflow_appointment_instance']],
      ['workflow_appointment_slots', ['FK_workflow_slot_held_run']],
      ['workflow_records', ['FK_workflow_record_definition_version']],
      ['workflow_instances', ['FK_workflow_instance_current_version']],
    ] as Array<[string, string[]]>) {
      const table = await queryRunner.getTable(tableName);
      for (const name of names) {
        const key = table?.foreignKeys.find(item => item.name === name);
        if (key) await queryRunner.dropForeignKey(tableName, key);
      }
    }
  }

  private async addForeignKey(
    queryRunner: QueryRunner,
    tableName: string,
    options: ConstructorParameters<typeof TableForeignKey>[0],
  ): Promise<void> {
    const table = await queryRunner.getTable(tableName);
    if (!table || table.foreignKeys.some(key => key.name === options.name)) return;
    await queryRunner.createForeignKey(tableName, new TableForeignKey(options));
  }
}
