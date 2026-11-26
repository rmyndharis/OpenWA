import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop, setTimeout as pause } from 'node:timers/promises';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { LoggerService } from '../../common/services/logger.service';

/**
 * One fixed state of the data database, which every read of an export goes through. The archive is
 * sent while its rows are still being read, over minutes for a slow client, and the import restores
 * whatever it holds: read from the live tables, it could hold the messages of a session deleted
 * meanwhile, or half of one.
 */
export interface ExportSnapshot {
  /** The instant the snapshot describes: nothing committed after it is in the archive. */
  readonly at: Date;
  /** A failed statement ends the snapshot's transaction, so one that may fail runs inside a savepoint. */
  readonly failedStatementAborts: boolean;
  /** The bound-parameter marker of the dialect, for the 1-based position. */
  placeholder(position: number): string;
  query<T = unknown[]>(sql: string, params?: unknown[]): Promise<T>;
  /**
   * The rows of a statement in the order it returns them, at most `rows` at a time. Rejects before
   * any row when the statement cannot be prepared. Other statements may run between two batches.
   */
  scan(sql: string, rows: number): Promise<AsyncGenerator<unknown[], void, undefined>>;
  close(completed: boolean): Promise<void>;
}

/** The part of a better-sqlite3 connection this file uses. */
interface SqliteHandle {
  readonly name: string;
  readonly memory: boolean;
  pragma(source: string, options: { simple: true }): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; iterate(...params: unknown[]): Iterator<unknown> };
  backup(file: string, options: { progress: () => number }): Promise<unknown>;
  close(): void;
}
type SqliteHandleClass = new (file: string, options: { readonly: true; fileMustExist: true }) => SqliteHandle;

const COPY_PREFIX = 'openwa-export-snapshot-';
const COPY_FILE = /^openwa-export-snapshot-[0-9a-f-]{36}\.sqlite(-journal)?$/;

/** Pages copied per turn of the event loop: 8 MiB at the default page size, a few milliseconds. */
const COPY_PAGES_PER_STEP = 2048;
/** The whole database in one step. */
const COPY_ALL_PAGES = 0x7fffffff;
/** How long a copy refused at its first step waits before it is tried again. */
const COPY_RETRY_MS = 50;

/**
 * Free space a copy must leave beside it: the live database goes on writing to the same volume for as
 * long as the download runs, and a write that finds no room fails with SQLITE_FULL until it ends.
 */
const COPY_HEADROOM_MIN_BYTES = 256 * 1024 * 1024;
const copyHeadroomBytes = (databaseBytes: number): number =>
  Math.max(Math.ceil(databaseBytes / 10), COPY_HEADROOM_MIN_BYTES);

/** There is no room to copy the database for an export that needs a copy. Answered before the first byte. */
export class ExportSnapshotNoRoomException extends HttpException {
  constructor(directory: string, neededBytes: number, freeBytes?: number) {
    super(
      {
        statusCode: HttpStatus.INSUFFICIENT_STORAGE,
        error: 'Insufficient Storage',
        message:
          `The export reads from a copy of the database, which needs ${neededBytes} bytes in ${directory} and ` +
          `leaves ${copyHeadroomBytes(neededBytes)} more free there for the database to go on writing` +
          (freeBytes === undefined ? ', and could not be written there' : `, where ${freeBytes} are free`) +
          '. Free that much space, or back the database up with scripts/backup.sh instead.',
        code: 'EXPORT_NO_ROOM_FOR_SNAPSHOT',
      },
      HttpStatus.INSUFFICIENT_STORAGE,
    );
  }
}

const sharedConnection = (dataSource: DataSource): SqliteHandle =>
  (dataSource.driver as unknown as { databaseConnection: SqliteHandle }).databaseConnection;

/** Where a copy of this database goes: beside it, on the data volume. The shipped images cap /tmp. */
const copyDirectory = (shared: SqliteHandle): string => (shared.memory ? os.tmpdir() : path.dirname(shared.name));

function removeCopy(file: string): void {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-journal`, { force: true });
}

const CLOSED_MESSAGE = 'The export snapshot was closed while it was being read';

function sqliteSnapshot(handle: SqliteHandle, at: Date, release: () => void): ExportSnapshot {
  // close() refuses while a statement is still being stepped through.
  const scans = new Set<Iterator<unknown>>();
  // A statement returned by close() reads as finished, which would end its table early.
  let closed = false;
  return {
    at,
    failedStatementAborts: false,
    placeholder: () => '?',
    // better-sqlite3 runs a statement synchronously and its await resolves as a microtask, so reads
    // that follow each other would hold the event loop from the first to the last. Each one gives
    // up a turn instead.
    async query<T = unknown[]>(sql: string, params: unknown[] = []): Promise<T> {
      if (closed) throw new Error(CLOSED_MESSAGE);
      const rows = handle.prepare(sql).all(...params);
      await yieldToEventLoop();
      return rows as T;
    },
    scan(sql: string, rows: number): Promise<AsyncGenerator<unknown[], void, undefined>> {
      // Wrapped so a statement that cannot be prepared (a missing table) is a rejection.
      return Promise.resolve().then(() => {
        const iterator = handle.prepare(sql).iterate();
        scans.add(iterator);
        return (async function* () {
          try {
            for (;;) {
              const batch: unknown[] = [];
              while (batch.length < rows) {
                const step = iterator.next();
                if (step.done) break;
                batch.push(step.value);
              }
              if (closed) throw new Error(CLOSED_MESSAGE);
              if (batch.length > 0) yield batch;
              if (batch.length < rows) return;
              await yieldToEventLoop();
            }
          } finally {
            scans.delete(iterator);
            iterator.return?.();
          }
        })();
      });
    },
    close(): Promise<void> {
      closed = true;
      for (const iterator of scans) iterator.return?.();
      scans.clear();
      release();
      return Promise.resolve();
    },
  };
}

/**
 * WAL: a second, read-only connection holding one read transaction. It keeps seeing the database as
 * it was while the shared connection goes on writing, and it never sees a transaction that has not
 * committed. The cost is that the WAL cannot be checkpointed past the snapshot until it is closed.
 */
function openWalReader(shared: SqliteHandle): ExportSnapshot {
  const handle = new (shared.constructor as SqliteHandleClass)(shared.name, { readonly: true, fileMustExist: true });
  try {
    // BEGIN alone takes no snapshot, the first read does. Both run before this turn ends, so no
    // write of this process can fall between them and the stamp.
    handle.exec('BEGIN');
    handle.prepare('SELECT COUNT(*) FROM sqlite_master').all();
  } catch (error) {
    handle.close();
    throw error;
  }
  return sqliteSnapshot(handle, new Date(), () => handle.close());
}

/**
 * Any other journal mode, and a database in memory: a copy made with the online backup of the shared
 * connection, read through a connection of its own and removed afterwards. A reader holding a
 * transaction on the database itself would make every write fail as busy for as long as the download
 * takes. Writes made while the copy runs go into it too, so it is the database as it was when the
 * copy finished.
 */
async function openCopy(shared: SqliteHandle, signal?: AbortSignal): Promise<ExportSnapshot> {
  const directory = copyDirectory(shared);
  const neededBytes =
    Number(shared.pragma('page_count', { simple: true })) * Number(shared.pragma('page_size', { simple: true }));
  const room = await fs.promises.statfs(directory).catch(() => undefined);
  if (room && room.bavail * room.bsize < neededBytes + copyHeadroomBytes(neededBytes)) {
    throw new ExportSnapshotNoRoomException(directory, neededBytes, room.bavail * room.bsize);
  }
  const file = path.join(directory, `${COPY_PREFIX}${randomUUID()}.sqlite`);
  let handle: SqliteHandle;
  try {
    // Created first, owner-only: the copy holds everything the database does.
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
    // A first step refused (the connection inside a write transaction, or the file locked by another
    // process) reports no pages, which better-sqlite3 takes for a finished copy: it is tried again.
    for (;;) {
      // A write to a database in memory starts its copy over, so that one is copied in a single step.
      const copied = (await shared.backup(file, {
        progress: () => {
          // Throwing ends the copy before its next step; what it wrote is removed below.
          signal?.throwIfAborted();
          return shared.memory ? COPY_ALL_PAGES : COPY_PAGES_PER_STEP;
        },
      })) as { totalPages: number };
      if (copied.totalPages > 0 || neededBytes === 0) break;
      await pause(COPY_RETRY_MS, undefined, { signal }).catch(() => undefined);
      signal?.throwIfAborted();
    }
  } catch (error) {
    removeCopy(file);
    const code = (error as { code?: string } | null)?.code;
    if (code === 'SQLITE_FULL' || code === 'ENOSPC' || code === 'EDQUOT' || code === 'EROFS' || code === 'EACCES') {
      throw new ExportSnapshotNoRoomException(directory, neededBytes);
    }
    throw error;
  }
  // Still the turn in which the last step ran: nothing was written after the copy ended.
  const at = new Date();
  try {
    handle = new (shared.constructor as SqliteHandleClass)(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    removeCopy(file);
    throw error;
  }
  return sqliteSnapshot(handle, at, () => {
    handle.close();
    removeCopy(file);
  });
}

async function openPostgresSnapshot(dataSource: DataSource): Promise<ExportSnapshot> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  const release = async (): Promise<void> => {
    // A failed read leaves the transaction open, and so does a client that stops downloading.
    if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined);
    await runner.release();
  };
  try {
    await runner.startTransaction('REPEATABLE READ');
    await runner.query('SET TRANSACTION READ ONLY');
    await runner.query('SET LOCAL statement_timeout = 0');
    // A scan of a large table otherwise starts wherever another backend's scan of it has got to.
    // The inline media budget reads the same keys several times and breaks ties by their position.
    await runner.query('SET LOCAL synchronize_seqscans = off');
    // The snapshot is taken by the first statement that reads, not by BEGIN.
    await runner.query('SELECT 1');
  } catch (error) {
    await release();
    throw error;
  }
  const at = new Date();
  let cursors = 0;
  return {
    at,
    failedStatementAborts: true,
    placeholder: position => `$${position}`,
    query: <T = unknown[]>(sql: string, params?: unknown[]) => runner.query(sql, params) as Promise<T>,
    async scan(sql: string, rows: number): Promise<AsyncGenerator<unknown[], void, undefined>> {
      const cursor = `infra_export_cursor_${++cursors}`;
      await runner.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${sql}`);
      return (async function* () {
        try {
          for (;;) {
            const batch = (await runner.query(`FETCH FORWARD ${rows} FROM ${cursor}`)) as unknown[];
            if (batch.length > 0) yield batch;
            if (batch.length < rows) return;
          }
        } finally {
          // Fails inside a transaction a statement has aborted, which ends with every cursor in it.
          await runner.query(`CLOSE ${cursor}`).catch(() => undefined);
        }
      })();
    },
    async close(completed: boolean): Promise<void> {
      try {
        if (completed) await runner.commitTransaction();
      } finally {
        await release();
      }
    },
  };
}

/**
 * Open the fixed state an export reads. PostgreSQL: one REPEATABLE READ, READ ONLY transaction.
 * SQLite: a private read-only connection, on the database itself in WAL mode and on a copy otherwise.
 * `signal` refuses the open, and ends a copy while it is being written.
 */
export async function openExportSnapshot(dataSource: DataSource, signal?: AbortSignal): Promise<ExportSnapshot> {
  signal?.throwIfAborted();
  if (dataSource.options.type === 'postgres') return openPostgresSnapshot(dataSource);
  const shared = sharedConnection(dataSource);
  const walFile = !shared.memory && shared.pragma('journal_mode', { simple: true }) === 'wal';
  return walFile ? openWalReader(shared) : openCopy(shared, signal);
}

/**
 * Remove the copies an export left beside the database when its process died: nothing else would.
 * No export of this process is running yet. A database in memory is left out: its copies are in the
 * temp directory, which other processes share and the system clears.
 */
export async function sweepExportSnapshotCopies(dataSource: DataSource, logger: LoggerService): Promise<void> {
  if (dataSource.options.type === 'postgres') return;
  const shared = sharedConnection(dataSource);
  if (shared.memory) return;
  const directory = copyDirectory(shared);
  const names = await fs.promises.readdir(directory).catch(() => [] as string[]);
  for (const name of names.filter(candidate => COPY_FILE.test(candidate))) {
    try {
      await fs.promises.unlink(path.join(directory, name));
      logger.log('Removed a database copy left by an unfinished export', { file: name });
    } catch (error) {
      logger.warn('Could not remove a database copy left by an unfinished export', {
        file: name,
        error: String(error),
      });
    }
  }
}
