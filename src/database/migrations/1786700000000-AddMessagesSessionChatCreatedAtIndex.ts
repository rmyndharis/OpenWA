import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Composite index on `messages (sessionId, chatId, createdAt)`, backing one chat's thread: the
 * paged message list with a chatId filter and its total, and the send-pacing history probes that
 * filter on the same prefix. Without it both dialects walked every row of the session through the
 * (sessionId, createdAt) or unique (sessionId, waMessageId) index and filtered chatId row by row.
 *
 * Same reasoning as AddMessageMediaPathIndex: hand-authored because `synchronize` is off for the
 * data connection on PostgreSQL (and optional on SQLite). The explicit name matches the entity's
 * @Index, so the synchronize and migration schema paths converge on one index. Idempotent via
 * IF NOT EXISTS (supported by both dialects for indexes).
 *
 * Not CONCURRENTLY: the migration runs inside a transaction. On PostgreSQL the build holds a SHARE
 * lock on messages, so inserts and ack updates wait until it finishes (reads do not); on SQLite the
 * build locks the database file. Both last as long as the build over the existing rows.
 */
export class AddMessagesSessionChatCreatedAtIndex1786700000000 implements MigrationInterface {
  name = 'AddMessagesSessionChatCreatedAtIndex1786700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The data pool boots with a runtime statement_timeout (default 30s), which a build over a large
    // messages table can outlast. Lift it for this transaction only, like AddMessageMediaPathIndex.
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_sessionId_chatId_createdAt" ON "messages" ("sessionId", "chatId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_sessionId_chatId_createdAt"`);
  }
}
