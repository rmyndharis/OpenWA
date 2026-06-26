import { isUniqueConstraintError } from './unique-constraint.util';

describe('isUniqueConstraintError', () => {
  it('recognizes a PostgreSQL unique_violation (code 23505)', () => {
    expect(isUniqueConstraintError({ driverError: { code: '23505' } })).toBe(true);
  });

  it('recognizes a SQLite constraint error by code', () => {
    expect(isUniqueConstraintError({ driverError: { code: 'SQLITE_CONSTRAINT_UNIQUE' } })).toBe(true);
  });

  it('recognizes a SQLite constraint error by message', () => {
    expect(isUniqueConstraintError(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: messages.sessionId'))).toBe(
      true,
    );
  });

  it('returns false for a non-unique DB error (e.g. FK violation 23503)', () => {
    expect(isUniqueConstraintError({ driverError: { code: '23503' } })).toBe(false);
  });

  it('returns false for an unrelated error and for null', () => {
    expect(isUniqueConstraintError(new Error('boom'))).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });

  it('does not false-positive on a non-unique code whose message contains the unique phrase', () => {
    expect(isUniqueConstraintError({ driverError: { code: '23503', message: 'UNIQUE constraint failed: x' } })).toBe(
      false,
    );
  });
});
