import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index `webhooks.sessionId`. The webhook dispatch path looks up a session's active webhooks by
 * sessionId on EVERY emitted event (WebhookService.findBySession → `find({ where: { sessionId } })`),
 * so without this index each dispatch was a full scan of the webhooks table. The FK column carried no
 * index — the entity's `@ManyToOne`/`@JoinColumn` does not create one.
 *
 * Hand-authored because `synchronize` is off for the 'data' connection. Idempotent + cross-dialect.
 */
export class AddWebhooksSessionIdIndex1782200000000 implements MigrationInterface {
  name = 'AddWebhooksSessionIdIndex1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type === 'postgres') {
      // Lift the runtime pool's statement_timeout (app.module.ts) for THIS transaction so a CREATE INDEX
      // over a large webhooks table at boot is never aborted. SET LOCAL auto-reverts at COMMIT; SQLite
      // rejects it syntactically, hence the guard.
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    if (!(await queryRunner.hasTable('webhooks'))) return;
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_webhooks_sessionId" ON "webhooks" ("sessionId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhooks_sessionId"`);
  }
}
