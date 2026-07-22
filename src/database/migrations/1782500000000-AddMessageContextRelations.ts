import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Adds typed quote and current-reaction records beside the long-standing `messages.metadata` JSON.
 * The migration intentionally does not parse or backfill legacy JSON: doing so would make a privacy
 * boundary depend on undocumented raw metadata shapes. Existing API payloads continue to use it.
 */
export class AddMessageContextRelations1782500000000 implements MigrationInterface {
  name = 'AddMessageContextRelations1782500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('message_quotes'))) {
      await queryRunner.createTable(
        new Table({
          name: 'message_quotes',
          columns: [
            { name: 'messageId', type: 'varchar', isPrimary: true },
            { name: 'sessionId', type: 'varchar' },
            { name: 'quotedWaMessageId', type: 'varchar' },
            { name: 'body', type: 'text', isNullable: true },
          ],
        }),
      );
      await queryRunner.createIndex(
        'message_quotes',
        new TableIndex({
          name: 'IDX_message_quotes_session_message',
          columnNames: ['sessionId', 'messageId'],
        }),
      );
    }

    if (!(await queryRunner.hasTable('message_reactions'))) {
      await queryRunner.createTable(
        new Table({
          name: 'message_reactions',
          columns: [
            { name: 'messageId', type: 'varchar', isPrimary: true },
            { name: 'senderId', type: 'varchar', isPrimary: true },
            { name: 'sessionId', type: 'varchar' },
            { name: 'emoji', type: 'text' },
          ],
        }),
      );
      await queryRunner.createIndex(
        'message_reactions',
        new TableIndex({
          name: 'IDX_message_reactions_session_message',
          columnNames: ['sessionId', 'messageId'],
        }),
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('message_reactions')) await queryRunner.dropTable('message_reactions');
    if (await queryRunner.hasTable('message_quotes')) await queryRunner.dropTable('message_quotes');
  }
}
