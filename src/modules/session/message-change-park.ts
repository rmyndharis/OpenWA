import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { MessageStatus } from '../message/entities/message.entity';
import type { RecoveryLoss, RecoveryRecord } from '../../common/utils/recovery-queue';
import type { MutationSource, StoredMessageRef } from './message-mutation-guard';

/**
 * A revoke kept for a message: `judge` decides whose row it may clear (for a change held while the message was in
 * flight, the claim the commit computed), `source` which delivery copies it withdraws (absent for an engine revoke
 * that names no actor, which withdraws every copy). `notify` hands the cleared row to `message:persisted`.
 * `unrevokedOnly` clears only a row not cleared already, and announces only that (a repeat of a message whose first
 * delivery already applied the revoke).
 */
/** The row a change is written to without a read: the one the commit holding the change inserted, by its key. */
export interface OwnRow {
  rowId?: string;
}

export interface RevokeSlot {
  source?: MutationSource;
  judge?: MutationSource;
  own?: OwnRow;
  announced: boolean;
  notify: boolean;
  unrevokedOnly?: boolean;
  /** The delivery copies were withdrawn already. */
  outboxSettled?: boolean;
}

/**
 * An edit kept for a message: the text (absent for a mark alone: an edit the engine applied before the hand-over),
 * whether the row is marked edited when the write changed its text, always, or never (an edit held for a message in
 * flight that changed nothing of the text it arrived with), and whether a changed text is handed to
 * `message:persisted` again.
 */
export interface EditSlot {
  body?: string;
  judge?: MutationSource;
  own?: OwnRow;
  mark: 'changed' | 'always' | 'never';
  announceText: boolean;
  outboxSettled?: boolean;
  /** The write changed the stored text already; what follows it (mark, copies, announcement) is still owed. */
  textChanged?: boolean;
}

/** A reaction kept for a message, latest per sender ('' withdraws it). */
export interface ReactionSlot {
  value: string;
  judge: MutationSource;
  own?: OwnRow;
}

/** Receipts kept for a message still in flight, furthest per chat they named, judged by its claim. */
export interface AckSlot {
  judge: MutationSource;
  own?: OwnRow;
  ref?: StoredMessageRef;
  acks: Map<string, MessageStatus>;
}

export interface ChangeSlots {
  revoke?: RevokeSlot;
  edit?: EditSlot;
  reactions?: Map<string, ReactionSlot>;
  acks?: AckSlot;
}

/** What a parked change runs, through the projector: its outbox steps, its row steps, and the log of a loss. */
export interface ParkedChangeSteps {
  /** Withdraw or rewrite the delivery copies, judged by their payloads; throws when the database fails. */
  outbox(change: ParkedChange): Promise<void>;
  /** Write the row, dropping each slot that settles; throws when the database fails or the row cannot be read. */
  apply(change: ParkedChange): Promise<void>;
  /** The record left the queue: settled, given up on (`reason`), or forgotten with its session. */
  released(change: ParkedChange, reason?: RecoveryLoss): void;
}

/** The slots a record still holds, by name, for its log line. */
export const slotNames = (slots: ChangeSlots): string[] =>
  [
    slots.revoke && 'revoke',
    slots.edit && 'edit',
    slots.reactions?.size && 'reactions',
    slots.acks?.acks.size && 'acks',
  ].filter((name): name is string => typeof name === 'string');

/**
 * The changes of one message the database refused, kept until it answers (see RecoveryQueue): a revoke, an edit, the
 * latest reaction per sender and the receipts of a message still in flight, each with what it is judged by, as the
 * change or the commit that held it computed it. Engine and retire state are read again on each try: nothing is
 * announced for an engine that is gone.
 */
export class ParkedChange implements RecoveryRecord {
  readonly lane = 'change' as const;
  readonly slots: ChangeSlots = {};
  private size = 0;

  constructor(
    readonly sessionId: string,
    readonly waMessageId: string,
    public engine: IWhatsAppEngine | undefined,
    readonly since: number,
    private readonly steps: ParkedChangeSteps,
  ) {}

  bytes(): number {
    return this.size;
  }

  /** Measure what the record holds, after a change was kept in it. */
  measure(): void {
    const { revoke, edit, reactions, acks } = this.slots;
    this.size =
      this.waMessageId.length +
      JSON.stringify([revoke, edit, reactions && [...reactions], acks && { ...acks, acks: [...acks.acks] }]).length;
  }

  /** A record holding a revoke alone holds no content, and is kept past the content age cap. */
  ageCapped(): boolean {
    return slotNames(this.slots).some(name => name !== 'revoke');
  }

  empty(): boolean {
    return slotNames(this.slots).length === 0;
  }

  prepare(): Promise<void> {
    return this.steps.outbox(this);
  }

  async retry(): Promise<boolean> {
    await this.steps.apply(this);
    this.measure();
    return this.empty();
  }

  lost(reason: RecoveryLoss): void {
    this.steps.released(this, reason);
  }

  dropped(): void {
    this.steps.released(this);
  }
}
