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
 */
export class AddMessagesCreatedAtIndex1785123853000 implements MigrationInterface {
  name = 'AddMessagesCreatedAtIndex1785123853000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_createdAt" ON "messages" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_createdAt"`);
  }
}
