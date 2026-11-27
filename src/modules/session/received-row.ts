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
