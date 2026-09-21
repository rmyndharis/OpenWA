import { MigrationInterface, QueryRunner } from 'typeorm';

type StoredJson = string | Record<string, unknown> | Array<Record<string, unknown>> | null;

/** Normalizes CPF answers already stored by older releases to the digits-only persistence format. */
export class NormalizeWorkflowCpf1788710000000 implements MigrationInterface {
  name = 'NormalizeWorkflowCpf1788710000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('workflow_records')) || !(await queryRunner.hasTable('workflow_versions'))) return;
    const postgres = queryRunner.connection.options.type === 'postgres';
    const records = (await queryRunner.query(`
      SELECT r."id", r."data", v."fields"
      FROM "workflow_records" r
      LEFT JOIN "workflow_instances" i ON i."id" = r."instanceId"
      LEFT JOIN "workflow_versions" v ON v."id" = COALESCE(r."definitionVersionId", i."currentVersionId")
    `)) as Array<{ id: string; data: StoredJson; fields: StoredJson }>;

    for (const record of records) {
      const data = this.object(record.data);
      const cpfKeys = this.array(record.fields)
        .filter(field => field.type === 'cpf')
        .map(field =>
          typeof field.answerKey === 'string' ? field.answerKey : typeof field.id === 'string' ? field.id : '',
        )
        .filter(Boolean);
      let changed = false;
      for (const key of cpfKeys) {
        if (typeof data[key] !== 'string') continue;
        const digits = data[key].replace(/\D/g, '');
        if (digits.length !== 11 || digits === data[key]) continue;
        data[key] = digits;
        changed = true;
      }
      if (!changed) continue;
      await queryRunner.query(
        postgres
          ? 'UPDATE "workflow_records" SET "data" = $1 WHERE "id" = $2'
          : 'UPDATE "workflow_records" SET "data" = ? WHERE "id" = ?',
        [JSON.stringify(data), record.id],
      );
    }
  }

  async down(): Promise<void> {
    // Punctuation is presentation-only and cannot be reconstructed as original user input.
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
