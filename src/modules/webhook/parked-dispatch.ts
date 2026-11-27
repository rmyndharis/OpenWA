import type { RecoveryLoss, RecoveryRecord } from '../../common/utils/recovery-queue';
import type { MessageEngineRef } from '../message/entities/message.entity';

/** What a kept dispatch runs, through the delivery service: its dispatch, and the log of a loss. */
export interface ParkedDispatchSteps {
  /** Look the webhooks up again and open the outbox rows; throws when the database fails. */
  dispatch(parked: ParkedDispatch): Promise<void>;
  /** The record left the queue: dispatched, changed away, given up on (`reason`), or forgotten with its session. */
  released(parked: ParkedDispatch, reason?: RecoveryLoss): void;
}

/**
 * A webhook event whose dispatch the database refused (its webhooks could not be read, or no outbox row could be
 * written), kept until it answers: the event data with its inline media shed, the occurrence its idempotency key was
 * minted with (so every try sends the same key), and, for a message, what the engine reported of it when a handler
 * filed it elsewhere. The webhooks, their filters and their subscriptions are read when it is dispatched. A change of
 * the message it carries rewrites or withdraws `data` meanwhile.
 */
export class ParkedDispatch implements RecoveryRecord {
  readonly lane = 'dispatch' as const;
  private size = 0;

  constructor(
    readonly key: string,
    readonly sessionId: string,
    readonly event: string,
    public data: Record<string, unknown>,
    readonly occurrenceId: string,
    readonly engineRef: MessageEngineRef | null,
    /** The one webhook an opt-in event was staged for, or null for every webhook of the session. */
    readonly only: string | null,
    readonly since: number,
    private readonly steps: ParkedDispatchSteps,
  ) {
    this.measure();
  }

  bytes(): number {
    return this.size;
  }

  /** Measure what the record holds, after it changed. */
  measure(): void {
    this.size = this.event.length + JSON.stringify(this.data).length;
  }

  /**
   * A kept message.revoked holds only ids, and is how a receiver that has the message learns it was taken back: like a
   * kept revoke, it is kept past the age cap and never given up for bytes.
   */
  ageCapped(): boolean {
    return this.event !== 'message.revoked';
  }

  async retry(): Promise<boolean> {
    await this.steps.dispatch(this);
    return true;
  }

  lost(reason: RecoveryLoss): void {
    this.steps.released(this, reason);
  }

  dropped(): void {
    this.steps.released(this);
  }
}
