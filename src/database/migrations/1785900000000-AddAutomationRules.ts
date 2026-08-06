import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `automation_rules` — per-session single-message autoreply rules. `conditions` is stored as
 * plain text (same reasoning as `webhooks.filters`: `simple-json` on both dialects, never jsonb).
 * CASCADE FK to sessions: a rule has no meaning after its session is gone. Hand-authored because
 * `synchronize` is off on the `data` connection for Postgres (and optional on SQLite).
 */
export class AddAutomationRules1785900000000 implements MigrationInterface {
  name = 'AddAutomationRules1785900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('automation_rules')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "automation_rules" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "enabled" boolean NOT NULL DEFAULT true, ` +
          `"conditions" text, "replyText" text NOT NULL, "cooldownSeconds" integer NOT NULL DEFAULT 60, ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), "updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_automation_rules_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "automation_rules" ("id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, "name" varchar(100) NOT NULL, "enabled" boolean NOT NULL DEFAULT (1), ` +
          `"conditions" text, "replyText" text NOT NULL, "cooldownSeconds" integer NOT NULL DEFAULT (60), ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_automation_rules_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    }

    await queryRunner.query(`CREATE INDEX "IDX_automation_rules_sessionId" ON "automation_rules" ("sessionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where this migration was
    // recorded via the up() hasTable early-return and the named index was never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_automation_rules_sessionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "automation_rules"`);
  }
}
