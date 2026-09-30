import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the indexes synchronize created under TypeORM's generated names on a main.sqlite built
 * before the main connection ran migrations by default.
 *
 * Adopting such a file runs CreateAuthAuditTables1779900000000, whose `CREATE INDEX IF NOT EXISTS`
 * adds the same indexes again under their migration names, leaving two indexes on api_keys.keyHash
 * and on four audit_logs columns: every audit insert maintained both. The migration-named ones
 * stay; on a file the chain built, none of these exist and each DROP is a no-op.
 *
 * CreateAuthAuditTables may already be recorded on a file whose indexes a later synchronize boot
 * replaced with generated names, so it will not run again. up() therefore creates the
 * migration-named indexes itself before dropping anything, so no column is left unindexed. The
 * unique one cannot fail on duplicate keys: the generated unique index still holds at that point.
 *
 * down() does not recreate them: they were only ever duplicates.
 */
export class DropSynchronizeIndexDuplicates1786610000000 implements MigrationInterface {
  name = 'DropSynchronizeIndexDuplicates1786610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_api_keys_keyHash" ON "api_keys" ("keyHash")`);
    for (const column of ['action', 'apiKeyId', 'sessionId', 'createdAt']) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_${column}" ON "audit_logs" ("${column}")`);
    }
    for (const index of [
      'IDX_df3b25181df0b4b59bd93f16e1', // api_keys (keyHash), unique
      'IDX_cee5459245f652b75eb2759b4c', // audit_logs (action)
      'IDX_741fa976d1e04e695f3aa23cb8', // audit_logs (apiKeyId)
      'IDX_dd2b6e43c767b6b5b2bb227ace', // audit_logs (sessionId)
      'IDX_c69efb19bf127c97e6740ad530', // audit_logs (createdAt)
    ]) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${index}"`);
    }
  }

  public async down(): Promise<void> {
    // Nothing to restore.
  }
}
