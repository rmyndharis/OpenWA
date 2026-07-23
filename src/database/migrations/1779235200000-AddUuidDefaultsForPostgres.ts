import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `gen_random_uuid()::varchar` DEFAULT to every `id` column on Postgres.
 *
 * Why this is needed:
 *   The initial schema migration (1770108659848-AddMessageStatus) created the
 *   `id` columns on Postgres as `varchar PRIMARY KEY NOT NULL` without a
 *   DEFAULT. The TypeORM Postgres driver emits `INSERT ... VALUES (DEFAULT, ...)`
 *   for `@PrimaryGeneratedColumn('uuid')` columns and expects the database to
 *   supply the value. Without a column DEFAULT this fails with:
 *     null value in column "id" of relation "<table>" violates not-null constraint
 *
 *   This migration is a no-op on SQLite (TypeORM generates the UUID in the
 *   driver layer there, so no DB default is needed).
 *
 *   `gen_random_uuid()` is a core built-in from PostgreSQL 13; on PG <= 12 it lives
 *   in the pgcrypto extension. We therefore version-gate: on PG 13+ no extension is
 *   touched at all (the common case, and CREATE EXTENSION needs a privilege managed
 *   Postgres often withholds), and only on PG <= 12 do we ensure pgcrypto — with a
 *   clear, actionable error if the role cannot create it, instead of a boot crash-loop.
 *
 *   NOTE: editing an already-recorded migration body only benefits new / currently
 *   crash-looping deployments; healthy ones that already ran it are unaffected.
 */
export class AddUuidDefaultsForPostgres1779235200000 implements MigrationInterface {
  name = 'AddUuidDefaultsForPostgres1779235200000';

  // Data-connection tables only — api_keys/audit_logs live on the separate 'main' connection.
  private readonly tables = ['sessions', 'webhooks', 'messages', 'message_batches'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    // gen_random_uuid() is a core built-in from PostgreSQL 13+, so on any modern server we need NO
    // extension — and CREATE EXTENSION requires a privilege that managed Postgres (RDS/Cloud SQL/…)
    // often withholds, so running it unconditionally crash-loops boot there. Probe the version with a
    // non-erroring catalog query (never a caught SQL exception, which would poison the migration tx)
    // and only touch pgcrypto on PG <= 12.
    const versionRows = (await queryRunner.query(`SELECT current_setting('server_version_num')::int AS num`)) as
      { num: number | string }[] | undefined;
    const versionNum = Number(versionRows?.[0]?.num ?? 0);

    if (versionNum > 0 && versionNum < 130000) {
      // PG <= 12: gen_random_uuid() lives in pgcrypto. Check the catalog first (readable by any role);
      // only attempt CREATE EXTENSION when it is genuinely missing, and if the role can't create it,
      // fail with a clear, actionable error rather than a raw permission-denied crash-loop.
      const installed = (await queryRunner.query(`SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'`)) as
        unknown[] | undefined;
      if (!installed?.length) {
        try {
          await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
        } catch (err) {
          throw new Error(
            `PostgreSQL ${versionNum} (< 13) needs the pgcrypto extension for gen_random_uuid(), but it is ` +
              `not installed and this database role cannot create it. Have a superuser run ` +
              `"CREATE EXTENSION pgcrypto;" once, then restart.`,
            { cause: err },
          );
        }
      }
    }

    // By this point gen_random_uuid() resolves (core on 13+, pgcrypto ensured on <= 12), so the DEFAULT
    // expression — which Postgres validates at ALTER time — is safe to set.
    for (const table of this.tables) {
      const exists = await queryRunner.hasTable(table);
      if (!exists) continue;
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    for (const table of this.tables) {
      const exists = await queryRunner.hasTable(table);
      if (!exists) continue;
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "id" DROP DEFAULT`);
    }
  }
}
