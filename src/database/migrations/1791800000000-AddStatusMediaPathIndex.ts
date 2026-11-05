import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Partial index on `status_updates.mediaPath`, backing the status orphan sweep's per-chunk
 * `WHERE mediaPath IN (...)` lookup (status-store.service.ts). The column is NULL for every story without
 * stored media, so a full index over it would mostly index NULLs; the `WHERE mediaPath IS NOT NULL`
 * partial form keeps it to the rows that can ever match, on both SQLite and Postgres.
 *
 * Same reasoning as AddMessageMediaPathIndex: hand-authored because `synchronize` is off for the data
 * connection on PostgreSQL (and optional on SQLite). The explicit name matches the entity's @Index, so
 * the synchronize and migration schema paths converge on one index. Idempotent via IF NOT EXISTS
 * (supported by both dialects for indexes).
 */
export class AddStatusMediaPathIndex1791800000000 implements MigrationInterface {
  name = 'AddStatusMediaPathIndex1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Boot and CLI migrations run on a pool without the runtime statement_timeout (pg-boot-migrations.ts),
    // and MigrationExecutor wraps a lone pending migration in its own transaction, so lift any role- or
    // database-level default for this transaction only, exactly like AddMessageMediaPathIndex.
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_status_updates_mediaPath" ON "status_updates" ("mediaPath") WHERE "mediaPath" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_status_updates_mediaPath"`);
  }
}
