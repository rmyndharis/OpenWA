import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `lid_mappings` - the persisted, cross-session `lid -> phone` resolution table on the `data`
 * connection. Hand-authored because `synchronize` is off for `data` on Postgres (and optional on
 * SQLite); the `hasTable` guard keeps it idempotent on a DB where synchronize already created it.
 */
export class AddLidMappings1781200000000 implements MigrationInterface {
  name = 'AddLidMappings1781200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('lid_mappings')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "lid_mappings" ("lid" varchar PRIMARY KEY NOT NULL, "phone" varchar, "sessionId" varchar, "updatedAt" timestamp NOT NULL DEFAULT NOW())`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "lid_mappings" ("lid" varchar PRIMARY KEY NOT NULL, "phone" varchar, "sessionId" varchar, "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      );
    }

    await queryRunner.query(`CREATE INDEX "IDX_lid_mappings_phone" ON "lid_mappings" ("phone")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF EXISTS so rollback is safe even when the table was created by the `synchronize` path (which
    // auto-names the index differently) rather than by up()'s explicit `IDX_lid_mappings_phone`.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lid_mappings_phone"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lid_mappings"`);
  }
}
