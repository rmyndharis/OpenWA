import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sessions.leaseGeneration` — the fencing token bumped by every successful claim. `nodeId`
 * cannot distinguish two incarnations of the same node (the default id is the hostname), so a
 * zombie previous process could keep renewing and writing as if it still owned a session. With the
 * generation in every ownership-conditional WHERE, a stale writer's UPDATE matches zero rows.
 */
export class AddSessionLeaseGeneration1786400000000 implements MigrationInterface {
  name = 'AddSessionLeaseGeneration1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('sessions', 'leaseGeneration')) return;
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "leaseGeneration" integer NOT NULL DEFAULT (0)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "leaseGeneration"`);
  }
}
