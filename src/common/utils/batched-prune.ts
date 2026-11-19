import { setImmediate, setTimeout } from 'timers/promises';
import type { FindOptionsOrder, FindOptionsSelect, FindOptionsWhere, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

/**
 * Rows one prune statement removes. Far below the bind-parameter limit of either dialect, and on SQLite, where a
 * statement runs on the event loop, about 5 ms for a plain row and about 35 ms for a message with its full-text
 * trigger, so the process is never held for long at a time.
 */
export const PRUNE_BATCH_SIZE = 500;

/**
 * How many statements one id read feeds on PostgreSQL, the figure a session delete measured for the tables that
 * have no index to order their rows: a read after every statement goes back over the entries of rows already
 * deleted that a vacuum has not yet removed, and took longer than linear. Equals SESSION_DELETE_READ_AHEAD_POSTGRES,
 * restated because importing the session module from the services that prune would load it in a cycle.
 */
export const PRUNE_READ_AHEAD_POSTGRES = 20;

/**
 * The pause after a SQLite statement, which lets a request that takes several turns of the event loop finish before
 * the next statement starts; one turn was not enough. Equals SESSION_DELETE_PAUSE_MS_SQLITE.
 */
export const PRUNE_PAUSE_MS_SQLITE = 5;

export interface PruneInBatchesOptions<T extends { id: string }> {
  repository: Repository<T>;
  /** The rows to remove or clear. An array is an OR of conditions. */
  where: FindOptionsWhere<T> | FindOptionsWhere<T>[];
  /**
   * The order of the id read. Leave it out unless an index serves it: on a column without one every read sorts the
   * whole table again, which took ten times as long as reading any of the matching rows.
   */
  order?: FindOptionsOrder<T>;
  /** Set these columns on the rows instead of deleting them. They must leave `where`, or the run never ends. */
  clear?: QueryDeepPartialEntity<T>;
  /** The most rows one run handles; the rest wait for the next run. */
  maxRows?: number;
  /** True once the owner is shutting down. It is read before every statement, and the run ends there. */
  stopped?: () => boolean;
}

/**
 * Remove (or clear) every row matching `where` in statements of PRUNE_BATCH_SIZE ids, and return how many rows
 * the statements changed. One statement over a backlog (a start after a long stop, a shorter retention window,
 * receivers that were down for days) held the process for as long as it ran on SQLite, which runs a statement on
 * the event loop (about 0.45 s at 100,000 rows and 2 s at 400,000), and on PostgreSQL ran past the statement
 * timeout, was rolled back and never shrank the backlog. Batching alone is not enough: every await of a
 * better-sqlite3 query resolves as a microtask, so the loop also gives up the event loop between statements.
 */
export async function pruneInBatches<T extends { id: string }>(options: PruneInBatchesOptions<T>): Promise<number> {
  const { repository, where, order, clear, stopped } = options;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const postgres = repository.manager.connection.options.type === 'postgres';
  const window = postgres ? PRUNE_BATCH_SIZE * PRUNE_READ_AHEAD_POSTGRES : PRUNE_BATCH_SIZE;
  let handled = 0;
  while (handled < maxRows && !stopped?.()) {
    const take = Math.min(window, maxRows - handled);
    const rows = await repository.find({ select: { id: true } as FindOptionsSelect<T>, where, order, take });
    for (let from = 0; from < rows.length; from += PRUNE_BATCH_SIZE) {
      if (stopped?.()) return handled;
      const ids = rows.slice(from, from + PRUNE_BATCH_SIZE).map(row => row.id);
      const result = clear ? await repository.update(ids, clear) : await repository.delete(ids);
      handled += result.affected ?? 0;
      // Nothing follows a short read once its rows are handled: no pause to wait out.
      if (from + PRUNE_BATCH_SIZE < rows.length || rows.length === take) {
        await (postgres ? setImmediate() : setTimeout(PRUNE_PAUSE_MS_SQLITE));
      }
    }
    if (rows.length < take) break;
  }
  return handled;
}
