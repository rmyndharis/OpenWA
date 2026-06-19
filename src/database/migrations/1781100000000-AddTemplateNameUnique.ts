import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enforces one template name per session (issue #69): resolve-by-name was nondeterministic because
 * nothing stopped two templates in a session from sharing a name.
 *
 * Before adding the composite UNIQUE index, any pre-existing (sessionId, name) collisions are
 * deduplicated LOSSLESSLY — the earliest row keeps the name, the rest are renamed to
 * `<name>-dup-<id>` (id is a UUID, so the new name cannot collide; the name is left-trimmed so the
 * result fits the varchar(100) column on PostgreSQL). No row is ever deleted.
 *
 * Hand-authored because `synchronize` is disabled for the `data` connection on PostgreSQL (and may
 * be disabled on SQLite via DATABASE_SYNCHRONIZE=false). Idempotent: a re-run finds no duplicates
 * and skips the existing index.
 */
export class AddTemplateNameUnique1781100000000 implements MigrationInterface {
  name = 'AddTemplateNameUnique1781100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('templates'))) return;

    // Keep the earliest row per (sessionId, name) — createdAt ASC, id ASC as a stable tiebreak —
    // and rename every other member of the group. substr(name,1,59)+'-dup-'+id(36) is <= 100 chars,
    // so it never overflows the varchar(100) "name" column on PostgreSQL.
    await queryRunner.query(
      `UPDATE "templates" SET "name" = substr("name", 1, 59) || '-dup-' || "id" ` +
        `WHERE "id" <> (` +
        `SELECT t2."id" FROM "templates" t2 ` +
        `WHERE t2."sessionId" = "templates"."sessionId" AND t2."name" = "templates"."name" ` +
        `ORDER BY t2."createdAt" ASC, t2."id" ASC LIMIT 1)`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_templates_session_name" ON "templates" ("sessionId", "name")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Only the index is reversible; the lossless renames are intentionally left in place.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_templates_session_name"`);
  }
}
