import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `browser_sessions` table on the main (auth/audit) SQLite connection so dashboard
 * logins exchange an API key once for an opaque server-side session bound to the underlying API key.
 */
export class CreateBrowserSessions1792000000000 implements MigrationInterface {
  name = 'CreateBrowserSessions1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "browser_sessions" (` +
        `"id" varchar PRIMARY KEY NOT NULL, ` +
        `"tokenHash" varchar(64) NOT NULL, ` +
        `"apiKeyId" varchar(36) NOT NULL, ` +
        `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
        `"expiresAt" datetime NOT NULL, ` +
        `"revokedAt" datetime` +
        `)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_browser_sessions_tokenHash" ON "browser_sessions" ("tokenHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_browser_sessions_apiKeyId" ON "browser_sessions" ("apiKeyId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_browser_sessions_expiresAt" ON "browser_sessions" ("expiresAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_browser_sessions_expiresAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_browser_sessions_apiKeyId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_browser_sessions_tokenHash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "browser_sessions"`);
  }
}
