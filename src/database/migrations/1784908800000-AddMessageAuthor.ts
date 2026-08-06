import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `author` column to the `messages` table. For a group message this stores the participant
 * JID who actually posted (the row's `from` is the group JID), giving the chat view a stable
 * sender identity — two participants who share a pushName no longer collapse into one attribution
 * run. Null for one-to-one messages, outgoing echoes, and legacy rows.
 *
 * Hand-authored because `synchronize` is off for the `data` connection on PostgreSQL (and optional
 * on SQLite via DATABASE_SYNCHRONIZE=false). Idempotent: checks for column existence first.
 *
 * NOTE: the existence check deliberately avoids `queryRunner.getTable('messages')`. Since the FTS
 * migration added the STORED generated column `body_ts`, loading the `messages` table metadata on
 * Postgres makes TypeORM look the expression up in `typeorm_metadata` — a table nothing in this
 * migration context creates (the schema builder only creates it for entity-declared generated
 * columns), so the lookup fails with "relation typeorm_metadata does not exist". A raw
 * dialect-aware probe sidesteps that path entirely.
 */
export class AddMessageAuthor1784908800000 implements MigrationInterface {
  name = 'AddMessageAuthor1784908800000';

  private async hasAuthorColumn(queryRunner: QueryRunner): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'author'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("messages")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === 'author');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasAuthorColumn(queryRunner)) return; // already added by synchronize or a previous run

    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "author" varchar NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasAuthorColumn(queryRunner))) return;
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "author"`);
  }
}
