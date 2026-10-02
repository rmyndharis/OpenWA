import { MigrationInterface, QueryRunner } from 'typeorm';

const indexes = [
  ['IDX_messages_session_timestamp_id', '"sessionId", "timestamp", "id"'],
  ['IDX_messages_session_chat_timestamp_id', '"sessionId", "chatId", "timestamp", "id"'],
  ['IDX_messages_session_direction_timestamp_id', '"sessionId", "direction", "timestamp", "id"'],
] as const;

/** Match the entity schema on synchronize-disabled deployments, in both supported dialects. */
export class AddMessageWindowIndexes1790812800000 implements MigrationInterface {
  name = 'AddMessageWindowIndexes1790812800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type === 'postgres') await queryRunner.query('SET LOCAL statement_timeout = 0');
    for (const [name, columns] of indexes) {
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "messages" (${columns})`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of indexes) await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
  }
}
