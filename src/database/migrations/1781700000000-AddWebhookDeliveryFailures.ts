import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `webhook_delivery_failures` — a durable, append-only log of webhook deliveries that
 * exhausted all retries, so an operator isn't blind to events lost during a receiver outage longer
 * than the retry window. No FK to sessions (operational/audit data, like `audit_logs`, that should
 * survive the session it references). Hand-authored because `synchronize` is off on the `data`
 * connection for Postgres (and optional on SQLite).
 */
export class AddWebhookDeliveryFailures1781700000000 implements MigrationInterface {
  name = 'AddWebhookDeliveryFailures1781700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('webhook_delivery_failures')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "webhook_delivery_failures" ("id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, "webhookId" varchar NOT NULL, "sessionId" varchar NOT NULL, "event" varchar NOT NULL, "url" varchar NOT NULL, "idempotencyKey" varchar, "deliveryId" varchar, "attempts" integer NOT NULL, "lastStatusCode" integer, "lastError" text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT NOW())`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "webhook_delivery_failures" ("id" varchar PRIMARY KEY NOT NULL, "webhookId" varchar NOT NULL, "sessionId" varchar NOT NULL, "event" varchar NOT NULL, "url" varchar NOT NULL, "idempotencyKey" varchar, "deliveryId" varchar, "attempts" integer NOT NULL, "lastStatusCode" integer, "lastError" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      );
    }

    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_delivery_failures_sessionId" ON "webhook_delivery_failures" ("sessionId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so revert is idempotent on a synchronize-bootstrapped DB, where this migration was
    // recorded via the up() hasTable early-return and the named index was never created.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhook_delivery_failures_sessionId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_delivery_failures"`);
  }
}
