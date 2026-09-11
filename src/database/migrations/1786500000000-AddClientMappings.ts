import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `client_mappings` — the client/teammate/group directory documented in docs/32.
 * `sessionId` is non-FK provenance (same reasoning as `conversation_mappings`): nullable so a
 * `kind='teammate'` row can omit it entirely, and a contact/group mapping should survive session
 * churn rather than cascade-deleting with it.
 */
export class AddClientMappings1786500000000 implements MigrationInterface {
  name = 'AddClientMappings1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('client_mappings')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const ts = isPostgres ? 'timestamp' : 'datetime';
    const now = isPostgres ? 'NOW()' : "(datetime('now'))";
    const boolTrue = isPostgres ? 'true' : '1';

    await queryRunner.query(
      `CREATE TABLE "client_mappings" (` +
        `"id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar, "jid" varchar NOT NULL, "kind" varchar NOT NULL, ` +
        `"name" varchar(200) NOT NULL, "phone" varchar(32), "company" varchar(200) NOT NULL, ` +
        `"team" varchar(100), "role" varchar(100), "timezone" varchar(64), ` +
        `"status" varchar(16) NOT NULL DEFAULT 'active', "backupOwnerId" varchar, ` +
        `"sentimentTracking" boolean NOT NULL DEFAULT ${boolTrue}, "notes" text, ` +
        `"createdAt" ${ts} NOT NULL DEFAULT ${now}, "updatedAt" ${ts} NOT NULL DEFAULT ${now})`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_client_mappings_sessionId" ON "client_mappings" ("sessionId")`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_client_mappings_session_jid_kind" ON "client_mappings" ("sessionId", "jid", "kind")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_client_mappings_session_jid_kind"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_client_mappings_sessionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "client_mappings"`);
  }
}
