import type { RecoveryLoss, RecoveryRecord } from '../../common/utils/recovery-queue';

/** What a kept received row runs, through the projector: its insert, and the log of a loss. */
export interface ReceivedRowSteps {
  /** Insert the row, as a live insert does; true once it is stored (or another writer stored it), throws while refused. */
  store(row: ReceivedRow): Promise<boolean>;
  /** The record left the queue: stored, given up on (`reason`), or forgotten with its session. */
  released(row: ReceivedRow, reason?: RecoveryLoss): void;
}

/**
 * A message the engine delivered whose row the database refused, kept to be inserted once it answers (see
 * RecoveryQueue): the row as the live insert built it, the changes that came while it was in flight folded in. Its
 * announcement went out on its own (live, or kept as a dispatch), so storing it announces nothing but
 * `message:persisted`. A change of the message meanwhile waits for the row instead of reading it absent.
 */
export class ReceivedRow implements RecoveryRecord {
  readonly lane = 'receive' as const;
  private readonly size: number;

  constructor(
    readonly key: string,
    readonly sessionId: string,
    readonly row: Record<string, unknown>,
    /** `outgoing` for an own send composed on another device, whose media is archived only when that is asked. */
    readonly direction: 'incoming' | 'outgoing',
    readonly since: number,
    private readonly steps: ReceivedRowSteps,
  ) {
    this.size = JSON.stringify(row).length;
  }

  bytes(): number {
    return this.size;
  }

  ageCapped(): boolean {
    return true;
  }

  retry(): Promise<boolean> {
    return this.steps.store(this);
  }

  lost(reason: RecoveryLoss): void {
    this.steps.released(this, reason);
  }

  dropped(): void {
    this.steps.released(this);
  }
}

/** A kept received row as the journal keeps it. */
interface JournaledRow {
  s: string;
  r: Record<string, unknown>;
  d: 'incoming' | 'outgoing';
  t: number;
}

export const journalReceivedRow = (record: ReceivedRow): JournaledRow => ({
  s: record.sessionId,
  r: record.row,
  d: record.direction,
  t: record.since,
});

/** The row a journal entry holds, or undefined for one that holds none. */
export function restoredReceivedRow(
  value: unknown,
): { sessionId: string; row: Record<string, unknown>; direction: 'incoming' | 'outgoing'; since: number } | undefined {
  const v = value as Partial<JournaledRow> | null;
  if (!v || typeof v.s !== 'string' || typeof v.t !== 'number' || typeof v.r !== 'object' || v.r === null) {
    return undefined;
  }
  return { sessionId: v.s, row: v.r, direction: v.d === 'outgoing' ? 'outgoing' : 'incoming', since: v.t };
}

/** What a kept inbound message runs, through the projector: its hand-back to the engine, and the log of a loss. */
export interface KeptInboundSteps {
  /** Hand the message back to its session's engine; true once it was read, false while the engine cannot take it. */
  redeliver(kept: KeptInbound): Promise<boolean>;
  released(kept: KeptInbound, reason?: RecoveryLoss): void;
}

/**
 * A message the engine could not read because a stored message it needs (the secret an encrypted edit, reaction, poll
 * vote or RSVP is read with) could not be read, kept as the engine handed it over to be handed back once the database
 * answers, and read then as it would have been on arrival (see InboundRedelivery). Or, as a `copy`, the engine's copy
 * of a message the database refused, holding that secret, to be written back; its target is its own message, so a
 * change of the message waits behind it.
 */
export class KeptInbound implements RecoveryRecord {
  readonly lane = 'receive' as const;

  constructor(
    readonly key: string,
    readonly sessionId: string,
    readonly messageId: string,
    readonly raw: string,
    readonly kind: KeptInboundKind,
    /** The message it changes (an edit's, a reaction's, a vote's poll, an RSVP's event), when it names one. */
    readonly targetId: string | undefined,
    readonly since: number,
    private readonly steps: KeptInboundSteps,
  ) {}

  bytes(): number {
    return this.raw.length;
  }

  ageCapped(): boolean {
    // A clear of an unlinked account is kept, however old: the next account would see what it leaves.
    return this.kind !== 'wipe';
  }

  /** The clear of an unlinked account is never given up for count or bytes; there is one per session at most. */
  pinned(): boolean {
    return this.kind === 'wipe';
  }

  retry(): Promise<boolean> {
    return this.steps.redeliver(this);
  }

  lost(reason: RecoveryLoss): void {
    this.steps.released(this, reason);
  }

  dropped(): void {
    this.steps.released(this);
  }
}

/**
 * What a kept inbound record holds: a message to read again, the engine's copy of a message to write, a change of that
 * copy to apply (a delete, `blank`, an edit, `text`, or the removal of a conflicting copy, `remove`), the clear of what
 * an unlinked account left (`wipe`), a received status to store (`story`) or remove once its poster deleted it, or the
 * replace of a forward placeholder by its send's echo (`forward`).
 */
export type KeptInboundKind =
  'message' | 'copy' | 'blank' | 'text' | 'remove' | 'wipe' | 'story' | 'story-removal' | 'forward';

/** A record's key: a message by its own id, a copy by its message's, a change of a copy by both. */
export const keptInboundKey = (sessionId: string, id: string, kind: KeptInboundKind, changeId?: string): string =>
  kind === 'message'
    ? `${sessionId}:inbound:${id}`
    : kind === 'copy'
      ? `${sessionId}:copy:${id}`
      : kind === 'wipe'
        ? `${sessionId}:wipe`
        : kind === 'story' || kind === 'story-removal' || kind === 'forward'
          ? `${sessionId}:${kind}:${id}`
          : `${sessionId}:copy-change:${id}:${changeId ?? ''}`;

/** A kept inbound message as the journal keeps it. */
interface JournaledInbound {
  s: string;
  i: string;
  m: string;
  c?: Exclude<KeptInboundKind, 'message'>;
  g?: string;
  t: number;
}

export const journalKeptInbound = (record: KeptInbound): JournaledInbound => ({
  s: record.sessionId,
  i: record.messageId,
  m: record.raw,
  ...(record.kind === 'message' ? {} : { c: record.kind }),
  ...(record.targetId ? { g: record.targetId } : {}),
  t: record.since,
});

/** The message a journal entry holds, or undefined for one that holds none. */
export function restoredKeptInbound(
  value: unknown,
):
  | { sessionId: string; messageId: string; raw: string; kind: KeptInboundKind; targetId?: string; since: number }
  | undefined {
  const v = value as Partial<JournaledInbound> | null;
  if (!v || typeof v.s !== 'string' || typeof v.i !== 'string' || typeof v.m !== 'string' || typeof v.t !== 'number') {
    return undefined;
  }
  const targetId = typeof v.g === 'string' ? v.g : undefined;
  const kinds: readonly unknown[] = ['copy', 'blank', 'text', 'remove', 'wipe', 'story', 'story-removal', 'forward'];
  const kind = kinds.includes(v.c) ? (v.c as KeptInboundKind) : 'message';
  return { sessionId: v.s, messageId: v.i, raw: v.m, kind, targetId, since: v.t };
}
