import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `api_keys` (auth) and `audit_logs` tables on the **main** connection.
 * The main connection was previously schema-managed only by
 * `synchronize: true`, with no migrations — so turning synchronize off would leave a
 * fresh install with no `api_keys` table and total auth failure at boot.
 *
 * This migration is what the `main` connection runs when `MAIN_DATABASE_SYNCHRONIZE=false`
 * (`migrationsRun: !synchronize`). The main DB is always SQLite (boot config). `IF NOT EXISTS`
 * makes it idempotent so it is also safe to adopt on a DB previously created by synchronize.
 */
export class CreateAuthAuditTables1779900000000 implements MigrationInterface {
  name = 'CreateAuthAuditTables1779900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "api_keys" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"name" varchar(100) NOT NULL, ` +
        `"keyHash" varchar(64) NOT NULL, ` +
        `"keyPrefix" varchar(12) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT ('operator'), ` +
        `"allowedIps" text, ` +
        `"allowedSessions" text, ` +
        `"isActive" boolean NOT NULL DEFAULT (1), ` +
        `"expiresAt" datetime, ` +
        `"lastUsedAt" datetime, ` +
        `"usageCount" integer NOT NULL DEFAULT (0), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_api_keys_keyHash" ON "api_keys" ("keyHash")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "audit_logs" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"action" varchar(50) NOT NULL, ` +
        `"severity" varchar(10) NOT NULL DEFAULT ('info'), ` +
        `"apiKeyId" varchar(36), ` +
        `"apiKeyName" varchar(100), ` +
        `"sessionId" varchar(36), ` +
        `"sessionName" varchar(100), ` +
        `"ipAddress" varchar(45), ` +
        `"userAgent" varchar(500), ` +
        `"method" varchar(10), ` +
        `"path" varchar(500), ` +
        `"statusCode" integer, ` +
        `"metadata" text, ` +
        `"errorMessage" text, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_apiKeyId" ON "audit_logs" ("apiKeyId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_sessionId" ON "audit_logs" ("sessionId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_createdAt" ON "audit_logs" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_createdAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_sessionId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_apiKeyId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_action"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_api_keys_keyHash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);
  }
}
