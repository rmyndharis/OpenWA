import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `status_updates` TTL store: WhatsApp Status/Story posts captured by the engine, kept
 * around only until `expiresAt` (WhatsApp's own 24h TTL) for the Status API to serve.
 *
 * Hand-authored (not `migration:generate`) because the dev SQLite DB in this worktree already carries
 * pre-existing schema drift on unrelated tables (webhooks/sessions/message_batches/
 * baileys_stored_messages/templates/lid_mappings) — confirmed by running a dry-run generate WITHOUT
 * this entity registered, which reproduced the identical multi-table rebuild cascade. Hand-authoring
 * keeps this migration scoped to `status_updates` only, matching the repo's convention for recent
 * additions (e.g. `AddIntegrationFabric`, `AddWebhooksSessionIdIndex`). Idempotent + cross-dialect.
 */
export class CreateStatusUpdates1784822470680 implements MigrationInterface {
  name = 'CreateStatusUpdates1784822470680';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('status_updates')) return;

    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    const boolFalse = isPostgres ? 'false' : '0';
    const idColumn = isPostgres
      ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `"id" varchar PRIMARY KEY NOT NULL`;

    await queryRunner.query(
      `CREATE TABLE "status_updates" (` +
        `${idColumn}, "sessionId" varchar NOT NULL, "contactJid" varchar NOT NULL, ` +
        `"contactName" varchar, "contactPushName" varchar, "waStatusId" varchar NOT NULL, "type" varchar NOT NULL, ` +
        `"caption" text, "mediaPath" varchar, "mediaMimetype" varchar, ` +
        `"mediaOmitted" boolean NOT NULL DEFAULT ${boolFalse}, "omitReason" varchar, "backgroundColor" varchar, ` +
        `"font" integer, "postedAt" bigint NOT NULL, "expiresAt" bigint NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_status_updates_sessionId_contactJid" ON "status_updates" ("sessionId", "contactJid")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_status_updates_sessionId_waStatusId" ON "status_updates" ("sessionId", "waStatusId")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_status_updates_expiresAt" ON "status_updates" ("expiresAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_status_updates_expiresAt"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_status_updates_sessionId_waStatusId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_status_updates_sessionId_contactJid"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "status_updates"`);
  }
}
