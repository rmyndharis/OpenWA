import { MigrationInterface, QueryRunner } from 'typeorm';
import { repairSqliteMessageFts } from '../sqlite-message-fts';

/**
 * Rebuild the SQLite full-text index when it no longer matches `messages`. Rows that predate
 * 1782400000000 with a NULL body, a synchronize-built index adopted by that migration's second backfill,
 * and a table rebuild that renumbered rowids all leave an index that still answers, but for the wrong
 * messages. A healthy index is left alone, so a fresh database pays one integrity check and nothing else.
 * PostgreSQL maintains its `tsvector` column itself.
 */
export class RepairSqliteMessageFts1791600000000 implements MigrationInterface {
  name = 'RepairSqliteMessageFts1791600000000';

  async up(runner: QueryRunner): Promise<void> {
    if (runner.dataSource.options.type !== 'better-sqlite3') return;
    await repairSqliteMessageFts(runner);
  }

  async down(): Promise<void> {
    // The previous inconsistent index is not restored.
  }
}
