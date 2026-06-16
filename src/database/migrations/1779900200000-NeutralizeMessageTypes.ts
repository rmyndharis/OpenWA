import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfill `messages.type` to the engine-neutral vocabulary (#265 — engine pluggability).
 *
 * Older incoming rows were persisted with raw whatsapp-web.js type tokens (`chat`, `ptt`,
 * `vcard`); the engine layer now emits neutral types (`text`, `voice`, `contact`, …) at the
 * adapter boundary. The dashboard chat view reads persisted rows (GET /sessions/:id/messages)
 * and the message stats group by `type`, so without this backfill old rows would render wrong
 * (text shown as a `[chat]` media bubble, voice notes as document links) and stats would split
 * the same kind across old/new tokens.
 *
 * Forward-only mapping is collision-free: the neutral targets (`text`/`voice`/`contact`) were
 * never valid raw wwebjs tokens, and the passthrough kinds (image/video/audio/document/sticker/
 * location/revoked) already match. Portable + idempotent across SQLite and Postgres.
 */
export class NeutralizeMessageTypes1779900200000 implements MigrationInterface {
  name = 'NeutralizeMessageTypes1779900200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "messages" SET "type" = 'text' WHERE "type" = 'chat'`);
    await queryRunner.query(`UPDATE "messages" SET "type" = 'voice' WHERE "type" = 'ptt'`);
    await queryRunner.query(`UPDATE "messages" SET "type" = 'contact' WHERE "type" IN ('vcard', 'multi_vcard')`);
  }

  public async down(): Promise<void> {
    // Intentionally not reversed: the neutral vocabulary is the canonical contract, and outgoing
    // rows were ALWAYS written as neutral ('text', etc.), so a blanket reverse (text -> chat) would
    // corrupt rows that never carried the raw token. Rolling back leaves types neutral, which the
    // app handles correctly.
  }
}
