import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

export class AddWorkflowRecordIngestEvents1790100000000 implements MigrationInterface {
  name = 'AddWorkflowRecordIngestEvents1790100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_instances')) || !(await queryRunner.hasTable('workflow_records')))
      throw new Error('AddWorkflowRecordIngestEvents requires workflow_instances and workflow_records');
    const postgres = queryRunner.connection.options.type === 'postgres';
    if (!(await queryRunner.hasTable('workflow_record_ingest_events'))) {
      await queryRunner.createTable(
        new Table({
          name: 'workflow_record_ingest_events',
          columns: [
            {
              name: 'id',
              type: 'varchar',
              isPrimary: true,
              default: postgres ? 'gen_random_uuid()::varchar' : undefined,
            },
            { name: 'instanceId', type: 'varchar' },
            { name: 'eventKey', type: 'varchar', length: '200' },
            { name: 'payloadHash', type: 'varchar', length: '64' },
            { name: 'recordId', type: 'varchar', isNullable: true },
            { name: 'versionNumber', type: 'integer', isNullable: true },
            { name: 'contactId', type: 'varchar' },
            {
              name: 'createdAt',
              type: postgres ? 'timestamp' : 'datetime',
              default: postgres ? 'now()' : "datetime('now')",
            },
            {
              name: 'updatedAt',
              type: postgres ? 'timestamp' : 'datetime',
              default: postgres ? 'now()' : "datetime('now')",
            },
          ],
          foreignKeys: [
            new TableForeignKey({
              name: 'FK_workflow_record_ingest_event_instance',
              columnNames: ['instanceId'],
              referencedTableName: 'workflow_instances',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            }),
            new TableForeignKey({
              name: 'FK_workflow_record_ingest_event_record',
              columnNames: ['recordId'],
              referencedTableName: 'workflow_records',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            }),
          ],
          indices: [
            new TableIndex({
              name: 'UQ_workflow_record_ingest_event_scope_key',
              columnNames: ['instanceId', 'eventKey'],
              isUnique: true,
            }),
          ],
        }),
      );
      return;
    }
    let table = await queryRunner.getTable('workflow_record_ingest_events');
    if (!table) return;
    const expectedColumns = [
      new TableColumn({ name: 'instanceId', type: 'varchar', isNullable: true }),
      new TableColumn({ name: 'eventKey', type: 'varchar', length: '200', isNullable: true }),
      new TableColumn({ name: 'payloadHash', type: 'varchar', length: '64', isNullable: true }),
      new TableColumn({ name: 'recordId', type: 'varchar', isNullable: true }),
      new TableColumn({ name: 'versionNumber', type: 'integer', isNullable: true }),
      new TableColumn({ name: 'contactId', type: 'varchar', isNullable: true }),
      new TableColumn({
        name: 'createdAt',
        type: postgres ? 'timestamp' : 'datetime',
        default: postgres ? 'now()' : "datetime('now')",
      }),
      new TableColumn({
        name: 'updatedAt',
        type: postgres ? 'timestamp' : 'datetime',
        default: postgres ? 'now()' : "datetime('now')",
      }),
    ];
    for (const column of expectedColumns)
      if (!table.findColumnByName(column.name)) await queryRunner.addColumn(table, column);
    table = (await queryRunner.getTable('workflow_record_ingest_events'))!;
    const requiredWithoutDefault = ['instanceId', 'eventKey', 'payloadHash', 'contactId'];
    const incompleteResult = (await queryRunner.query(
      `SELECT COUNT(*) AS "count" FROM "workflow_record_ingest_events" WHERE ${requiredWithoutDefault
        .map(column => `"${column}" IS NULL`)
        .join(' OR ')}`,
    )) as Array<{ count: number | string }>;
    const incompleteRows = Number(incompleteResult[0]?.count ?? 0);
    if (incompleteRows > 0)
      throw new Error(
        `workflow_record_ingest_events has ${incompleteRows} incomplete row(s); columns were repaired and data preserved, but values must be backfilled before constraints can be finalized`,
      );
    for (const columnName of requiredWithoutDefault) {
      const column = table.findColumnByName(columnName);
      if (column?.isNullable) {
        const requiredColumn = column.clone();
        requiredColumn.isNullable = false;
        await queryRunner.changeColumn(table, column, requiredColumn);
      }
    }
    table = (await queryRunner.getTable('workflow_record_ingest_events'))!;
    const addForeignKey = async (name: string, columnName: string, referencedTableName: string, onDelete: string) => {
      if (table!.foreignKeys.some(key => key.name === name)) return;
      await queryRunner.createForeignKey(
        table!,
        new TableForeignKey({
          name,
          columnNames: [columnName],
          referencedTableName,
          referencedColumnNames: ['id'],
          onDelete,
        }),
      );
    };
    await addForeignKey('FK_workflow_record_ingest_event_instance', 'instanceId', 'workflow_instances', 'CASCADE');
    await addForeignKey('FK_workflow_record_ingest_event_record', 'recordId', 'workflow_records', 'CASCADE');
    table = (await queryRunner.getTable('workflow_record_ingest_events'))!;
    if (!table.indices.some(index => index.name === 'UQ_workflow_record_ingest_event_scope_key'))
      await queryRunner.createIndex(
        table,
        new TableIndex({
          name: 'UQ_workflow_record_ingest_event_scope_key',
          columnNames: ['instanceId', 'eventKey'],
          isUnique: true,
        }),
      );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('workflow_record_ingest_events'))
      await queryRunner.dropTable('workflow_record_ingest_events', true);
  }
}
