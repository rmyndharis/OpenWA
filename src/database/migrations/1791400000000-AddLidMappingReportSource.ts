import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Distinguish engine mapping reports from cache-only phone lookups. Existing rows have mixed origins,
 * so they keep their display data but require a new mapping report before authorizing phone/LID aliases.
 */
export class AddLidMappingReportSource1791400000000 implements MigrationInterface {
  name = 'AddLidMappingReportSource1791400000000';

  async up(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasTable('lid_mappings')) || (await runner.hasColumn('lid_mappings', 'isReported'))) return;
    const initial = runner.dataSource.options.type === 'postgres' ? 'false' : '0';
    await runner.query(`ALTER TABLE "lid_mappings" ADD COLUMN "isReported" boolean NOT NULL DEFAULT ${initial}`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!(await runner.hasTable('lid_mappings')) || !(await runner.hasColumn('lid_mappings', 'isReported'))) return;
    // Older readers ignore origin, so an unreported positive must not become an indefinitely trusted row.
    await runner.query(
      `UPDATE "lid_mappings" SET "phone" = NULL, "sessionId" = NULL WHERE "isReported" = false AND "phone" IS NOT NULL`,
    );
    await runner.dropColumn('lid_mappings', 'isReported');
  }
}
