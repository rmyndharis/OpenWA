import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sessions.nodeUrl` — where the owning node answers HTTP, written at claim time from
 * NODE_URL, so a peer can forward a session-scoped request to the node actually hosting the
 * engine. Hand-authored because `synchronize` is off on the `data` connection for Postgres.
 */
export class AddSessionNodeUrl1786000000000 implements MigrationInterface {
  name = 'AddSessionNodeUrl1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('sessions', 'nodeUrl')) return;
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "nodeUrl" varchar(2048)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('sessions', 'nodeUrl'))) return;
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "nodeUrl"`);
  }
}
