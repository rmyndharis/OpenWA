import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index on `webhook_outbox_events (sessionId)`. Deleting a session removes its outbox rows by sessionId, and
 * the only indexes lead with webhookId or state, so that delete (and each batch of it) read the whole table.
 * An opt-in event that fires once per recipient keeps millions of rows inside the retention window.
 *
 * Hand-authored because `synchronize` is off for the data connection on PostgreSQL (and optional on
 * SQLite). The explicit name matches the entity's @Index, so the synchronize and migration schema paths
 * converge on one index. Idempotent via IF NOT EXISTS (supported by both dialects).
 */
export class AddWebhookOutboxSessionIndex1791200000000 implements MigrationInterface {
  name = 'AddWebhookOutboxSessionIndex1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Boot and CLI migrations run on a pool without the runtime statement_timeout (pg-boot-migrations.ts),
    // and MigrationExecutor wraps a lone pending migration in its own transaction, so lift any role- or
    // database-level default for this transaction only, exactly like AddWebhookDeliveryFailureLookupIndex.
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_webhook_outbox_events_sessionId" ON "webhook_outbox_events" ("sessionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhook_outbox_events_sessionId"`);
  }
}
