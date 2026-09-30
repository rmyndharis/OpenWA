import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `chat_states.observed`, the state fields a row has seen a value for. A row created by a lone
 * pin also stores a default mute and archive, so two rows of one chat could not tell an explicit unpin
 * from a field the row never saw, and merging them brought a cleared pin back. Existing rows keep null,
 * read as having observed their set fields. Hand-authored because `synchronize` is off on the `data` connection for
 * Postgres; the `hasColumn` guard keeps it idempotent where synchronize already added the column.
 */
export class AddChatStateObserved1786650000000 implements MigrationInterface {
  name = 'AddChatStateObserved1786650000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('chat_states')) || (await queryRunner.hasColumn('chat_states', 'observed'))) {
      return;
    }
    await queryRunner.query(`ALTER TABLE "chat_states" ADD COLUMN "observed" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('chat_states', 'observed'))) return;
    await queryRunner.query(`ALTER TABLE "chat_states" DROP COLUMN "observed"`);
  }
}
