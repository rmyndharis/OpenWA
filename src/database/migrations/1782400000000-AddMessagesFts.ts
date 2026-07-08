import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds DB-native full-text search to `messages`:
 *  - Postgres: a STORED generated `tsvector` column (config 'simple') + a GIN index.
 *    The column is auto-maintained on INSERT/UPDATE, so revoke/delete stay in sync with zero app code.
 *  - SQLite: an FTS5 external-content virtual table keyed on the implicit `rowid`, kept in sync by
 *    triggers, backfilled once. (The PK is a UUID, so FTS keys on rowid and we join back for the id.)
 *
 * Non-CONCURRENTLY on PG (one-time blocking build). For very large `messages` tables, run the
 * upgrade during a maintenance window; set SEARCH_ENABLED=false to skip wiring (the migration still runs).
 */
export class AddMessagesFts1782400000000 implements MigrationInterface {
  name = 'AddMessagesFts1782400000000';

  async up(qr: QueryRunner): Promise<void> {
    const isPostgres = qr.connection.options.type === 'postgres';
    if (isPostgres) {
      // Lift the runtime statement_timeout (30000ms on the data pool — see app.module.ts) for this
      // migration transaction: the STORED generated column is a full-table rewrite, and the GIN index
      // build that follows is the heaviest boot migration. Without this, a large `messages` table can
      // exceed 30s and be aborted → boot crash. SET LOCAL is transaction-scoped (auto-reverts) and is
      // guarded by the dialect since SQLite rejects it syntactically. Mirrors 1781100000000 /
      // 1781300000000 / 1782200000000.
      await qr.query('SET LOCAL statement_timeout = 0');
      await qr.query(
        `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "body_ts" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED`,
      );
      await qr.query(`CREATE INDEX IF NOT EXISTS "idx_messages_body_ts" ON "messages" USING GIN ("body_ts")`);
      return;
    }
    // SQLite FTS5 external-content — probe FTS5 first; skip (don't throw) if this build lacks it.
    const fts5 = (await qr.query(`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled`)) as Array<{
      enabled: number;
    }>;
    if (!Number(fts5?.[0]?.enabled)) {
      // FTS5 unavailable on this SQLite build — leave no FTS schema. The provider detects the absent
      // messages_fts table and 501s; OpenWA still boots. See Task 12.
      return;
    }
    await qr.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "messages_fts" USING fts5(body, content='messages', content_rowid='rowid')`,
    );
    await qr.query(
      `INSERT INTO "messages_fts"("rowid", "body") SELECT "rowid", "body" FROM "messages" WHERE "body" IS NOT NULL`,
    );
    await qr.query(`DROP TRIGGER IF EXISTS messages_fts_ai`);
    await qr.query(`CREATE TRIGGER messages_fts_ai AFTER INSERT ON "messages" BEGIN
      INSERT INTO "messages_fts"("rowid", "body") VALUES (new."rowid", new."body");
    END`);
    await qr.query(`DROP TRIGGER IF EXISTS messages_fts_ad`);
    await qr.query(`CREATE TRIGGER messages_fts_ad AFTER DELETE ON "messages" BEGIN
      INSERT INTO "messages_fts"("messages_fts", "rowid", "body") VALUES ('delete', old."rowid", old."body");
    END`);
    await qr.query(`DROP TRIGGER IF EXISTS messages_fts_au`);
    // The WHEN clause limits re-indexing to body changes: without it every ack (SENT→DELIVERED→READ),
    // reaction, and status update does a redundant FTS delete+insert on the busiest message path for
    // zero search benefit (body didn't change). NULL-safe via `IS NOT` (SQLite's NULL-safe not-equal):
    // a NULL↔non-NULL body transition still fires, while ack-only updates skip. The INSERT and DELETE
    // triggers above are unchanged — only UPDATE gains the guard.
    await qr.query(`CREATE TRIGGER messages_fts_au AFTER UPDATE ON "messages" WHEN OLD.body IS NOT NEW.body BEGIN
      INSERT INTO "messages_fts"("messages_fts", "rowid", "body") VALUES ('delete', old."rowid", old."body");
      INSERT INTO "messages_fts"("rowid", "body") VALUES (new."rowid", new."body");
    END`);
  }

  async down(qr: QueryRunner): Promise<void> {
    const isPostgres = qr.connection.options.type === 'postgres';
    if (isPostgres) {
      await qr.query(`DROP INDEX IF EXISTS "idx_messages_body_ts"`);
      await qr.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "body_ts"`);
      return;
    }
    await qr.query(`DROP TRIGGER IF EXISTS messages_fts_au`);
    await qr.query(`DROP TRIGGER IF EXISTS messages_fts_ad`);
    await qr.query(`DROP TRIGGER IF EXISTS messages_fts_ai`);
    await qr.query(`DROP TABLE IF EXISTS "messages_fts"`);
  }
}
