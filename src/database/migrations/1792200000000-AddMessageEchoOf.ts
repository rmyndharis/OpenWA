import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `messages.echoOf`, set on the row of an API send whose message id the own-send echo's row took first, while
 * what the send stored (the media bytes, a quote, a poll) is not yet merged onto that row: the pending reaper's sweep
 * finishes the merge and drops the row. A partial index keeps the sweep to such rows, NULL on every other one.
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres; the `hasColumn` guard and
 * IF NOT EXISTS keep it idempotent where synchronize already added them. The index name matches the entity's @Index.
 */
export class AddMessageEchoOf1792200000000 implements MigrationInterface {
  name = 'AddMessageEchoOf1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('messages'))) return;
    // Boot and CLI migrations run on a pool without the runtime statement_timeout, and an index over a large messages
    // table can outlast a role or database default, so lift it for this transaction only (see AddMessageMediaPathIndex).
    if (queryRunner.dataSource.options.type === 'postgres') {
      await queryRunner.query('SET LOCAL statement_timeout = 0');
    }
    if (!(await queryRunner.hasColumn('messages', 'echoOf'))) {
      await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "echoOf" varchar`);
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_echoOf" ON "messages" ("echoOf") WHERE "echoOf" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_echoOf"`);
    if (!(await queryRunner.hasColumn('messages', 'echoOf'))) return;
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "echoOf"`);
  }
}
