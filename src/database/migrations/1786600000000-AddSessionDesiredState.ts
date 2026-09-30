import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `sessions.desiredState`: 'stopped' once an operator stops a session, cleared by an explicit
 * start. Boot auto-start and the takeover sweep skip stopped rows, so a deliberate stop is no
 * longer undone by the next restart. NULL for every existing row, which keeps today's behaviour.
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres.
 */
export class AddSessionDesiredState1786600000000 implements MigrationInterface {
  name = 'AddSessionDesiredState1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('sessions', 'desiredState')) return;
    await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "desiredState" varchar(20)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('sessions', 'desiredState'))) return;
    await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "desiredState"`);
  }
}
