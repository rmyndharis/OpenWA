import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `deniedPermissions` to `api_keys` — the capability blocklist that turns off chosen surfaces
 * (see src/modules/auth/api-key-permissions.ts for the vocabulary) independently of the role and of
 * both id scopes.
 *
 * NULL/empty means "nothing blocked", the same fail-open semantic as `allowedSessions` and
 * `allowedChats`, so every key minted before this column keeps exactly the access its role already
 * gave it. The column is `simple-array` on the entity, so it is stored as a comma-joined `text`
 * column here, exactly like the two scope columns.
 *
 * Runs on the **main** connection (auth), which is always SQLite. Idempotent: the column is probed
 * before the ALTER, so a run interrupted after the DDL still completes and a database previously
 * created by `synchronize` is safe to adopt.
 */
export class AddApiKeyDeniedPermissions1794000000000 implements MigrationInterface {
  name = 'AddApiKeyDeniedPermissions1794000000000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'api_keys' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("api_keys")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasColumn(queryRunner, 'deniedPermissions'))) {
      await queryRunner.query(`ALTER TABLE "api_keys" ADD COLUMN "deniedPermissions" text NULL`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await this.hasColumn(queryRunner, 'deniedPermissions')) {
      await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "deniedPermissions"`);
    }
  }
}
