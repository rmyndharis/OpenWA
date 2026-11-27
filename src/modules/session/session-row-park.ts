import { IsNull, type FindOptionsWhere, type Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ACTIVE_STATUSES, Session, SessionStatus } from './entities/session.entity';
import {
  isDatabaseUnavailable,
  type RecoveryLoss,
  type RecoveryQueue,
  type RecoveryRecord,
} from '../../common/utils/recovery-queue';
import { type createLogger } from '../../common/services/logger.service';
import type { SessionOwnershipService } from './session-ownership.service';

/** The session-row columns whose refused writes are kept, one kept write per session and column. */
export type SessionRowField = 'status' | 'phone' | 'desiredState';
const FIELDS: readonly unknown[] = ['status', 'phone', 'desiredState'];

/**
 * A write of one column of a session row: each move sets the column to its second value where the row still holds
 * its first (null matches NULL), so a row a later write reached keeps that write. `blind` marks a write that set the
 * column whatever it held, guarded on the value this process knew it held. `with` are the columns written alongside
 * it, `owners` the claims the row may carry as the write was fenced (absent: any).
 */
export interface SessionRowWrite {
  field: SessionRowField;
  moves: Array<[string | null, string | null]>;
  blind?: boolean;
  with?: { connectedAt?: string; lastActiveAt?: string; pushName?: string };
  owners?: Array<string | null> | 'claimable';
}

/** The record of a stop (a stop, a force-kill): a row a running delete holds keeps both. */
export const STOP_MOVES: SessionRowWrite['moves'] = [
  [null, 'stopped'],
  ['deleting', 'deleting-stopped'],
];

const LOSS: Record<SessionRowField, { message: string; action: string }> = {
  status: {
    message: 'A kept status write of a session was given up; the row keeps the status before it',
    action: 'session_status_write_lost',
  },
  phone: {
    message: "A kept write of a session's phone binding was given up; the row keeps the binding before it",
    action: 'session_phone_write_lost',
  },
  desiredState: {
    message: 'A kept stop record of a session was given up; the row keeps the record before it',
    action: 'session_stop_write_lost',
  },
};

const keyOf = (sessionId: string, field: SessionRowField): string => `${sessionId}:${field}`;

/** The value a write leaves of `value`: its move's, or the value itself when no move starts there. */
const after = (moves: SessionRowWrite['moves'], value: string | null): string | null => {
  const move = moves.find(([from]) => from === value);
  return move ? move[1] : value;
};

/** `older`, then `newer`, as one write: a blind newer write sets whatever the older one left, a conditional one moves it. */
function compose(older: SessionRowWrite, newer: SessionRowWrite): SessionRowWrite {
  const froms = [...new Set([...older.moves, ...newer.moves].map(([from]) => from))];
  const moves = froms.map((from): [string | null, string | null] => [
    from,
    newer.blind ? newer.moves[0][1] : after(newer.moves, after(older.moves, from)),
  ]);
  return { ...newer, moves, with: older.with || newer.with ? { ...older.with, ...newer.with } : undefined };
}

/** A session row write the database refused, kept until it answers (see SessionRows). */
export class KeptRowWrite implements RecoveryRecord {
  readonly lane = 'session' as const;
  /** Taken back from the journal after a restart: it lands at boot, and announces nothing a dead process saw. */
  restored = false;
  private readonly size: number;

  constructor(
    readonly key: string,
    readonly sessionId: string,
    readonly write: SessionRowWrite,
    readonly since: number,
    private readonly rows: SessionRows,
  ) {
    this.size = JSON.stringify(write).length;
  }

  bytes(): number {
    return this.size;
  }

  /** A write that lands only where no later one reached the row is right whatever its age, and there is one per column. */
  ageCapped(): boolean {
    return false;
  }

  retry(): Promise<boolean> {
    return this.rows.apply(this);
  }

  lost(reason: RecoveryLoss): void {
    this.rows.released(this, reason);
  }
}

/** A kept session row write as the journal keeps it. */
interface JournaledRowWrite {
  s: string;
  t: number;
  f: SessionRowField;
  m: SessionRowWrite['moves'];
  b?: boolean;
  w?: SessionRowWrite['with'];
  n?: SessionRowWrite['owners'];
}

export interface SessionRowsDeps {
  repository: Repository<Session>;
  queue?: RecoveryQueue;
  ownership?: Pick<SessionOwnershipService, 'nodeId' | 'claimableWhere'>;
  logger: ReturnType<typeof createLogger>;
  /** A status a write kept by this process landed: announced as a live write announces it. */
  announce(sessionId: string, status: SessionStatus): void;
}

/**
 * The session row writes the database refused (a status, the number a READY links or an unlink or a logout clears,
 * an operator's stop record), kept in the recovery queue's `session` lane and its journal until it answers. One is
 * kept per session and column, a newer refused write composed over the older. A kept write lands only where no later
 * write reached the row: its moves name the values it replaces, and it lands only on a row the node that wrote it
 * still holds, or that no node holds, so a later write by this process or by another node wins. A blind write is guarded on the value this process last wrote or
 * read for the column, and is not kept while it knows none. What the last process kept lands at boot, before the
 * reset and auto-start read the rows.
 */
export class SessionRows {
  // Per session, what this process last wrote to or read from the row, and how many of its writes landed: a read
  // counts only when none landed while it ran.
  private readonly known = new Map<string, { status?: SessionStatus; phone?: string | null; writes: number }>();

  constructor(private readonly deps: SessionRowsDeps) {
    deps.queue?.register('session', {
      encode: record => {
        const { sessionId: s, since: t, write } = record as KeptRowWrite;
        return { s, t, f: write.field, m: write.moves, b: write.blind, w: write.with, n: write.owners };
      },
      decode: (key, value) => this.restore(key, value),
    });
  }

  /** The claims a write fenced on this node's claim may find: this node's, and with `free` a row no node holds. */
  owners(free = false): Array<string | null> | undefined {
    const node = this.deps.ownership?.nodeId;
    return node === undefined ? undefined : free ? [node, null] : [node];
  }

  /** The write of `field` kept now: a live write issued now settles it once it lands. */
  kept(sessionId: string, field: SessionRowField): KeptRowWrite | undefined {
    return this.deps.queue?.get('session', keyOf(sessionId, field)) as KeptRowWrite | undefined;
  }

  /**
   * A live write of `field` reached the row, which holds `value` now: the write that was kept of the column when it
   * was issued (`superseded`) is settled. One kept since is newer, and stays.
   */
  landed(sessionId: string, field: SessionRowField, value: string | null, superseded: KeptRowWrite | undefined): void {
    if (field !== 'desiredState') this.remember(sessionId, field, value);
    if (superseded && this.kept(sessionId, field) === superseded) this.deps.queue?.settle('session', superseded.key);
  }

  /** Before a read of the row: what it returns counts only if no write of this process lands meanwhile. */
  mark(sessionId: string): number {
    return this.known.get(sessionId)?.writes ?? 0;
  }

  /** A read of the row returned what a later blind write replaces, unless a write landed since `mark`. */
  saw(sessionId: string, row: Pick<Session, 'status' | 'phone'>, mark: number): void {
    if (this.mark(sessionId) === mark)
      this.known.set(sessionId, { status: row.status, phone: row.phone, writes: mark });
  }

  /**
   * Keep a write the database refused because it cannot answer (any other error keeps nothing), composed over what
   * is kept of the column already. Returns whether it is kept.
   */
  keep(sessionId: string, write: SessionRowWrite, error: unknown): boolean {
    const queue = this.deps.queue;
    if (!queue || !isDatabaseUnavailable(error)) return false;
    const key = keyOf(sessionId, write.field);
    const kept = queue.get('session', key) as KeptRowWrite | undefined;
    this.deps.logger.warn('Keeping a session row write the database refused, to write it once it answers', {
      sessionId,
      field: write.field,
      error: error instanceof Error ? error.message : String(error),
      action: 'session_row_write_kept',
    });
    queue.park(key, new KeptRowWrite(key, sessionId, kept ? compose(kept.write, write) : write, Date.now(), this));
    return true;
  }

  /** Keep a write that set `field` to `value` whatever the row held, guarded on what this process knows it held. */
  keepSet(
    sessionId: string,
    field: 'status' | 'phone',
    value: string | null,
    error: unknown,
    rest: Pick<SessionRowWrite, 'with' | 'owners'> = {},
  ): boolean {
    const held = this.known.get(sessionId)?.[field];
    return held !== undefined && this.keep(sessionId, { field, moves: [[held, value]], blind: true, ...rest }, error);
  }

  /** The push name was written since a binding was kept: the binding no longer writes the older one it carries. */
  pushNameWritten(sessionId: string): void {
    const kept = this.kept(sessionId, 'phone');
    if (kept?.write.with?.pushName === undefined) return;
    this.deps.queue?.park(
      kept.key,
      new KeptRowWrite(kept.key, sessionId, { ...kept.write, with: undefined }, kept.since, this),
    );
  }

  /** Drop what this process knew of a deleted session's row. */
  forget(sessionId: string): void {
    this.known.delete(sessionId);
  }

  /** What the journal restored lands now, before the boot reset and auto-start read the rows; a refused one waits. */
  async landRestored(): Promise<void> {
    const queue = this.deps.queue;
    if (!queue) return;
    for (const record of [...queue.records('session')] as KeptRowWrite[]) {
      try {
        if (await record.retry()) queue.settle('session', record.key);
      } catch (error) {
        if (isDatabaseUnavailable(error)) return;
      }
    }
  }

  /** One try of a kept write: true once it landed or a later write made it moot, and throws while the database refuses it. */
  async apply(record: KeptRowWrite): Promise<boolean> {
    const { sessionId, write } = record;
    // A row no node holds is taken too (the writer may have released it since): no peer's write is on it, and the
    // value compare still stops one made before the release.
    const owners: FindOptionsWhere<Session>[] =
      write.owners === 'claimable'
        ? (this.deps.ownership?.claimableWhere() ?? [{}])
        : write.owners
          ? [...new Set([...write.owners, null])].map(nodeId => ({ nodeId: nodeId ?? IsNull() }))
          : [{}];
    const { connectedAt, lastActiveAt, pushName } = write.with ?? {};
    const columns: QueryDeepPartialEntity<Session> = {
      ...(connectedAt !== undefined && { connectedAt: new Date(connectedAt) }),
      ...(lastActiveAt !== undefined && { lastActiveAt: new Date(lastActiveAt) }),
      ...(pushName !== undefined && { pushName }),
    };
    for (const [from, to] of write.moves) {
      const { affected } = await this.deps.repository.update(
        owners.map(owner => ({ ...owner, id: sessionId, [write.field]: from ?? IsNull() })),
        { ...columns, [write.field]: to },
      );
      if (!affected) continue;
      if (write.field !== 'desiredState') this.remember(sessionId, write.field, to);
      if (write.field === 'status' && !record.restored) this.deps.announce(sessionId, to as SessionStatus);
      return true;
    }
    return true;
  }

  released(record: KeptRowWrite, reason: RecoveryLoss): void {
    const { message, action } = LOSS[record.write.field];
    this.deps.logger.error(message, undefined, { sessionId: record.sessionId, reason, action });
  }

  private remember(sessionId: string, field: 'status' | 'phone', value: string | null): void {
    const known = this.known.get(sessionId) ?? { writes: 0 };
    this.known.set(sessionId, { ...known, [field]: value, writes: known.writes + 1 });
  }

  private restore(key: string, value: unknown): KeptRowWrite | undefined {
    const v = value as Partial<JournaledRowWrite> | null;
    const moves = Array.isArray(v?.m) && v.m.every(move => Array.isArray(move) && move.length === 2) ? v.m : undefined;
    if (!v || typeof v.s !== 'string' || typeof v.t !== 'number' || !FIELDS.includes(v.f) || !moves) return undefined;
    // A status the last process kept that says its engine runs is what the boot reset makes of it.
    const landing =
      v.f === 'status'
        ? moves.map(([from, to]): [string | null, string | null] => [
            from,
            ACTIVE_STATUSES.includes(to as SessionStatus) ? SessionStatus.DISCONNECTED : to,
          ])
        : moves;
    const write: SessionRowWrite = { field: v.f!, moves: landing, blind: v.b, with: v.w, owners: v.n };
    const record = new KeptRowWrite(key, v.s, write, v.t, this);
    record.restored = true;
    return record;
  }
}
