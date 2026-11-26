import { createLogger } from '../common/services/logger.service';
import { tightenSqliteFilePermissions } from './sqlite-file-permissions';

export type SqliteJournalMode = 'WAL' | 'DELETE';

export interface BetterSqlite3Like {
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

const logger = createLogger('SqlitePragmas');

/**
 * What the write-ahead log is cut back to when it starts over. A reader holding a snapshot (a data
 * export, for as long as its download runs) keeps it from starting over, so it grows by everything
 * written meanwhile, and without a limit it kept that size until a clean stop.
 */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Resolves the configured SQLite journal mode from environment or config.
 * Defaults to WAL for concurrent reads during writes and crash resilience;
 * DELETE is the opt-out for network filesystems (NFS/SMB) where WAL shared memory is unsafe.
 */
export function resolveSqliteJournalMode(raw?: string): SqliteJournalMode {
  return raw === 'DELETE' ? 'DELETE' : 'WAL';
}

/**
 * Strictly validates and resolves `SQLITE_JOURNAL_MODE` for standalone entry points (such as the
 * TypeORM CLI data sources) that bypass NestJS `ConfigModule` boot validation. Mirrors
 * `env.validation.ts`: only unset, whitespace-only, `"WAL"`, or `"DELETE"` are accepted.
 */
export function parseStrictSqliteJournalMode(raw?: string): SqliteJournalMode {
  if (raw === undefined || raw.trim() === '') return 'WAL';
  if (raw === 'WAL' || raw === 'DELETE') return raw;
  throw new Error(`SQLITE_JOURNAL_MODE must be one of "WAL", "DELETE" (got ${JSON.stringify(raw)})`);
}

/**
 * Returns a TypeORM better-sqlite3 `prepareDatabase` hook that:
 * 1. Skips `:memory:` databases.
 * 2. Tightens the database file (and any existing sidecars) to 0600 before switching journal mode
 *    so newly created `-wal` and `-shm` sidecars inherit owner-only permissions automatically.
 * 3. Configures WAL with `synchronous = NORMAL` and a 64 MiB `journal_size_limit` by default, or
 *    explicitly switches back to `journal_mode = DELETE` with `synchronous = FULL` so existing WAL
 *    databases convert cleanly back to rollback-journal mode when opted out.
 */
export function createSqlitePrepareDatabase(
  dbPath: string,
  journalMode: SqliteJournalMode = 'WAL',
): (db: BetterSqlite3Like) => void {
  return (db: BetterSqlite3Like): void => {
    if (dbPath.trim() === ':memory:') return;

    tightenSqliteFilePermissions([dbPath], message => logger.warn(message));

    if (journalMode === 'WAL') {
      // SQLite answers with the mode in effect, and keeps the previous one when the filesystem cannot hold WAL.
      const mode = String(db.pragma('journal_mode = WAL', { simple: true }));
      const inWal = mode.toLowerCase() === 'wal';
      if (!inWal) {
        logger.warn(
          `SQLite kept journal mode "${mode}" for ${dbPath} instead of WAL; ` +
            'set SQLITE_JOURNAL_MODE=DELETE when the database is on a filesystem without WAL support',
        );
      }
      // NORMAL is corruption-safe only in WAL; under a rollback journal it takes FULL, as the opt-out does.
      db.pragma(`synchronous = ${inWal ? 'NORMAL' : 'FULL'}`);
      db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
    } else {
      db.pragma('journal_mode = DELETE');
      db.pragma('synchronous = FULL');
    }
  };
}
