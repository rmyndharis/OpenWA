import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two chat-history gates to `automation_rules` (`newContactOnly`, `pauseOnHumanReply`) and
 * the `messages.automated` marker the second one reads.
 *
 * The marker is what makes "has a HUMAN answered this chat?" answerable at all: an autoreply and an
 * operator's send land as byte-identical OUTGOING rows (different writers — `saveOutgoingMessage`
 * for API sends, `handleOwnSendEcho` for messages composed on a linked phone), so without it a
 * `pauseOnHumanReply` rule would read its own first reply as a human takeover and go silent for
 * good after one message.
 *
 * All three are NOT NULL with a constant default, which both dialects record in the catalog rather
 * than rewriting the table — the point of care on `messages`, which is hot and high-volume. Every
 * pre-existing row reads back false, which is the truth: no automated replies were written before
 * this column existed, and no rule could have been gated before these two.
 *
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres.
 */
export class AddAutomationChatHistoryGates1786400000000 implements MigrationInterface {
  name = 'AddAutomationChatHistoryGates1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';
    // SQLite has no boolean literal; the create-table migrations in this chain spell it (1)/(0).
    const boolFalse = isPostgres ? 'false' : '(0)';

    if (!(await queryRunner.hasColumn('messages', 'automated'))) {
      await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "automated" boolean NOT NULL DEFAULT ${boolFalse}`);
    }
    if (!(await queryRunner.hasColumn('automation_rules', 'newContactOnly'))) {
      await queryRunner.query(
        `ALTER TABLE "automation_rules" ADD COLUMN "newContactOnly" boolean NOT NULL DEFAULT ${boolFalse}`,
      );
    }
    if (!(await queryRunner.hasColumn('automation_rules', 'pauseOnHumanReply'))) {
      await queryRunner.query(
        `ALTER TABLE "automation_rules" ADD COLUMN "pauseOnHumanReply" boolean NOT NULL DEFAULT ${boolFalse}`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('automation_rules', 'pauseOnHumanReply')) {
      await queryRunner.query(`ALTER TABLE "automation_rules" DROP COLUMN "pauseOnHumanReply"`);
    }
    if (await queryRunner.hasColumn('automation_rules', 'newContactOnly')) {
      await queryRunner.query(`ALTER TABLE "automation_rules" DROP COLUMN "newContactOnly"`);
    }
    if (await queryRunner.hasColumn('messages', 'automated')) {
      await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "automated"`);
    }
  }
}
