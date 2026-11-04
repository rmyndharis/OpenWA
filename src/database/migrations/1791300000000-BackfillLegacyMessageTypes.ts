import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time backfill of `messages.type` to the engine-neutral vocabulary (#265).
 *
 * Older incoming rows were persisted with raw whatsapp-web.js tokens (`chat`/`ptt`/`vcard`); the engine
 * now emits neutral types (`text`/`voice`/`contact`), and the dashboard chat view and the message stats read
 * these rows. A boot-time service used to run the conversion on every start. `type` has no index, so each
 * start read the whole table (four times, before the HTTP port opened), and on PostgreSQL the runtime
 * pool's statement timeout cancelled it once the table was large. A migration runs once, on a pool without
 * that timeout. The service now runs only where migrations never run: SQLite under DATABASE_SYNCHRONIZE=true.
 *
 * call_log and poll_creation are left out on purpose: a row stored before #265 carries no call or poll
 * metadata, so relabelling it would render an empty call or poll bubble. The mapping is forward-only and
 * collision-free (the neutral targets were never valid raw tokens), so it is idempotent and `down` is a
 * no-op. One statement, so the table is read once. `backfill` is shared with the boot service and with
 * import-data, which restores rows from archives taken before the neutral vocabulary.
 */
export class BackfillLegacyMessageTypes1791300000000 implements MigrationInterface {
  name = 'BackfillLegacyMessageTypes1791300000000';

  static async backfill(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('messages'))) return;
    await queryRunner.query(
      `UPDATE "messages" SET "type" = CASE "type" ` +
        `WHEN 'chat' THEN 'text' WHEN 'buttons_response' THEN 'text' WHEN 'list_response' THEN 'text' ` +
        `WHEN 'template_button_reply' THEN 'text' WHEN 'ptt' THEN 'voice' ` +
        `WHEN 'vcard' THEN 'contact' WHEN 'multi_vcard' THEN 'contact' END ` +
        `WHERE "type" IN ('chat', 'buttons_response', 'list_response', 'template_button_reply', 'ptt', 'vcard', 'multi_vcard')`,
    );
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Boot and CLI migrations run on a pool without the runtime statement_timeout (pg-boot-migrations.ts),
    // and MigrationExecutor wraps a lone pending migration in its own transaction, so lift any role- or
    // database-level default for this transaction only, exactly like AddWebhookDeliveryFailureLookupIndex.
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    await BackfillLegacyMessageTypes1791300000000.backfill(queryRunner);
  }

  public async down(): Promise<void> {
    // Forward-only: the raw tokens are not recoverable once converted.
  }
}
