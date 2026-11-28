import { AsyncLocalStorage } from 'async_hooks';
import { setImmediate, setTimeout } from 'timers/promises';
import type { DataSource, QueryRunner } from 'typeorm';

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

type SharedConnection = { inTransaction?: unknown; prepare?: (sql: string) => { get(): unknown } };

const sharedConnectionOf = (dataSource: DataSource): SharedConnection | undefined =>
  (dataSource.driver as { databaseConnection?: SharedConnection } | undefined)?.databaseConnection;

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
 *
 * While a restore holds the connection (holdSharedConnection), the wait queues behind it with the statements it
 * holds, and the bound counts from its turn: a restore takes as long as the database it replaces.
 */
export async function awaitNoOpenTransaction(
  dataSource: DataSource,
  boundMs = FOREIGN_TRANSACTION_WAIT_MS,
): Promise<boolean> {
  if (!SHARED_CONNECTION_DIALECTS.has(dataSource.options.type)) return true;
  const gate = gates.get(dataSource);
  if (gate) await admission(gate);
  const connection = sharedConnectionOf(dataSource);
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

/**
 * The readiness probe's `SELECT 1`, which goes past a restore's hold (holdSharedConnection). It reads no table, so a
 * restore's write lock on another connection never makes it wait, and a held probe would report a single-node gateway
 * down, with nothing to fail over to, for the whole restore.
 */
export function selectOne(dataSource: DataSource): Promise<unknown> {
  const gate = gates.get(dataSource);
  if (!gate) return dataSource.query('SELECT 1');
  // On the handle itself: the runner's own query would wait behind the hold at its connect.
  return new Promise(resolve => resolve(gate.connection.prepare?.('SELECT 1').get()));
}

/** A restore that holds the shared connection while it writes on a connection of its own. */
export interface SharedConnectionHold {
  /** Runs `work` as the restore: a statement it issues on the shared connection fails instead of waiting for itself. */
  asRestore<T>(work: () => Promise<T>): Promise<T>;
  /** Runs `work` ahead of the callers held: the restore's own follow-up once it has let them through. */
  asOwner<T>(work: () => Promise<T>): Promise<T>;
  /** Lets the callers held through, in the order they came, one per turn of the event loop. Idempotent. */
  release(): void;
}

/** The runner methods that reach the connection. */
const HELD_METHODS = ['query', 'startTransaction', 'connect'] as const;

/** Turns a release waits for a transaction a caller let through left open, before it lets the next one through. */
const OPEN_TRANSACTION_TURNS = 50;

interface Gate {
  runner: QueryRunner;
  connection: SharedConnection;
  queue: Array<() => void>;
  released: boolean;
  /** A caller let through runs: every statement passes until its chain of microtasks has run. */
  passing: boolean;
  waitedTurns: number;
  restoreToken: object;
  ownerToken: object;
}

const gates = new WeakMap<DataSource, Gate>();
const holder = new AsyncLocalStorage<object>();
/** Each hold not yet released, as the promise its release resolves. */
const closedHolds = new Set<Promise<void>>();

/** Resolves once every restore holding a shared connection now has released it; undefined when none holds one. */
export function sharedConnectionHeld(): Promise<void> | undefined {
  return closedHolds.size > 0 ? Promise.all(closedHolds).then(() => undefined) : undefined;
}

const transactionOpen = (gate: Gate): boolean =>
  gate.connection.inTransaction === true || gate.runner.isTransactionActive;

/** Undefined when the caller goes on at once, otherwise a promise that resolves on its turn. */
function admission(gate: Gate): Promise<void> | undefined {
  const token = holder.getStore();
  // It would wait for the restore it is part of.
  if (token === gate.restoreToken) return Promise.reject(new Error('the restore must use its own connection'));
  // Once released, a transaction still open is the one a caller let through is running: its statements pass.
  if (token === gate.ownerToken || gate.passing || (gate.released && transactionOpen(gate))) return undefined;
  return new Promise(resolve => gate.queue.push(resolve));
}

/**
 * Hold every statement, transaction and connect on the shared connection's runner, which better-sqlite3 hands out
 * as one per DataSource, until the hold is released; resolves undefined when a transaction stayed open on it past
 * `boundMs`. The hold is taken on a turn of the event loop that sees no transaction open, as awaitNoOpenTransaction
 * judges it, and in the same synchronous step.
 *
 * A caller held waits as one would on a loop that was blocked, and goes on later: its reads see what the restore
 * left, and its writes land after it, never inside it.
 */
export async function holdSharedConnection(
  dataSource: DataSource,
  boundMs = FOREIGN_TRANSACTION_WAIT_MS,
): Promise<SharedConnectionHold | undefined> {
  const settleBy = Date.now() + boundMs;
  for (;;) {
    const hold = await new Promise<SharedConnectionHold | undefined>(resolve =>
      globalThis.setImmediate(() => resolve(tryHold(dataSource))),
    );
    if (hold || Date.now() >= settleBy) return hold;
    await setTimeout(5);
  }
}

function tryHold(dataSource: DataSource): SharedConnectionHold | undefined {
  const connection = sharedConnectionOf(dataSource);
  const runner = dataSource.createQueryRunner();
  // A hold still letting callers through is waited out like a transaction.
  if (gates.has(dataSource) || connection?.inTransaction !== false || runner.isTransactionActive) return undefined;
  const gate: Gate = {
    runner,
    connection,
    queue: [],
    released: false,
    passing: false,
    waitedTurns: 0,
    restoreToken: {},
    ownerToken: {},
  };
  const target = runner as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const previous = HELD_METHODS.map(name => [name, Object.getOwnPropertyDescriptor(runner, name)] as const);
  for (const name of HELD_METHODS) {
    const original = target[name];
    target[name] = (...args: unknown[]): Promise<unknown> => {
      const turn = admission(gate);
      return turn ? turn.then(() => original.apply(runner, args)) : original.apply(runner, args);
    };
  }
  gates.set(dataSource, gate);
  let opened = (): void => undefined;
  const closed = new Promise<void>(resolve => (opened = resolve));
  closedHolds.add(closed);

  const nextTurn = (): void => {
    if (transactionOpen(gate) && gate.waitedTurns < OPEN_TRANSACTION_TURNS) {
      gate.waitedTurns++;
      globalThis.setImmediate(nextTurn);
      return;
    }
    gate.waitedTurns = 0;
    const next = gate.queue.shift();
    if (!next) {
      // Put back exactly what was there: an own property (a spy) stays, an inherited method is uncovered again.
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(runner, name, descriptor);
        else delete target[name];
      }
      gates.delete(dataSource);
      return;
    }
    gate.passing = true;
    next();
    // A nextTick queued from a microtask runs once the microtask queue is empty, that is once the caller let
    // through has run as far as it goes without the event loop. Its own next statement must not queue behind the
    // others: a later caller would then run inside its transaction.
    queueMicrotask(() =>
      process.nextTick(() => {
        gate.passing = false;
        globalThis.setImmediate(nextTurn);
      }),
    );
  };

  return {
    asRestore: work => holder.run(gate.restoreToken, work),
    asOwner: work => holder.run(gate.ownerToken, work),
    release: () => {
      if (gate.released) return;
      gate.released = true;
      closedHolds.delete(closed);
      opened();
      globalThis.setImmediate(nextTurn);
    },
  };
}
