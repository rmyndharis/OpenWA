import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `mediaPath` and `mediaMimetype` to the `messages` table, backing the opt-in chat-media
 * archive: a copy of the message's media in the file store (local or S3), addressable after
 * delivery through `GET /sessions/:id/messages/:chatId/:messageId/media`.
 *
 * Both are NULL for every existing row and stay NULL while `CHAT_MEDIA_ARCHIVE_ENABLED` is off,
 * which is the default — the archive is additive and changes nothing about the inline base64 copy
 * the row's `metadata.media` already carries.
 *
 * `mediaMimetype` is stored alongside the path rather than read back off `metadata.media` so the
 * archive is self-describing: the read endpoint needs a Content-Type, and sourcing it from the
 * inline copy would couple the archive to a field a future retention decision may strip.
 *
 * Hand-authored because `synchronize` is off for the `data` connection on PostgreSQL (and optional
 * on SQLite via DATABASE_SYNCHRONIZE=false). Idempotent: probes for the column first.
 *
 * NOTE: the existence check deliberately avoids `queryRunner.getTable('messages')` — since the FTS
 * migration added the STORED generated column `body_ts`, loading that table's metadata on Postgres
 * sends TypeORM looking for `typeorm_metadata`, which nothing in this migration context creates.
 * A raw dialect-aware probe sidesteps it (same reasoning as AddMessageAuthor).
 */
export class AddMessageMediaArchive1785700000000 implements MigrationInterface {
  name = 'AddMessageMediaArchive1785700000000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("messages")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Probed independently so a run interrupted between the two ALTERs still completes.
    if (!(await this.hasColumn(queryRunner, 'mediaPath'))) {
      await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "mediaPath" varchar NULL`);
    }
    if (!(await this.hasColumn(queryRunner, 'mediaMimetype'))) {
      await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "mediaMimetype" varchar NULL`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'mediaMimetype')) {
      await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "mediaMimetype"`);
    }
    if (await this.hasColumn(queryRunner, 'mediaPath')) {
      await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "mediaPath"`);
    }
  }
}
