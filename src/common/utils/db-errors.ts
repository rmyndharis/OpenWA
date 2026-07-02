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
