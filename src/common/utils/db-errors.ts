import { QueryFailedError } from 'typeorm';

/** Structural view of the driver errors these predicates classify, so classification survives realms. */
type DriverErrorShape = { code?: string; message?: string };
type DriverErrorWrapperShape = { name?: unknown; code?: string; message?: string; driverError?: DriverErrorShape };

// These predicates must not rely on `instanceof` alone: the errors they classify can arrive from
// another realm — better-sqlite3's native addon is cached process-wide and builds its SqliteError from
// whichever realm (jest module registry / vm context) loaded it first, and each copy of typeorm carries
// a distinct QueryFailedError class. Both classes set a stable `name` (better-sqlite3 via a prototype
// descriptor, TypeORM via TypeORMError's `get name()`), so classify on that.
function isNamedError(err: unknown, name: string): err is DriverErrorWrapperShape {
  return typeof err === 'object' && err !== null && (err as DriverErrorWrapperShape).name === name;
}

function isQueryFailedErrorLike(err: unknown): err is DriverErrorWrapperShape {
  return err instanceof QueryFailedError || isNamedError(err, 'QueryFailedError');
}

/**
 * Cross-dialect unique-constraint-violation check by driver code/message, for the two dialects we ship
 * (sqlite dev, postgres prod). Lets insert-or-converge (RMW) paths distinguish a real duplicate from an
 * unrelated failure without depending on a specific driver. Add another branch if a third driver is ever
 * supported.
 *
 * Precision matters as much as recall: SQLite prefixes EVERY constraint failure with
 * SQLITE_CONSTRAINT (FK, NOT NULL, CHECK included), so a prefix match would swallow a genuine
 * persistence failure as "already stored": the message-projector would mark a message
 * isNewMessage=false on an FK error and drop it, and session/template creates would answer a
 * misleading 409. Only the unique/primary-key suffixes classify; a decisive non-unique code wins over
 * a misleading message.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as DriverErrorWrapperShape;
  const code = e.driverError?.code ?? e.code;
  if (code === '23505') return true; // postgres unique_violation
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true; // sqlite
  // Every real constraint failure carries its suffix (FOREIGNKEY/NOTNULL/CHECK included), so those are
  // decisive rejections. The one ambiguous shape is the BARE unsuffixed code: defer it to the message.
  if (code != null && code !== 'SQLITE_CONSTRAINT') return false;
  const message = e.driverError?.message ?? e.message ?? '';
  return /UNIQUE constraint failed/i.test(message); // sqlite fallback (message only)
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
  if (isQueryFailedErrorLike(err)) {
    const driver = err.driverError;
    if (driver?.code === '42P01') return true; // postgres undefined_table
    const message = `${driver?.message ?? ''} ${err.message ?? ''}`;
    return /no such table/i.test(message);
  }
  // better-sqlite3 rejects a missing table at prepare() time. Since typeorm 1.1.1 BetterSqlite3QueryRunner
  // prepares inside its try/catch, so that error arrives wrapped in QueryFailedError (message
  // 'SqliteError: no such table: x') and the branch above matches it. Up to 1.1.0 the prepare sat outside
  // the try/catch and the RAW SqliteError escaped unwrapped; that shape is still recognized, for an older
  // TypeORM copy or a direct driver call. Match it exactly (class name + message): a plain Error whose
  // text happens to mention a missing table must still NOT classify.
  return isNamedError(err, 'SqliteError') && /no such table/i.test(err.message ?? '');
}
