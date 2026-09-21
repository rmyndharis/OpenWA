import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

/** Removes appointment answers that still reference slots removed by older releases. */
export class RepairRemovedWorkflowAppointmentReferences1787600000000 implements MigrationInterface {
  name = 'RepairRemovedWorkflowAppointmentReferences1787600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasTable('workflow_appointment_slots')) ||
      !(await queryRunner.hasTable('workflow_records')) ||
      !(await queryRunner.hasTable('workflow_record_versions'))
    )
      return;

    const removedRows = (await queryRunner.query(
      `SELECT "id" FROM "workflow_appointment_slots" WHERE "status" = 'REMOVIDO'`,
    )) as Array<{ id: string }>;
    const removedIds = new Set(removedRows.map(row => row.id));
    if (!removedIds.size) return;

    const postgres = queryRunner.connection.options.type === 'postgres';
    const records = (await queryRunner.query(
      'SELECT "id", "data", "currentVersion" FROM "workflow_records"',
    )) as Array<{ id: string; data: string | Record<string, unknown>; currentVersion: number }>;
    for (const record of records) {
      const stored = this.parseObject(record.data);
      const cleaned = Object.fromEntries(Object.entries(stored).filter(([, value]) => !removedIds.has(String(value))));
      if (Object.keys(cleaned).length === Object.keys(stored).length) continue;
      const nextVersion = Number(record.currentVersion) + 1;
      const updatedAt = new Date();
      const storedAt = postgres ? updatedAt : updatedAt.toISOString();
      const update = postgres
        ? 'UPDATE "workflow_records" SET "data" = $1, "currentVersion" = $2, "updatedAt" = $3 WHERE "id" = $4 AND "currentVersion" = $5'
        : 'UPDATE "workflow_records" SET "data" = ?, "currentVersion" = ?, "updatedAt" = ? WHERE "id" = ? AND "currentVersion" = ?';
      await queryRunner.query(update, [
        JSON.stringify(cleaned),
        nextVersion,
        storedAt,
        record.id,
        record.currentVersion,
      ]);
      const insert = postgres
        ? 'INSERT INTO "workflow_record_versions" ("id", "recordId", "versionNumber", "data", "source", "actorId", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7)'
        : 'INSERT INTO "workflow_record_versions" ("id", "recordId", "versionNumber", "data", "source", "actorId", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)';
      await queryRunner.query(insert, [
        randomUUID(),
        record.id,
        nextVersion,
        JSON.stringify(cleaned),
        'REMOVED_APPOINTMENT_REFERENCE_REPAIR',
        null,
        storedAt,
      ]);
    }

    if (!(await queryRunner.hasTable('workflow_runs'))) return;
    const runs = (await queryRunner.query('SELECT "id", "draft" FROM "workflow_runs"')) as Array<{
      id: string;
      draft: string | Record<string, unknown>;
    }>;
    for (const run of runs) {
      const stored = this.parseObject(run.draft);
      const cleaned = Object.fromEntries(Object.entries(stored).filter(([, value]) => !removedIds.has(String(value))));
      if (Object.keys(cleaned).length === Object.keys(stored).length) continue;
      await queryRunner.query(
        postgres
          ? 'UPDATE "workflow_runs" SET "draft" = $1, "updatedAt" = $2 WHERE "id" = $3'
          : 'UPDATE "workflow_runs" SET "draft" = ?, "updatedAt" = ? WHERE "id" = ?',
        [JSON.stringify(cleaned), postgres ? new Date() : new Date().toISOString(), run.id],
      );
    }
  }

  async down(): Promise<void> {
    // Removed appointment references are invalid and cannot be restored safely.
  }

  private parseObject(value: string | Record<string, unknown>): Record<string, unknown> {
    if (typeof value !== 'string') return value ?? {};
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}
