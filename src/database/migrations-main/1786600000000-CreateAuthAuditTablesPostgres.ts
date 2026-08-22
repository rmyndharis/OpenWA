import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Postgres twin of CreateAuthAuditTables: the `api_keys` and `audit_logs` schema for
 * MAIN_DATABASE_TYPE=postgres — the mode every multi-node deployment needs, because per-node
 * SQLite files mean per-node API-key stores and forwarded requests failing auth.
 *
 * `IF NOT EXISTS` keeps it idempotent, so it also adopts a database an earlier synchronize (or a
 * manual restore) created. On SQLite this is a recorded no-op, mirroring how the SQLite migration
 * no-ops on Postgres.
 */
export class CreateAuthAuditTablesPostgres1786600000000 implements MigrationInterface {
  name = 'CreateAuthAuditTablesPostgres1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "api_keys" (` +
        `"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), ` +
        `"name" varchar(100) NOT NULL, ` +
        `"keyHash" varchar(64) NOT NULL, ` +
        `"keyPrefix" varchar(12) NOT NULL, ` +
        `"role" varchar(20) NOT NULL DEFAULT 'operator', ` +
        `"allowedIps" text, ` +
        `"allowedSessions" text, ` +
        `"isActive" boolean NOT NULL DEFAULT true, ` +
        `"expiresAt" timestamp, ` +
        `"lastUsedAt" timestamp, ` +
        `"usageCount" integer NOT NULL DEFAULT 0, ` +
        `"createdAt" timestamp NOT NULL DEFAULT now(), ` +
        `"updatedAt" timestamp NOT NULL DEFAULT now()` +
        `)`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_api_keys_keyHash" ON "api_keys" ("keyHash")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "audit_logs" (` +
        `"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), ` +
        `"action" varchar(50) NOT NULL, ` +
        `"severity" varchar(10) NOT NULL DEFAULT 'info', ` +
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
        `"createdAt" timestamp NOT NULL DEFAULT now()` +
        `)`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_apiKeyId" ON "audit_logs" ("apiKeyId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_sessionId" ON "audit_logs" ("sessionId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_createdAt" ON "audit_logs" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);
  }
}
