import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `messages.engineRef`, the chat, direction and author the engine reported for a message a
 * `message:received` or `message:sent` handler filed under others. Changes to such a message are judged by it;
 * every other row, existing rows included, keeps null and is judged by its own columns. Hand-authored because
 * `synchronize` is off on the `data` connection for Postgres; the `hasColumn` guard keeps it idempotent where
 * synchronize already added the column.
 */
export class AddMessageEngineRef1792000000000 implements MigrationInterface {
  name = 'AddMessageEngineRef1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('messages')) || (await queryRunner.hasColumn('messages', 'engineRef'))) return;
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "engineRef" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('messages', 'engineRef'))) return;
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "engineRef"`);
  }
}
