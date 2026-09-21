import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

type ColumnKind = 'required' | 'safe' | 'optional';

interface ExpectedColumn {
  column: TableColumn;
  kind: ColumnKind;
  backfill?: string;
}

interface ExpectedIndex {
  name: string;
  columnNames: string[];
  isUnique: boolean;
}

interface ExpectedForeignKey {
  name: string;
  columnNames: string[];
  referencedTableName: string;
  referencedColumnNames: string[];
  onDelete: string;
}

/** Separates future-opportunity registrations from active recruitment applications. */
export class AddWorkflowTalentPool1789100000000 implements MigrationInterface {
  name = 'AddWorkflowTalentPool1789100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_instances')) || !(await queryRunner.hasTable('workflow_records')))
      throw new Error('Migration 178910 requires workflow_instances and workflow_records tables to exist');

    const hasEntries = await queryRunner.hasTable('workflow_talent_pool_entries');
    const hasEvents = await queryRunner.hasTable('workflow_talent_pool_events');
    if (!hasEntries && hasEvents)
      throw new Error(
        'Invalid state: workflow_talent_pool_events exists without workflow_talent_pool_entries; data was preserved',
      );

    if (!hasEntries) await queryRunner.createTable(this.entriesTable(queryRunner));
    else await this.repairEntries(queryRunner);

    if (!hasEvents) await queryRunner.createTable(this.eventsTable(queryRunner));
    else await this.repairEvents(queryRunner);
  }

  private isPostgres(queryRunner: QueryRunner): boolean {
    return queryRunner.connection.options.type === 'postgres';
  }

  private dateType(queryRunner: QueryRunner): 'timestamp' | 'text' {
    return this.isPostgres(queryRunner) ? 'timestamp' : 'text';
  }

  private nowDefault(queryRunner: QueryRunner): string {
    return this.isPostgres(queryRunner) ? 'now()' : "datetime('now')";
  }

  private idColumn(queryRunner: QueryRunner): TableColumn {
    return new TableColumn({
      name: 'id',
      type: 'varchar',
      isPrimary: true,
      isNullable: false,
      default: this.isPostgres(queryRunner) ? 'gen_random_uuid()::varchar' : undefined,
    });
  }

  private entriesTable(queryRunner: QueryRunner): Table {
    return new Table({
      name: 'workflow_talent_pool_entries',
      columns: this.entryColumns(queryRunner).map(({ column }) => column),
      indices: this.entryIndexes().map(definition => new TableIndex(definition)),
      foreignKeys: this.entryForeignKeys().map(definition => new TableForeignKey(definition)),
    });
  }

  private eventsTable(queryRunner: QueryRunner): Table {
    return new Table({
      name: 'workflow_talent_pool_events',
      columns: this.eventColumns(queryRunner).map(({ column }) => column),
      indices: this.eventIndexes().map(definition => new TableIndex(definition)),
      foreignKeys: this.eventForeignKeys().map(definition => new TableForeignKey(definition)),
    });
  }

  private entryColumns(queryRunner: QueryRunner): ExpectedColumn[] {
    const now = this.nowDefault(queryRunner);
    const dateType = this.dateType(queryRunner);
    return [
      { column: this.idColumn(queryRunner), kind: 'required' },
      { column: new TableColumn({ name: 'instanceId', type: 'varchar' }), kind: 'required' },
      { column: new TableColumn({ name: 'recordId', type: 'varchar' }), kind: 'required' },
      { column: new TableColumn({ name: 'contactId', type: 'varchar' }), kind: 'required' },
      {
        column: new TableColumn({ name: 'status', type: 'varchar', default: "'DISPONIVEL'" }),
        kind: 'safe',
        backfill: "'DISPONIVEL'",
      },
      { column: new TableColumn({ name: 'owner', type: 'varchar', isNullable: true }), kind: 'optional' },
      { column: new TableColumn({ name: 'convertedAt', type: dateType, isNullable: true }), kind: 'optional' },
      {
        column: new TableColumn({ name: 'version', type: 'integer', default: 1 }),
        kind: 'safe',
        backfill: '1',
      },
      {
        column: new TableColumn({ name: 'createdAt', type: dateType, default: now }),
        kind: 'safe',
        backfill: now,
      },
      {
        column: new TableColumn({ name: 'updatedAt', type: dateType, default: now }),
        kind: 'safe',
        backfill: now,
      },
    ];
  }

  private eventColumns(queryRunner: QueryRunner): ExpectedColumn[] {
    const now = this.nowDefault(queryRunner);
    return [
      { column: this.idColumn(queryRunner), kind: 'required' },
      { column: new TableColumn({ name: 'entryId', type: 'varchar' }), kind: 'required' },
      { column: new TableColumn({ name: 'type', type: 'varchar', length: '40' }), kind: 'required' },
      { column: new TableColumn({ name: 'fromStatus', type: 'varchar', isNullable: true }), kind: 'optional' },
      { column: new TableColumn({ name: 'toStatus', type: 'varchar', isNullable: true }), kind: 'optional' },
      { column: new TableColumn({ name: 'actorId', type: 'varchar', isNullable: true }), kind: 'optional' },
      { column: new TableColumn({ name: 'note', type: 'text', isNullable: true }), kind: 'optional' },
      {
        column: new TableColumn({ name: 'createdAt', type: this.dateType(queryRunner), default: now }),
        kind: 'safe',
        backfill: now,
      },
    ];
  }

  private entryIndexes(): ExpectedIndex[] {
    return [
      { name: 'UQ_workflow_talent_pool_record', columnNames: ['recordId'], isUnique: true },
      {
        name: 'IDX_workflow_talent_pool_instance_status',
        columnNames: ['instanceId', 'status'],
        isUnique: false,
      },
    ];
  }

  private eventIndexes(): ExpectedIndex[] {
    return [
      {
        name: 'IDX_workflow_talent_pool_event_entry_created',
        columnNames: ['entryId', 'createdAt'],
        isUnique: false,
      },
    ];
  }

  private entryForeignKeys(): ExpectedForeignKey[] {
    return [
      {
        name: 'FK_workflow_talent_pool_instance',
        columnNames: ['instanceId'],
        referencedTableName: 'workflow_instances',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
      {
        name: 'FK_workflow_talent_pool_record',
        columnNames: ['recordId'],
        referencedTableName: 'workflow_records',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
    ];
  }

  private eventForeignKeys(): ExpectedForeignKey[] {
    return [
      {
        name: 'FK_workflow_talent_pool_event_entry',
        columnNames: ['entryId'],
        referencedTableName: 'workflow_talent_pool_entries',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
    ];
  }

  private async repairEntries(queryRunner: QueryRunner): Promise<void> {
    let table = await this.table(queryRunner, 'workflow_talent_pool_entries');
    this.assertPrimaryKey(table);
    table = await this.ensureColumns(queryRunner, table, this.entryColumns(queryRunner));
    table = await this.ensureIndexes(queryRunner, table, this.entryIndexes());
    await this.ensureForeignKeys(queryRunner, table, this.entryForeignKeys());
  }

  private async repairEvents(queryRunner: QueryRunner): Promise<void> {
    let table = await this.table(queryRunner, 'workflow_talent_pool_events');
    this.assertPrimaryKey(table);
    table = await this.ensureColumns(queryRunner, table, this.eventColumns(queryRunner));
    table = await this.ensureIndexes(queryRunner, table, this.eventIndexes());
    await this.ensureForeignKeys(queryRunner, table, this.eventForeignKeys());
  }

  private async table(queryRunner: QueryRunner, name: string): Promise<Table> {
    const table = await queryRunner.getTable(name);
    if (!table) throw new Error('Table ' + name + ' disappeared during migration repair');
    return table;
  }

  private assertPrimaryKey(table: Table): void {
    const primaryColumns = table.columns.filter(column => column.isPrimary).map(column => column.name);
    if (primaryColumns.length === 0) throw new Error('Table ' + table.name + ' has no primary key; data was preserved');
    if (primaryColumns.length !== 1 || primaryColumns[0] !== 'id')
      throw new Error(
        'Table ' +
          table.name +
          ' has divergent primary key (' +
          primaryColumns.join(', ') +
          '); expected only id; data was preserved',
      );
    const id = table.findColumnByName('id');
    if (!id || id.type.toLowerCase() !== 'varchar')
      throw new Error('Table ' + table.name + ' primary key id must be varchar; data was preserved');
  }

  private async ensureColumns(
    queryRunner: QueryRunner,
    initialTable: Table,
    expectedColumns: ExpectedColumn[],
  ): Promise<Table> {
    let table = initialTable;
    for (const expected of expectedColumns) {
      let existing = table.findColumnByName(expected.column.name);
      if (!existing) {
        const added = expected.column.clone();
        added.isPrimary = false;
        added.isNullable = true;
        await queryRunner.addColumn(table, added);
        table = await this.table(queryRunner, table.name);
        existing = table.findColumnByName(expected.column.name);
      }
      if (!existing)
        throw new Error(
          table.name + '.' + expected.column.name + ' disappeared after column metadata reload; data was preserved',
        );

      if (expected.kind === 'safe' && expected.backfill)
        await queryRunner.query(
          'UPDATE "' +
            table.name +
            '" SET "' +
            expected.column.name +
            '" = ' +
            expected.backfill +
            ' WHERE "' +
            expected.column.name +
            '" IS NULL',
        );

      if (expected.kind === 'required' && existing.isNullable) {
        const nullRows = await this.count(
          queryRunner,
          'SELECT COUNT(*) AS "count" FROM "' + table.name + '" WHERE "' + expected.column.name + '" IS NULL',
        );
        if (nullRows > 0)
          throw new Error(
            table.name +
              '.' +
              expected.column.name +
              ' is required but ' +
              nullRows +
              ' existing row(s) need a backfill; column was added nullable and data was preserved',
          );
      }

      const desired = expected.column.clone();
      desired.isPrimary = existing.isPrimary;
      if (this.columnNeedsChange(existing, desired)) {
        await queryRunner.changeColumn(table, existing, desired);
        table = await this.table(queryRunner, table.name);
      }
    }
    return table;
  }

  private columnNeedsChange(existing: TableColumn, desired: TableColumn): boolean {
    return (
      existing.type.toLowerCase() !== desired.type.toLowerCase() ||
      existing.isNullable !== desired.isNullable ||
      (existing.length || '') !== (desired.length || '') ||
      this.normalizeDefault(existing.default) !== this.normalizeDefault(desired.default)
    );
  }

  private normalizeDefault(value: unknown): string {
    if (value === undefined || value === null) return '';
    let normalized: string;
    if (typeof value === 'string') {
      normalized = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      normalized = String(value);
    } else {
      try {
        normalized = JSON.stringify(value);
      } catch {
        normalized = Object.prototype.toString.call(value);
      }
    }
    normalized = normalized.trim().toLowerCase().replace(/\s+/g, ' ');
    while (normalized.startsWith('(') && normalized.endsWith(')')) normalized = normalized.slice(1, -1).trim();
    return normalized;
  }

  private sameColumns(actual: string[], expected: string[]): boolean {
    return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
  }

  private async ensureIndexes(
    queryRunner: QueryRunner,
    initialTable: Table,
    expectedIndexes: ExpectedIndex[],
  ): Promise<Table> {
    let table = initialTable;
    for (const expected of expectedIndexes) {
      const existing = table.indices.find(index => index.name === expected.name);
      const isCorrect =
        !!existing &&
        existing.isUnique === expected.isUnique &&
        this.sameColumns(existing.columnNames, expected.columnNames);
      if (isCorrect) continue;

      if (expected.isUnique) {
        const quotedColumns = expected.columnNames.map(column => '"' + column + '"').join(', ');
        const duplicates = await this.count(
          queryRunner,
          'SELECT COUNT(*) AS "count" FROM (SELECT 1 FROM "' +
            table.name +
            '" GROUP BY ' +
            quotedColumns +
            ' HAVING COUNT(*) > 1) duplicates',
        );
        if (duplicates > 0)
          throw new Error(
            'Cannot install index ' +
              expected.name +
              ': ' +
              duplicates +
              ' duplicate key group(s) exist; existing index and data were preserved',
          );
      }

      if (existing) {
        await queryRunner.dropIndex(table, existing);
        table = await this.table(queryRunner, table.name);
      }
      await queryRunner.createIndex(table, new TableIndex(expected));
      table = await this.table(queryRunner, table.name);
    }
    return table;
  }

  private async ensureForeignKeys(
    queryRunner: QueryRunner,
    initialTable: Table,
    expectedForeignKeys: ExpectedForeignKey[],
  ): Promise<Table> {
    let table = initialTable;
    for (const expected of expectedForeignKeys) {
      const existing = table.foreignKeys.find(foreignKey => foreignKey.name === expected.name);
      const isCorrect =
        !!existing &&
        this.sameColumns(existing.columnNames, expected.columnNames) &&
        existing.referencedTableName === expected.referencedTableName &&
        this.sameColumns(existing.referencedColumnNames, expected.referencedColumnNames) &&
        (existing.onDelete || '').toUpperCase() === expected.onDelete;
      if (isCorrect) continue;

      const childColumn = expected.columnNames[0];
      const parentColumn = expected.referencedColumnNames[0];
      const orphans = await this.count(
        queryRunner,
        'SELECT COUNT(*) AS "count" FROM "' +
          table.name +
          '" child ' +
          'LEFT JOIN "' +
          expected.referencedTableName +
          '" parent ON child."' +
          childColumn +
          '" = parent."' +
          parentColumn +
          '" ' +
          'WHERE child."' +
          childColumn +
          '" IS NOT NULL AND parent."' +
          parentColumn +
          '" IS NULL',
      );
      if (orphans > 0)
        throw new Error(
          'Cannot install foreign key ' +
            expected.name +
            ': ' +
            orphans +
            ' orphan row(s) exist; existing constraint and data were preserved',
        );

      if (existing) {
        await queryRunner.dropForeignKey(table, existing);
        table = await this.table(queryRunner, table.name);
      }
      await queryRunner.createForeignKey(table, new TableForeignKey(expected));
      table = await this.table(queryRunner, table.name);
    }
    return table;
  }

  private async count(queryRunner: QueryRunner, sql: string): Promise<number> {
    const result = (await queryRunner.query(sql)) as Array<{ count: number | string }>;
    return Number(result[0]?.count ?? 0);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('workflow_talent_pool_events'))
      await queryRunner.dropTable('workflow_talent_pool_events', true);
    if (await queryRunner.hasTable('workflow_talent_pool_entries'))
      await queryRunner.dropTable('workflow_talent_pool_entries', true);
  }
}
