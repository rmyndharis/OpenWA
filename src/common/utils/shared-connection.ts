import { setImmediate, setTimeout } from 'timers/promises';
import type { DataSource } from 'typeorm';

/**
 * Dialects where every TypeORM query runner shares ONE connection, so an open transaction is visible
 * to anything else querying in the same process. A positive list on purpose: a dialect nobody has
 * classified must not silently opt into suspending a safety mechanism.
 */
export const SHARED_CONNECTION_DIALECTS = new Set(['better-sqlite3', 'sqlite']);

/**
 * How long a caller waits for another transaction on the shared connection to end. Those transactions are
 * short (a session create, the closing transaction of a delete); the bound is for one that never ends.
 */
export const FOREIGN_TRANSACTION_WAIT_MS = 10_000;

/**
 * Wait until no transaction is open on a connection that every query runner shares. A transaction opened in the
 * same synchronous step as the resolve is then the caller's own: TypeORM would otherwise open it as a SAVEPOINT
 * inside the other one, and whether its writes last would depend on how that one ends. Resolves true at once on
 * a dialect that gives each runner its own connection, and false when the bound ran out with a transaction open.
 *
 * The check runs on a turn of the event loop of its own. better-sqlite3 runs each statement synchronously, so a
 * transaction that awaits nothing but its statements, as every one in this code base does, begins and ends within
 * one turn: none is half done when the check runs, and none can begin inside the caller's before it ends.
 *
 * It reads the connection's own state rather than the runner's isTransactionActive, which stays set for good after
 * a BEGIN that failed.
 */
export async function awaitNoOpenTransaction(
  dataSource: DataSource,
  boundMs = FOREIGN_TRANSACTION_WAIT_MS,
): Promise<boolean> {
  if (!SHARED_CONNECTION_DIALECTS.has(dataSource.options.type)) return true;
  const connection = (dataSource.driver as { databaseConnection?: { inTransaction?: unknown } } | undefined)
    ?.databaseConnection;
  // A connection that does not report its state (node-sqlite3, or none at all) has nothing to wait on.
  if (typeof connection?.inTransaction !== 'boolean') return true;
  const settleBy = Date.now() + boundMs;
  await setImmediate();
  while (connection.inTransaction) {
    if (Date.now() >= settleBy) return false;
    await setTimeout(5);
  }
  return true;
}
