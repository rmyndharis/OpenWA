import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `chat_states.deletedAt`, the epoch ms WhatsApp deleted the chat. The gateway keeps a deleted
 * chat's stored messages, and a chat write keyed to one of them came back from Baileys as an update of
 * the chat, which listed it again. Existing rows keep null. Hand-authored because `synchronize` is off on
 * the `data` connection for Postgres; the `hasColumn` guard keeps it idempotent where synchronize already
 * added the column.
 */
export class AddChatStateDeletedAt1791700000000 implements MigrationInterface {
  name = 'AddChatStateDeletedAt1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('chat_states')) || (await queryRunner.hasColumn('chat_states', 'deletedAt'))) {
      return;
    }
    await queryRunner.query(`ALTER TABLE "chat_states" ADD COLUMN "deletedAt" bigint`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('chat_states', 'deletedAt'))) return;
    // Without the column such a row reads as a chat with a state, which an older reader lists; it kept no
    // row for a deleted chat.
    await queryRunner.query(`DELETE FROM "chat_states" WHERE "deletedAt" IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE "chat_states" DROP COLUMN "deletedAt"`);
  }
}
