import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `chatName` column to the `messages` table. This stores the human-readable name for the
 * chat (contact pushName, group name, etc) at the time the message was received/sent, enabling
 * stats endpoints to display readable names instead of raw JIDs.
 *
 * Hand-authored because `synchronize` is off for the `data` connection on PostgreSQL (and optional
 * on SQLite via DATABASE_SYNCHRONIZE=false). Idempotent: checks for column existence first.
 */
export class AddMessageChatName1782000000000 implements MigrationInterface {
  name = 'AddMessageChatName1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('messages');
    const col = table?.findColumnByName('chatName');
    if (col) return; // already added by synchronize or a previous run

    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "chatName" varchar NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('messages');
    const col = table?.findColumnByName('chatName');
    if (!col) return;
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "chatName"`);
  }
}
