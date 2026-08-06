import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an optional `filters` column to `webhooks` (webhook pre-filters).
 * Nullable JSON: null/absent means no filtering. Hand-authored because `synchronize` is off for the
 * `data` connection on Postgres (and optional on SQLite). Stored as `text` on BOTH dialects: the
 * entity column is `simple-json` (jsonColumnType resolves to `simple-json` everywhere — see
 * column-types.ts), which serializes to/parses from text in JS. A `jsonb` column on Postgres would
 * re-introduce the entity/column type drift that crashed the dashboard (#385/#384).
 */
export class AddWebhookFilters1781500000000 implements MigrationInterface {
  name = 'AddWebhookFilters1781500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('webhooks', 'filters')) return;
    await queryRunner.query(`ALTER TABLE "webhooks" ADD COLUMN "filters" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('webhooks', 'filters'))) return;
    await queryRunner.query(`ALTER TABLE "webhooks" DROP COLUMN "filters"`);
  }
}
