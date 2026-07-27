import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the dispatch-lifecycle columns the ingress reconciler sweeps on:
 * `dispatchState` ('pending' | 'dispatched' | 'failed'), `dispatchAttempts`, `lastDispatchAt`,
 * plus the (dispatchState, createdAt) sweep index.
 *
 * Backfill: `dispatchState` is added NULL-able with NO default and every EXISTING row is stamped
 * 'dispatched' in the same statement batch — history was delivered by definition (or is old enough
 * that replaying it now would be worse than losing nothing), so only rows persisted AFTER this
 * migration are watched. Deliberately NOT `DEFAULT 'pending'` + no backfill guard on new rows:
 * a default would also stamp pre-upgrade rows on a synchronize-bootstrapped DB (where this
 * migration never runs), and the reconciler would mass-replay the entire dedup log on deploy.
 * recordOrSkip writes 'pending' explicitly, so new rows need no default.
 *
 * Dual-dialect (SQLite + PostgreSQL), idempotent via an information_schema/PRAGMA column probe
 * (mirrors AddMessageAuthor). Hand-authored because `synchronize` is off for the `data` connection
 * on PostgreSQL (and optional on SQLite via DATABASE_SYNCHRONIZE=false).
 */
export class AddIngressEventDispatchState1785112230000 implements MigrationInterface {
  name = 'AddIngressEventDispatchState1785112230000';

  private async hasColumn(queryRunner: QueryRunner, name: string): Promise<boolean> {
    if (queryRunner.connection.options.type === 'postgres') {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'ingress_events' AND column_name = '${name}'`,
      )) as unknown[];
      return rows.length > 0;
    }
    const rows = (await queryRunner.query(`PRAGMA table_info("ingress_events")`)) as Array<{ name: string }>;
    return rows.some(r => r.name === name);
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const ts = isPostgres ? 'timestamp' : 'datetime';

    if (!(await this.hasColumn(queryRunner, 'dispatchState'))) {
      await queryRunner.query(`ALTER TABLE "ingress_events" ADD COLUMN "dispatchState" varchar NULL`);
      // Backfill ONLY runs when this migration adds the column: every row that existed before the
      // upgrade is indistinguishable from a never-dispatched one (all read NULL), so stamp them all
      // 'dispatched'. Rows inserted after the migration are 'pending' (recordOrSkip) and must never
      // be re-stamped — the column-exists guard above makes a re-run skip this UPDATE entirely.
      await queryRunner.query(
        `UPDATE "ingress_events" SET "dispatchState" = 'dispatched' WHERE "dispatchState" IS NULL`,
      );
    }
    if (!(await this.hasColumn(queryRunner, 'dispatchAttempts'))) {
      await queryRunner.query(`ALTER TABLE "ingress_events" ADD COLUMN "dispatchAttempts" integer NOT NULL DEFAULT 0`);
    }
    if (!(await this.hasColumn(queryRunner, 'lastDispatchAt'))) {
      await queryRunner.query(`ALTER TABLE "ingress_events" ADD COLUMN "lastDispatchAt" ${ts} NULL`);
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ingress_events_dispatchState" ON "ingress_events" ("dispatchState", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ingress_events_dispatchState"`);
    if (await this.hasColumn(queryRunner, 'lastDispatchAt')) {
      await queryRunner.query(`ALTER TABLE "ingress_events" DROP COLUMN "lastDispatchAt"`);
    }
    if (await this.hasColumn(queryRunner, 'dispatchAttempts')) {
      await queryRunner.query(`ALTER TABLE "ingress_events" DROP COLUMN "dispatchAttempts"`);
    }
    if (await this.hasColumn(queryRunner, 'dispatchState')) {
      await queryRunner.query(`ALTER TABLE "ingress_events" DROP COLUMN "dispatchState"`);
    }
  }
}
