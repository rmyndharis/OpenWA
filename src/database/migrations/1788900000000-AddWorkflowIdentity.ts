import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner, Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

type StoredJson = string | Record<string, unknown> | Array<Record<string, unknown>> | null;

/** Creates a department-scoped person identity so one CPF can safely own multiple WhatsApp numbers. */
export class AddWorkflowIdentity1788900000000 implements MigrationInterface {
  name = 'AddWorkflowIdentity1788900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const postgres = queryRunner.connection.options.type === 'postgres';
    const dateType = postgres ? 'timestamp' : 'datetime';
    if (!(await queryRunner.hasTable('workflow_identities'))) {
      await queryRunner.createTable(
        new Table({
          name: 'workflow_identities',
          columns: [
            { name: 'id', type: 'varchar', isPrimary: true },
            { name: 'departmentId', type: 'varchar' },
            { name: 'cpf', type: 'varchar', isNullable: true },
            { name: 'createdAt', type: dateType, default: postgres ? 'now()' : "datetime('now')" },
            { name: 'updatedAt', type: dateType, default: postgres ? 'now()' : "datetime('now')" },
          ],
          foreignKeys: [
            {
              name: 'FK_workflow_identity_department',
              columnNames: ['departmentId'],
              referencedTableName: 'workflow_departments',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
          ],
          indices: [
            {
              name: 'UQ_workflow_identity_department_cpf',
              columnNames: ['departmentId', 'cpf'],
              isUnique: true,
            },
          ],
        }),
      );
    }
    if (!(await queryRunner.hasTable('workflow_identity_contacts'))) {
      await queryRunner.createTable(
        new Table({
          name: 'workflow_identity_contacts',
          columns: [
            { name: 'id', type: 'varchar', isPrimary: true },
            { name: 'departmentId', type: 'varchar' },
            { name: 'identityId', type: 'varchar' },
            { name: 'contactId', type: 'varchar' },
            { name: 'phone', type: 'varchar', isNullable: true },
            { name: 'verifiedAt', type: postgres ? dateType : 'text' },
            { name: 'createdAt', type: dateType, default: postgres ? 'now()' : "datetime('now')" },
            { name: 'updatedAt', type: dateType, default: postgres ? 'now()' : "datetime('now')" },
          ],
          foreignKeys: [
            {
              name: 'FK_workflow_identity_contact_department',
              columnNames: ['departmentId'],
              referencedTableName: 'workflow_departments',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
            {
              name: 'FK_workflow_identity_contact_identity',
              columnNames: ['identityId'],
              referencedTableName: 'workflow_identities',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
          ],
          indices: [
            {
              name: 'UQ_workflow_identity_contact_department_chat',
              columnNames: ['departmentId', 'contactId'],
              isUnique: true,
            },
            {
              name: 'UQ_workflow_identity_contact_department_phone',
              columnNames: ['departmentId', 'phone'],
              isUnique: true,
            },
          ],
        }),
      );
    }
    await this.addIdentityColumn(queryRunner, 'workflow_runs', 'FK_workflow_run_identity');
    await this.addIdentityColumn(queryRunner, 'workflow_records', 'FK_workflow_record_identity');

    const records = (await queryRunner.query(`
      SELECT r."id", r."contactId", r."phone", r."data", v."fields", i."departmentId"
      FROM "workflow_records" r
      INNER JOIN "workflow_instances" i ON i."id" = r."instanceId"
      LEFT JOIN "workflow_versions" v ON v."id" = COALESCE(r."definitionVersionId", i."currentVersionId")
    `)) as Array<{
      id: string;
      contactId: string;
      phone: string | null;
      data: StoredJson;
      fields: StoredJson;
      departmentId: string;
    }>;
    const identityByCpf = new Map<string, string>();
    const identityByContact = new Map<string, string>();
    const identityByPhone = new Map<string, string>();
    const now = new Date().toISOString();
    for (const record of records) {
      const cpf = this.recordCpf(record.data, record.fields);
      const phone = this.phone(record.phone || record.contactId);
      const cpfKey = cpf ? `${record.departmentId}:${cpf}` : '';
      const contactKey = `${record.departmentId}:${record.contactId}`;
      const phoneKey = phone ? `${record.departmentId}:${phone}` : '';
      let identityId =
        (cpfKey ? identityByCpf.get(cpfKey) : undefined) ??
        identityByContact.get(contactKey) ??
        (phoneKey ? identityByPhone.get(phoneKey) : undefined);
      if (!identityId) {
        identityId = randomUUID();
        await this.query(
          queryRunner,
          postgres,
          'INSERT INTO "workflow_identities" ("id", "departmentId", "cpf", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?)',
          [identityId, record.departmentId, cpf, now, now],
        );
      } else if (cpf) {
        await this.query(
          queryRunner,
          postgres,
          'UPDATE "workflow_identities" SET "cpf" = COALESCE("cpf", ?), "updatedAt" = ? WHERE "id" = ?',
          [cpf, now, identityId],
        );
      }
      if (cpfKey) identityByCpf.set(cpfKey, identityId);
      identityByContact.set(contactKey, identityId);
      if (phoneKey) identityByPhone.set(phoneKey, identityId);
      await this.query(queryRunner, postgres, 'UPDATE "workflow_records" SET "identityId" = ? WHERE "id" = ?', [
        identityId,
        record.id,
      ]);
      const existingContact = (await this.query(
        queryRunner,
        postgres,
        phone
          ? 'SELECT "id" FROM "workflow_identity_contacts" WHERE "departmentId" = ? AND ("contactId" = ? OR "phone" = ?)'
          : 'SELECT "id" FROM "workflow_identity_contacts" WHERE "departmentId" = ? AND "contactId" = ?',
        phone ? [record.departmentId, record.contactId, phone] : [record.departmentId, record.contactId],
      )) as Array<{ id: string }>;
      if (!existingContact.length)
        await this.query(
          queryRunner,
          postgres,
          'INSERT INTO "workflow_identity_contacts" ("id", "departmentId", "identityId", "contactId", "phone", "verifiedAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [randomUUID(), record.departmentId, identityId, record.contactId, phone, now, now, now],
        );
    }

    const runs = (await queryRunner.query('SELECT "id", "departmentId", "contactId" FROM "workflow_runs"')) as Array<{
      id: string;
      departmentId: string;
      contactId: string;
    }>;
    for (const run of runs) {
      const contacts = (await this.query(
        queryRunner,
        postgres,
        'SELECT "identityId" FROM "workflow_identity_contacts" WHERE "departmentId" = ? AND "contactId" = ?',
        [run.departmentId, run.contactId],
      )) as Array<{ identityId: string }>;
      if (contacts[0])
        await this.query(queryRunner, postgres, 'UPDATE "workflow_runs" SET "identityId" = ? WHERE "id" = ?', [
          contacts[0].identityId,
          run.id,
        ]);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('workflow_records', 'identityId'))
      await queryRunner.dropColumn('workflow_records', 'identityId');
    if (await queryRunner.hasColumn('workflow_runs', 'identityId'))
      await queryRunner.dropColumn('workflow_runs', 'identityId');
    if (await queryRunner.hasTable('workflow_identity_contacts'))
      await queryRunner.dropTable('workflow_identity_contacts');
    if (await queryRunner.hasTable('workflow_identities')) await queryRunner.dropTable('workflow_identities');
  }

  private async addIdentityColumn(queryRunner: QueryRunner, table: string, foreignKeyName: string): Promise<void> {
    if (!(await queryRunner.hasColumn(table, 'identityId')))
      await queryRunner.addColumn(table, new TableColumn({ name: 'identityId', type: 'varchar', isNullable: true }));
    const current = await queryRunner.getTable(table);
    if (!current?.foreignKeys.some(key => key.name === foreignKeyName))
      await queryRunner.createForeignKey(
        table,
        new TableForeignKey({
          name: foreignKeyName,
          columnNames: ['identityId'],
          referencedTableName: 'workflow_identities',
          referencedColumnNames: ['id'],
          onDelete: 'SET NULL',
        }),
      );
    if (!current?.indices.some(index => index.name === `IDX_${table}_identity`))
      await queryRunner.createIndex(
        table,
        new TableIndex({ name: `IDX_${table}_identity`, columnNames: ['identityId'] }),
      );
  }

  private async query(
    queryRunner: QueryRunner,
    postgres: boolean,
    sql: string,
    parameters: unknown[] = [],
  ): Promise<unknown> {
    if (!postgres) return (await queryRunner.query(sql, parameters)) as unknown;
    let index = 0;
    return (await queryRunner.query(
      sql.replace(/\?/g, () => `$${++index}`),
      parameters,
    )) as unknown;
  }

  private recordCpf(dataValue: StoredJson, fieldsValue: StoredJson): string | null {
    const data = this.object(dataValue);
    const keys = this.array(fieldsValue)
      .filter(field => field.type === 'cpf')
      .map(field =>
        typeof field.answerKey === 'string' ? field.answerKey : typeof field.id === 'string' ? field.id : '',
      )
      .filter(Boolean);
    for (const key of keys) {
      const rawValue = data[key];
      const digits = typeof rawValue === 'string' ? rawValue.replace(/\D/g, '') : '';
      if (digits.length === 11) return digits;
    }
    return null;
  }

  private phone(value: string | null): string | null {
    if (!value || value.endsWith('@lid')) return null;
    const digits = value.replace(/@.*$/, '').replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 13 ? digits : null;
  }

  private object(value: StoredJson): Record<string, unknown> {
    const parsed = this.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  private array(value: StoredJson): Array<Record<string, unknown>> {
    const parsed = this.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  }

  private parse(value: StoredJson): StoredJson {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value) as StoredJson;
    } catch {
      return null;
    }
  }
}
