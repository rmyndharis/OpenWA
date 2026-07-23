import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `gen_random_uuid()::varchar` DEFAULT to the two Integration Fabric tables whose `id` columns
 * were created without one.
 *
 * Why this is needed:
 *   `conversation_mappings` and `integration_delivery_failures` both use `@PrimaryGeneratedColumn('uuid')`,
 *   but `AddIntegrationFabric` (1781900000000) created their `id` columns as bare `varchar PRIMARY KEY
 *   NOT NULL` with no DEFAULT — and, being added after `AddUuidDefaultsForPostgres` (1779235200000),
 *   they were never in that migration's 4-table list. On Postgres the TypeORM driver emits
 *   `INSERT ... VALUES (DEFAULT, ...)` for a uuid-strategy PK and relies on a DB-side default, so every
 *   first insert failed with `null value in column "id" ... violates not-null constraint` (23502) —
 *   breaking the Chatwoot handover upsert and the ingress dead-letter write on Postgres only. SQLite is
 *   unaffected (its driver mints the uuid), which is why it went unnoticed.
 *
 *   A NEW forward-only migration is the correct fix (the earlier defaults migration has already run on
 *   live DBs). It mirrors that migration's version-gate: `gen_random_uuid()` is a core built-in on
 *   PostgreSQL 13+, and lives in pgcrypto on PG <= 12. No-op on SQLite.
 */
export class AddIntegrationUuidDefaults1782300000000 implements MigrationInterface {
  name = 'AddIntegrationUuidDefaults1782300000000';

  private readonly tables = ['conversation_mappings', 'integration_delivery_failures'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    // Probe the server version with a non-erroring catalog query (a caught SQL exception would poison the
    // migration transaction). Only touch pgcrypto on PG <= 12; on 13+ gen_random_uuid() is core and
    // CREATE EXTENSION — a privilege managed Postgres often withholds — is avoided entirely.
    const versionRows = (await queryRunner.query(`SELECT current_setting('server_version_num')::int AS num`)) as
      { num: number | string }[] | undefined;
    const versionNum = Number(versionRows?.[0]?.num ?? 0);

    if (versionNum > 0 && versionNum < 130000) {
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

    for (const table of this.tables) {
      if (!(await queryRunner.hasTable(table))) continue;
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.dataSource.options.type !== 'postgres') return;

    for (const table of this.tables) {
      if (!(await queryRunner.hasTable(table))) continue;
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "id" DROP DEFAULT`);
    }
  }
}
