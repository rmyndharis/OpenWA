import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `translation_groups` (per-session, per-group translation config).
 * Hand-authored because `synchronize` is disabled for the `data` connection on
 * PostgreSQL (and may be on SQLite via DATABASE_SYNCHRONIZE=false).
 */
export class AddTranslationGroups1779950000000 implements MigrationInterface {
  name = 'AddTranslationGroups1779950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (await queryRunner.hasTable('translation_groups')) return;

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "translation_groups" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "sessionId" varchar(100) NOT NULL, "chatId" varchar(100) NOT NULL, "active" boolean NOT NULL DEFAULT false, "participants" jsonb NOT NULL DEFAULT '{}', "delegatedControllers" jsonb NOT NULL DEFAULT '[]', "announcedAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "UQ_translation_groups_session_chat" UNIQUE ("sessionId", "chatId"))`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "translation_groups" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar(100) NOT NULL, "chatId" varchar(100) NOT NULL, "active" boolean NOT NULL DEFAULT (0), "participants" text NOT NULL DEFAULT ('{}'), "delegatedControllers" text NOT NULL DEFAULT ('[]'), "announcedAt" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_translation_groups_session_chat" UNIQUE ("sessionId", "chatId"))`,
      );
    }
    await queryRunner.query(`CREATE INDEX "IDX_translation_groups_sessionId" ON "translation_groups" ("sessionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_translation_groups_sessionId"`);
    await queryRunner.query(`DROP TABLE "translation_groups"`);
  }
}
