import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `baileys_auth_state` — database-backed Baileys credentials and Signal keys, the portable
 * alternative to the multi-file auth directory (BAILEYS_AUTH_STORE=database). One row per value,
 * keyed by (sessionName, keyType, keyId) exactly like the on-disk layout keys files, so a disk
 * import is a verbatim copy. `value` is the BufferJSON-serialized JSON string.
 *
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres. The composite
 * primary key doubles as the lookup index for every read path (always sessionName + keyType +
 * ids), so no secondary index is needed.
 */
export class AddBaileysAuthState1786300000000 implements MigrationInterface {
  name = 'AddBaileysAuthState1786300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('baileys_auth_state')) return;
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    // @UpdateDateColumn: TypeORM emits `datetime` with a datetime('now') default on SQLite and
    // `timestamp` with now() on Postgres — the drift gate compares against that metadata.
    const updatedTs = isPostgres ? 'timestamp' : 'datetime';
    const now = isPostgres ? 'NOW()' : `(datetime('now'))`;

    await queryRunner.query(
      `CREATE TABLE "baileys_auth_state" ("sessionName" varchar NOT NULL, "keyType" varchar NOT NULL, ` +
        `"keyId" varchar NOT NULL, "value" text NOT NULL, "updatedAt" ${updatedTs} NOT NULL DEFAULT ${now}, ` +
        `PRIMARY KEY ("sessionName", "keyType", "keyId"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "baileys_auth_state"`);
  }
}
