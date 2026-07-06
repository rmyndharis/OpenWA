import { QueryFailedError } from 'typeorm';
import { isUniqueViolation, isMissingTableError } from './db-errors';

// Realistic driver errors: sqlite3 / pg both throw an Error carrying a `code` property, which TypeORM
// wraps in QueryFailedError (message copied from the driver error).
const driverErr = (message: string, code: string): Error => Object.assign(new Error(message), { code });
const qfe = (message: string, code: string): QueryFailedError =>
  new QueryFailedError('DELETE FROM x', [], driverErr(message, code));

describe('isMissingTableError', () => {
  it('recognizes a Postgres undefined_table by its precise code (42P01)', () => {
    expect(isMissingTableError(qfe('relation "templates" does not exist', '42P01'))).toBe(true);
  });

  it('recognizes a SQLite missing table by MESSAGE, not by its generic code', () => {
    expect(isMissingTableError(qfe('SQLITE_ERROR: no such table: templates', 'SQLITE_ERROR'))).toBe(true);
  });

  it('does NOT treat a genuine SQLite failure as missing-table (it must surface)', () => {
    // A lock/IO error and a syntax error both need to propagate — swallowing them is the very bug this
    // classifier exists to prevent. Note the syntax error shares the generic SQLITE_ERROR code.
    expect(isMissingTableError(qfe('SQLITE_BUSY: database is locked', 'SQLITE_BUSY'))).toBe(false);
    expect(isMissingTableError(qfe('SQLITE_ERROR: near "FROM": syntax error', 'SQLITE_ERROR'))).toBe(false);
  });

  it('does not classify a non-QueryFailedError (even if its text mentions a missing table)', () => {
    expect(isMissingTableError(new Error('no such table: x'))).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
  });

  it('leaves isUniqueViolation behaviour intact (regression guard for the shared module)', () => {
    expect(isUniqueViolation(qfe('duplicate key value violates unique constraint', '23505'))).toBe(true);
    expect(isMissingTableError(qfe('duplicate key value violates unique constraint', '23505'))).toBe(false);
  });
});
