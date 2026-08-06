import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Composite index on messages(sessionId, waMessageId) for the ack-driven status UPDATE.
 * Without it, every WhatsApp ack scans the entire (hot) messages table.
 *
 * Runs on the `data` connection. `IF NOT EXISTS` keeps it portable + idempotent across
 * SQLite and Postgres, and safe on a DB where `synchronize` already created the index.
 */
export class AddMessageSessionWaIndex1779900100000 implements MigrationInterface {
  name = 'AddMessageSessionWaIndex1779900100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_sessionId_waMessageId" ON "messages" ("sessionId", "waMessageId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_sessionId_waMessageId"`);
  }
}
