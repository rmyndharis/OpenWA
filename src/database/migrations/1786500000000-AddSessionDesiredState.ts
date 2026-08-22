import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sessions.desiredState` ('running' | 'stopped') — operator INTENT, as opposed to `status`,
 * which is observed engine state. Reconciliation (boot auto-start, takeover sweep, worker claim
 * loop) acts on intent: restart what should be up, never resurrect what an operator stopped.
 *
 * Backfill mirrors the pre-column behavior exactly: boot auto-start relaunched every authenticated
 * (phone set) non-FAILED session, so those become 'running' and nothing changes on upgrade. New
 * sessions default to 'stopped' until their first successful start.
 */
export class AddSessionDesiredState1786500000000 implements MigrationInterface {
  name = 'AddSessionDesiredState1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('sessions', 'desiredState')) return;
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD COLUMN "desiredState" varchar(10) NOT NULL DEFAULT ('stopped')`,
    );
    await queryRunner.query(
      `UPDATE "sessions" SET "desiredState" = 'running' WHERE "phone" IS NOT NULL AND "status" != 'failed'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "desiredState"`);
  }
}
