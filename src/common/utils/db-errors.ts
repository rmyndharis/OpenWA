import { QueryFailedError } from 'typeorm';

/**
 * Cross-dialect unique-constraint-violation check by driver code/message, for the two dialects we ship
 * (sqlite dev, postgres prod). Lets insert-or-converge (RMW) paths distinguish a real duplicate from an
 * unrelated failure without depending on a specific driver. Add another branch if a third driver is ever
 * supported.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driver = err.driverError as { code?: string; message?: string } | undefined;
  const code = driver?.code ?? '';
  const message = driver?.message ?? err.message ?? '';
  return code === '23505' /* postgres */ || /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(message);
}

/**
 * Cross-dialect "the table does not exist" check. Used to keep a table-clearing DELETE tolerant of a
 * genuinely-absent table while STILL surfacing every other failure (lock, I/O, syntax) — the opposite of
 * a blind `.catch(() => {})`. Postgres has a precise code (42P01 undefined_table). SQLite is matched by
 * MESSAGE only: its generic `SQLITE_ERROR` code (errno 1) is shared with syntax and other real errors, so
 * a code check would over-swallow. The message is read from both the driver error and the wrapped
 * QueryFailedError so a future TypeORM change to the nesting fails toward the regex still matching.
 */
export function isMissingTableError(err: unknown): boolean {
  if (err instanceof QueryFailedError) {
    const driver = err.driverError as { code?: string; message?: string } | undefined;
    if (driver?.code === '42P01') return true; // postgres undefined_table
    const message = `${driver?.message ?? ''} ${err.message ?? ''}`;
    return /no such table/i.test(message);
  }
  // better-sqlite3 validates SQL at prepare() time, and TypeORM's BetterSqlite3QueryRunner creates the
  // statement OUTSIDE its try/catch — so a missing-table error surfaces as the RAW SqliteError, never
  // wrapped in QueryFailedError. Recognize that exact shape (class name + message); a plain Error whose
  // text happens to mention a missing table must still NOT classify.
  return err instanceof Error && err.name === 'SqliteError' && /no such table/i.test(err.message);
}
