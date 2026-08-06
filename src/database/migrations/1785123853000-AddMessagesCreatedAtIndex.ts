import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Standalone index on messages(createdAt) for the dashboard stats aggregates. Their timeline
 * predicates are createdAt-only range scans (`WHERE m.createdAt >= :since`, no sessionId), which
 * the existing composite (sessionId, createdAt) cannot serve — sessionId leads it, so without
 * ANALYZE stats SQLite full-scans the table, and PostgreSQL has no skip-scan at all. On the
 * default SQLite backend that scan runs synchronously on the event loop.
 *
 * Runs on the `data` connection. `IF NOT EXISTS` is valid on both dialects (no branch needed,
 * same as AddMessageSessionWaIndex) and keeps the migration idempotent + safe on a DB where
 * `synchronize` already created the same-named index declared on the Message entity.
 *
 * The `messages` table is the hottest data table (every inbound/outbound row), so on Postgres a
 * CREATE INDEX over a large table at boot can exceed the runtime pool's statement_timeout and abort
 * the migration. Lift it for THIS transaction (SET LOCAL auto-reverts at COMMIT; SQLite rejects it
 * syntactically, hence the guard) — the same discipline AddWebhooksSessionIdIndex and
 * AddMessagesWaMessageIdUnique already use. `CONCURRENTLY` would avoid the ACCESS EXCLUSIVE lock
 * but cannot run inside a transaction, so it is deliberately NOT used here (the boot-time blocking
 * window is acceptable for a self-hosted gateway; consistency with the sibling index migrations
 * outweighs it).
 */
export class AddMessagesCreatedAtIndex1785123853000 implements MigrationInterface {
  name = 'AddMessagesCreatedAtIndex1785123853000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_createdAt" ON "messages" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_createdAt"`);
  }
}
