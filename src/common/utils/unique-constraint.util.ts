/**
 * True when `err` is a unique-constraint violation, across SQLite and PostgreSQL. TypeORM wraps
 * driver errors in QueryFailedError; the dialect-specific detail sits on `driverError`. Used to tell
 * a duplicate-key insert (skip it) apart from a genuine persistence failure (must not be swallowed).
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; driverError?: { code?: string; message?: string } };
  const code = e.driverError?.code ?? e.code;
  const message = e.driverError?.message ?? e.message ?? '';
  if (code === '23505') return true; // PostgreSQL unique_violation
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true; // SQLite
  if (code != null) return false; // a decisive non-unique code wins over a misleading message
  return /UNIQUE constraint failed/i.test(message); // SQLite fallback (message only)
}
