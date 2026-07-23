import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `templates` table backing server-side text message templates
 * (issue #69, Option B). Each template belongs to a session via a CASCADE
 * foreign key so templates are removed when their session is deleted.
 *
 * Hand-authored because `synchronize` is disabled for the `data` connection on
 * PostgreSQL (and may be disabled on SQLite via DATABASE_SYNCHRONIZE=false).
 */
export class AddTemplates1779840000000 implements MigrationInterface {
  name = 'AddTemplates1779840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    const exists = await queryRunner.hasTable('templates');
    if (exists) return;

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "templates" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "body" text NOT NULL, "header" text, "footer" text, "createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "FK_templates_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "templates" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "body" text NOT NULL, "header" text, "footer" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_templates_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    }

    await queryRunner.query(`CREATE INDEX "IDX_templates_sessionId" ON "templates" ("sessionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where this migration was
    // recorded via the up() hasTable early-return and the named index was never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_templates_sessionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "templates"`);
  }
}
