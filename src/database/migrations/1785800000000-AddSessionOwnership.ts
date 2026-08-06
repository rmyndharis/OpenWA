import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `nodeId`, `claimedAt` and `leaseExpiresAt` to `sessions`, recording which process currently
 * hosts a session's engine.
 *
 * A session's engine lives in one process, but nothing said which. On startup the service reset
 * every session in an active status to `disconnected`, on the reasonable assumption that no engine
 * survives a restart — true of the only process, and false the moment a second one exists, where a
 * booting replica would flip the status of sessions another replica is actively running.
 *
 * The lease is what makes the claim safe to hold. A process that dies without releasing leaves rows
 * pointing at a node that is gone; rather than requiring a clean shutdown for recovery, a claim
 * simply stops being honoured once `leaseExpiresAt` passes, so any process may take it over. A
 * running owner keeps extending it.
 *
 * All three are NULL for every existing row, which reads as unclaimed — so a single-process
 * deployment behaves exactly as before: it claims what it finds and resets it as it always did.
 *
 * Hand-authored because `synchronize` is off for the `data` connection on PostgreSQL. Idempotent:
 * each column is probed independently, so a run interrupted between ALTERs still completes.
 */
export class AddSessionOwnership1785800000000 implements MigrationInterface {
  name = 'AddSessionOwnership1785800000000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'sessions' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("sessions")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const timestamp = queryRunner.connection.options.type === 'postgres' ? 'TIMESTAMP' : 'datetime';
    if (!(await this.hasColumn(queryRunner, 'nodeId'))) {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "nodeId" varchar(190) NULL`);
    }
    if (!(await this.hasColumn(queryRunner, 'claimedAt'))) {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "claimedAt" ${timestamp} NULL`);
    }
    if (!(await this.hasColumn(queryRunner, 'leaseExpiresAt'))) {
      await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "leaseExpiresAt" ${timestamp} NULL`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of ['leaseExpiresAt', 'claimedAt', 'nodeId']) {
      if (await this.hasColumn(queryRunner, column)) {
        await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "${column}"`);
      }
    }
  }
}
