import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `baileys_stored_messages` — the persisted Baileys message store backing
 * reply/forward/react/delete. CASCADE-deleted with its session. Hand-authored because
 * `synchronize` is off for the `data` connection on Postgres (and optional on SQLite).
 */
export class AddBaileysStoredMessages1781000000000 implements MigrationInterface {
  name = 'AddBaileysStoredMessages1781000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('baileys_stored_messages')) return;
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "baileys_stored_messages" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "sessionId" varchar NOT NULL, "waMessageId" varchar NOT NULL, "serializedMessage" text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT NOW(), CONSTRAINT "FK_baileys_stored_messages_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "baileys_stored_messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "waMessageId" varchar NOT NULL, "serializedMessage" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_baileys_stored_messages_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      );
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_baileys_stored_messages_session_wamsg" ON "baileys_stored_messages" ("sessionId", "waMessageId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_baileys_stored_messages_session_created" ON "baileys_stored_messages" ("sessionId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where this migration was
    // recorded via the up() hasTable early-return and the named indexes were never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_baileys_stored_messages_session_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_baileys_stored_messages_session_wamsg"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "baileys_stored_messages"`);
  }
}
