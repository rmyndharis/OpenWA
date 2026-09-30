import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop the `lid_mappings` rows earlier releases wrote with a broadcast id as the phone.
 *
 * A status or broadcast-list message carries the sender's lid in `remoteJidAlt`, and earlier releases
 * paired it with the chat (`status@broadcast` or `<list>@broadcast`) instead of the sender, storing
 * "status" or the list id as that lid's phone number. The lid then resolved to `status@c.us` or
 * `<list>@c.us`. New writes pair it with the sender; this removes the rows written before that:
 * every phone that is not all digits, and every list id those releases filed a received list message
 * under. A deleted row is only a cache miss, so the next lookup asks WhatsApp again. A null phone is a
 * cached negative result and stays.
 *
 * Idempotent, and `down` is a no-op: the removed values were wrong. `scrub` is shared with
 * import-data, which restores rows from archives taken before this migration ran.
 */
export class ScrubNonPhoneLidMappings1786950000000 implements MigrationInterface {
  name = 'ScrubNonPhoneLidMappings1786950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await ScrubNonPhoneLidMappings1786950000000.scrub(queryRunner);
  }

  static async scrub(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('lid_mappings'))) return;
    const notDigits =
      queryRunner.dataSource.options.type === 'postgres' ? `"phone" !~ '^[0-9]+$'` : `"phone" GLOB '*[^0-9]*'`;
    await queryRunner.query(`DELETE FROM "lid_mappings" WHERE ${notDigits} OR "phone" = ''`);
    if (!(await queryRunner.hasTable('messages'))) return;
    await queryRunner.query(
      `DELETE FROM "lid_mappings" WHERE "phone" IN (SELECT DISTINCT substr("chatId", 1, length("chatId") - 10) FROM "messages" WHERE "chatId" LIKE '%@broadcast')`,
    );
  }

  public async down(): Promise<void> {
    // Nothing to restore.
  }
}
