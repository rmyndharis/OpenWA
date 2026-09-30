import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replaces `baileys_stored_messages (sessionId, createdAt)` with `(sessionId, createdAt, id)`.
 *
 * Every stored Baileys message runs the per-session cap trim, which finds the cutoff row ordered by
 * `createdAt DESC, id DESC` and then deletes everything at or below it by `(createdAt, id)`. Without
 * `id` in the index SQLite sorts the session's rows in a temp B-tree for the cutoff on every write;
 * with it both statements walk the index. The new index's leading columns serve every query the old
 * one did, so the old one is dropped.
 *
 * Hand-authored because `synchronize` is off for the data connection on PostgreSQL. The name matches
 * the entity's @Index so the synchronize and migration schema paths converge. IF [NOT] EXISTS on
 * both dialects keeps it idempotent.
 */
export class AddBaileysStoredMessagesSessionCreatedIdIndex1786800000000 implements MigrationInterface {
  name = 'AddBaileysStoredMessagesSessionCreatedIdIndex1786800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Lift the runtime statement_timeout for this transaction only, as AddMessageMediaPathIndex does.
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_baileys_stored_messages_session_created_id" ON "baileys_stored_messages" ("sessionId", "createdAt", "id")`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_baileys_stored_messages_session_created"`);
    // The entity's former unnamed (sessionId, createdAt) index, present only where synchronize built
    // the table; the new index covers it.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ae44b476c522450bd395615a7c"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_baileys_stored_messages_session_created" ON "baileys_stored_messages" ("sessionId", "createdAt")`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_baileys_stored_messages_session_created_id"`);
  }
}
