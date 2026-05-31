import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds indexes that back hot read paths:
 *   - messages(direction): StatsService groups by direction (overview/session).
 *   - messages(type): StatsService groups by type (message stats).
 *   - webhooks(sessionId, active): WebhookService.dispatch() filters by both on
 *     every inbound/outbound message event.
 *
 * Postgres-only. On SQLite the `data` datasource runs with synchronize:true,
 * so these indexes are created from the entity @Index decorators automatically
 * (mirrors AddUuidDefaultsForPostgres1779235200000). Index names are explicit
 * and use IF NOT EXISTS to stay idempotent.
 */
export class AddStatsAndWebhookIndexes1780099200000 implements MigrationInterface {
  name = 'AddStatsAndWebhookIndexes1780099200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    if (await queryRunner.hasTable('messages')) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_direction" ON "messages" ("direction")`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_type" ON "messages" ("type")`);
    }

    if (await queryRunner.hasTable('webhooks')) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_webhooks_session_active" ON "webhooks" ("sessionId", "active")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') return;

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhooks_session_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_direction"`);
  }
}
