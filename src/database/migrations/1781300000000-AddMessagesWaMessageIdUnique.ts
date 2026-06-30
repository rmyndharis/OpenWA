import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforces one row per (sessionId, waMessageId) on `messages` (issue #464): the engine can re-fire
 * the inbound `message` event, and the old blind insert persisted the same WhatsApp message twice.
 *
 * Pre-existing duplicates are removed losslessly — a duplicate (sessionId, waMessageId) IS the same
 * message, so the earliest row (createdAt ASC, id ASC) is kept and the rest deleted. Rows with a NULL
 * waMessageId are exempt (SQL treats NULLs as distinct), preserving transient outgoing PENDING rows.
 *
 * Hand-authored because `synchronize` is off for the `data` connection. Idempotent + cross-dialect.
 */
export class AddMessagesWaMessageIdUnique1781300000000 implements MigrationInterface {
  name = 'AddMessagesWaMessageIdUnique1781300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'postgres') {
      // The runtime 'data' pool carries a statement_timeout (app.module.ts) and migrations run on it at
      // boot. Lift it for THIS transaction so the dedup DELETE / CREATE UNIQUE INDEX over the hot messages
      // table is never aborted mid-flight. SET LOCAL is transaction-scoped (auto-reverts at COMMIT) and is
      // a no-op everywhere else — SQLite rejects it syntactically, hence the guard.
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    if (!(await queryRunner.hasTable('messages'))) return;

    await queryRunner.query(
      `DELETE FROM "messages" WHERE "waMessageId" IS NOT NULL AND "id" <> (` +
        `SELECT m2."id" FROM "messages" m2 ` +
        `WHERE m2."sessionId" = "messages"."sessionId" AND m2."waMessageId" = "messages"."waMessageId" ` +
        `ORDER BY m2."createdAt" ASC, m2."id" ASC LIMIT 1)`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_sessionId_waMessageId"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_messages_sessionId_waMessageId" ON "messages" ("sessionId", "waMessageId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_messages_sessionId_waMessageId"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_sessionId_waMessageId" ON "messages" ("sessionId", "waMessageId")`,
    );
  }
}
