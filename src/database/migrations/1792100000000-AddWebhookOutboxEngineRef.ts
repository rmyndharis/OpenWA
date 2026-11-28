import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `webhook_outbox_events.engineRef`, the chat, direction and author the engine reported for the message a
 * delivery carries, written only when a message handler filed it under others or rewrote its `from` or `to`. A change
 * of a message that has no row (a send that is not stored) reaches its copies by it. Existing rows keep null.
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres; the `hasColumn` guard keeps it
 * idempotent where synchronize already added the column.
 */
export class AddWebhookOutboxEngineRef1792100000000 implements MigrationInterface {
  name = 'AddWebhookOutboxEngineRef1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasTable('webhook_outbox_events')) ||
      (await queryRunner.hasColumn('webhook_outbox_events', 'engineRef'))
    ) {
      return;
    }
    await queryRunner.query(`ALTER TABLE "webhook_outbox_events" ADD COLUMN "engineRef" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('webhook_outbox_events', 'engineRef'))) return;
    await queryRunner.query(`ALTER TABLE "webhook_outbox_events" DROP COLUMN "engineRef"`);
  }
}
