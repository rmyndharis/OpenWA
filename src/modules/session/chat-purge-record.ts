import type { RecoveryLoss, RecoveryRecord } from '../../common/utils/recovery-queue';

/** What a kept chat purge runs, through the session service: the purge itself, and the log of a loss. */
export interface ChatPurgeSteps {
  /** Remove the chat's rows stored up to the cutoff, as the live purge does; throws while the database refuses it. */
  purge(record: KeptChatPurge): Promise<boolean>;
  released(record: KeptChatPurge, reason?: RecoveryLoss): void;
}

/**
 * The removal of a cleared or deleted chat's stored rows the database refused, kept to run once it answers. Bounded by
 * its cutoff, so it removes nothing stored since; a later purge of the same chat replaces it, its cutoff the later.
 * Kept whatever its age, as a delete is: the messages the account cleared would otherwise stay in the API.
 */
export class KeptChatPurge implements RecoveryRecord {
  readonly lane = 'purge' as const;

  constructor(
    readonly key: string,
    readonly sessionId: string,
    readonly chatId: string,
    readonly cutoff: number,
    readonly since: number,
    private readonly steps: ChatPurgeSteps,
  ) {}

  bytes(): number {
    return this.chatId.length;
  }

  ageCapped(): boolean {
    return false;
  }

  retry(): Promise<boolean> {
    return this.steps.purge(this);
  }

  lost(reason: RecoveryLoss): void {
    this.steps.released(this, reason);
  }

  dropped(): void {
    this.steps.released(this);
  }
}

export const chatPurgeKey = (sessionId: string, chatId: string): string => `${sessionId}:purge:${chatId}`;

/** A kept chat purge as the journal keeps it. */
export const journalChatPurge = (record: KeptChatPurge): { s: string; c: string; u: number; t: number } => ({
  s: record.sessionId,
  c: record.chatId,
  u: record.cutoff,
  t: record.since,
});

/** The purge a journal entry holds, or undefined for one that holds none. */
export function restoredChatPurge(
  value: unknown,
): { sessionId: string; chatId: string; cutoff: number; since: number } | undefined {
  const v = value as { s?: unknown; c?: unknown; u?: unknown; t?: unknown } | null;
  if (!v || typeof v.s !== 'string' || typeof v.c !== 'string' || typeof v.u !== 'number' || typeof v.t !== 'number') {
    return undefined;
  }
  return { sessionId: v.s, chatId: v.c, cutoff: v.u, since: v.t };
}
