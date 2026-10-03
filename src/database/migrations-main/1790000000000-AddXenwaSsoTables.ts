import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * XenWA (XenAI Tech SSO + team access) tables on the main connection:
 *
 * - `xenwa_users`           — XenAI Tech accounts that signed in through SSO, each linked to one
 *                             managed API key.
 * - `xenwa_session_access`  — per-WhatsApp-account ownership and teammate grants (pending until the
 *                             invited email first signs in).
 * - `xenwa_sso_nonces`      — burned SSO token nonces (replay protection that survives a restart).
 *
 * Main is always SQLite. Idempotent (IF NOT EXISTS everywhere), so a run interrupted after part of
 * the DDL completes on the next boot. Additive only: no existing table is touched.
 */
export class AddXenwaSsoTables1790000000000 implements MigrationInterface {
  name = 'AddXenwaSsoTables1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "xenwa_users" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"externalId" varchar(64) NOT NULL, ` +
        `"email" varchar(254) NOT NULL, ` +
        `"name" varchar(200), ` +
        `"image" varchar(1024), ` +
        `"platformRole" varchar(32) NOT NULL DEFAULT ('client'), ` +
        `"apiKeyId" varchar(36), ` +
        `"apiKeyCipher" text, ` +
        `"lastLoginAt" datetime, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_xenwa_users_externalId" ON "xenwa_users" ("externalId")`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_xenwa_users_email" ON "xenwa_users" ("email")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_xenwa_users_apiKeyId" ON "xenwa_users" ("apiKeyId")`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "xenwa_session_access" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"sessionId" varchar(64) NOT NULL, ` +
        `"email" varchar(254) NOT NULL, ` +
        `"userId" varchar(36), ` +
        `"role" varchar(16) NOT NULL DEFAULT ('member'), ` +
        `"permissions" text, ` +
        `"grantedBy" varchar(64), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_xenwa_access_session_email" ON "xenwa_session_access" ("sessionId", "email")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_xenwa_access_sessionId" ON "xenwa_session_access" ("sessionId")`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_xenwa_access_email" ON "xenwa_session_access" ("email")`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_xenwa_access_userId" ON "xenwa_session_access" ("userId")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "xenwa_sso_nonces" (` +
        `"nonce" varchar(128) PRIMARY KEY NOT NULL, ` +
        `"expiresAt" datetime NOT NULL` +
        `)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_xenwa_sso_nonces_expiresAt" ON "xenwa_sso_nonces" ("expiresAt")`,
    );

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "xenwa_number_billing" (` +
        `"sessionId" varchar(64) PRIMARY KEY NOT NULL, ` +
        `"status" varchar(16) NOT NULL DEFAULT ('active'), ` +
        `"paidUntil" datetime NOT NULL, ` +
        `"lastChargedAt" datetime, ` +
        `"lastChargeCredits" integer NOT NULL DEFAULT (0), ` +
        `"lastChargeKey" varchar(128), ` +
        `"freeReason" varchar(32), ` +
        `"lastError" varchar(300), ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"updatedAt" datetime NOT NULL DEFAULT (datetime('now'))` +
        `)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_xenwa_billing_paidUntil" ON "xenwa_number_billing" ("paidUntil")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_billing_paidUntil"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "xenwa_number_billing"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_sso_nonces_expiresAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "xenwa_sso_nonces"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_access_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_access_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_access_sessionId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_access_session_email"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "xenwa_session_access"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_users_apiKeyId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_users_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_xenwa_users_externalId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "xenwa_users"`);
  }
}
