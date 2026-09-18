import { QueryFailedError } from 'typeorm';
import { isUniqueViolation, isMissingTableError } from './db-errors';

// Realistic driver errors: better-sqlite3 / pg both throw an Error carrying a `code` property, which
// TypeORM wraps in QueryFailedError (message copied from the driver error). better-sqlite3 messages are
// UNPREFIXED ('no such table: x'); the legacy sqlite3 driver prefixed them ('SQLITE_ERROR: no such
// table: x') — the classifiers must keep matching both shapes.
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

  it("recognizes better-sqlite3's unprefixed shapes (missing table and unique violation)", () => {
    expect(isMissingTableError(qfe('no such table: templates', 'SQLITE_ERROR'))).toBe(true);
    expect(isUniqueViolation(qfe('UNIQUE constraint failed: templates.name', 'SQLITE_CONSTRAINT_UNIQUE'))).toBe(true);
  });

  it('recognizes the RAW SqliteError better-sqlite3 throws at prepare() time when nothing wraps it', () => {
    // typeorm 1.1.1 wraps a prepare-time error in QueryFailedError; up to 1.1.0 the statement was prepared
    // outside the runner's try/catch, so a DELETE on a missing table escaped as this raw driver error.
    const raw = Object.assign(new Error('no such table: plugin_instances'), { code: 'SQLITE_ERROR' });
    raw.name = 'SqliteError';
    expect(isMissingTableError(raw)).toBe(true);
  });

  it('classifies a cross-realm-shaped error by name + message (NOT an Error instance)', () => {
    // better-sqlite3's native addon is cached process-wide, so under a multi-registry jest run a genuine
    // SqliteError can arrive rooted in another realm's Error — `instanceof` must not decide this. A plain
    // object with the right shape classifies exactly like the real thing, and so does a QueryFailedError
    // from a second copy of typeorm.
    const rawSqlite = { name: 'SqliteError', message: 'no such table: templates', code: 'SQLITE_ERROR' };
    expect(isMissingTableError(rawSqlite)).toBe(true);
    const wrappedPg = {
      name: 'QueryFailedError',
      message: 'relation "templates" does not exist',
      driverError: { code: '42P01', message: 'relation "templates" does not exist' },
    };
    expect(isMissingTableError(wrappedPg)).toBe(true);
    expect(
      isUniqueViolation({ name: 'QueryFailedError', message: 'duplicate key', driverError: { code: '23505' } }),
    ).toBe(true);
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

describe('isUniqueViolation', () => {
  it('recognizes a PostgreSQL unique_violation (code 23505), wrapped or raw-shaped', () => {
    expect(isUniqueViolation(qfe('duplicate key value violates unique constraint', '23505'))).toBe(true);
    expect(isUniqueViolation({ driverError: { code: '23505' } })).toBe(true);
  });

  it('recognizes a SQLite unique violation by its precise code (unique or primary key)', () => {
    expect(isUniqueViolation(qfe('UNIQUE constraint failed: templates.name', 'SQLITE_CONSTRAINT_UNIQUE'))).toBe(true);
    expect(isUniqueViolation({ driverError: { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' } })).toBe(true);
  });

  it('recognizes a SQLite unique violation by message when no code is present', () => {
    expect(isUniqueViolation(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.sessionId'))).toBe(true);
  });

  // SQLite prefixes EVERY constraint failure with SQLITE_CONSTRAINT; a prefix match here would
  // swallow a genuine persistence failure as "already stored" (dropped inbound messages, wrong 409s).
  it.each([
    ['a foreign-key violation', 'SQLITE_CONSTRAINT_FOREIGNKEY'],
    ['a NOT NULL violation', 'SQLITE_CONSTRAINT_NOTNULL'],
    ['a CHECK violation', 'SQLITE_CONSTRAINT_CHECK'],
    ['the Postgres FK code', '23503'],
  ])('returns false for %s, even when the message mentions uniqueness', (_label, code) => {
    expect(isUniqueViolation(qfe('UNIQUE constraint failed: x', code))).toBe(false);
    expect(isUniqueViolation({ driverError: { code } })).toBe(false);
  });

  it('returns false for an unrelated error and for null', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
