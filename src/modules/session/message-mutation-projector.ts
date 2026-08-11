import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm';
import { Message } from '../message/entities/message.entity';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import { LoggerService } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { ReactionEvent, EditedMessage } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Applies stored-message mutations — reactions, inbound edits, REST outbound-edit echoes — behind
 * the per-message KeyedMutationQueue handed in by MessageProjector, so every writer of one
 * message's row stays serialized on a single chain (reactions read-modify-write the metadata
 * column; rapid edits must remain latest-write-wins). A plain collaborator built in the
 * projector's constructor, not a Nest provider: the queue is shared state, not a dependency the
 * container could wire.
 */
export class MessageMutationProjector {
  constructor(
    private readonly messageRepository: Repository<Message>,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly messageMutations: KeyedMutationQueue,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Queue a reaction apply. Reactions read-modify-write the metadata column, so they must be
   * serialized per message; the caller only knows it has an event to apply.
   */
  applyReactionQueued(id: string, event: ReactionEvent): void {
    this.enqueueMessageMutation(id, event.messageId, () => this.applyReaction(id, event));
  }

  /**
   * Queue an edit apply. Shares the reaction chain so rapid edit-vs-reaction on the same message
   * stays ordered rather than racing.
   */
  applyMessageEditQueued(id: string, message: EditedMessage): void {
    this.enqueueMessageMutation(id, message.messageId, () => this.applyMessageEdit(id, message));
  }

  /** Queue a message-scoped mutation. A failed operation is isolated so later events still run. */
  enqueueMessageMutation(id: string, messageId: string, work: () => Promise<void>): void {
    this.messageMutations.enqueue(`${id}:${messageId}`, work);
  }

  private async applyReaction(id: string, event: ReactionEvent): Promise<void> {
    try {
      // Guard the lookup key before it reaches TypeORM: `findOne` DROPS an undefined condition from
      // the where-clause rather than matching nothing, so an engine that couldn't resolve the reacted
      // message's id would silently match an arbitrary row and clobber/emit its reactions. `!msg` is
      // no protection against that — the row it finds is real, just the wrong one.
      if (!event.messageId) return;

      const msg = await this.messageRepository.findOne({ where: { sessionId: id, waMessageId: event.messageId } });

      // The stored copy is best-effort — a message is absent whenever it was never persisted (an
      // ephemeral one under STORE_EPHEMERAL_MESSAGES=false, or one that arrived before the session
      // went live) — but the notification is not: `message.reaction` is a declared webhook event and
      // the dashboard stream is the point of it, the same contract handleMessageRevoked states.
      let reactions: Record<string, string> | undefined;
      if (msg) {
        const metadata = msg.metadata || {};
        reactions = (metadata.reactions as Record<string, string>) || {};
        if (!event.reaction) {
          delete reactions[event.senderId];
        } else {
          reactions[event.senderId] = event.reaction;
        }
        metadata.reactions = reactions;
        // Scoped update of ONLY the metadata column. A full-row save(msg) would re-persist the `status`
        // read at findOne time, clobbering a concurrent ack UPDATE (SENT→DELIVERED/READ) that committed in
        // the window between this findOne and the write — the mutation chain serializes reaction-vs-reaction
        // but NOT reaction-vs-ack, so scoping the write to metadata is what keeps delivery state monotonic
        // (#220). Other metadata fields are carried through untouched (they were read into `metadata`).
        await this.messageRepository.update({ sessionId: id, waMessageId: event.messageId }, {
          metadata,
        } as QueryDeepPartialEntity<Message>);
      }

      // `reactions` is the post-apply snapshot of EVERY reaction on the message and consumers REPLACE
      // their copy with it, so this one reaction must not stand in for the whole set — that would read
      // as the other senders having withdrawn theirs. Omitted means "no stored copy to snapshot",
      // which is the truth; present keeps today's contract byte for byte.
      const payload = reactions ? { ...event, reactions } : { ...event };
      this.eventsGateway.emitMessageReaction(id, payload);
      // Webhook parity with the WebSocket broadcast: same payload, so a webhook-only consumer observes
      // reactions too. Idempotency for this event is salted per dispatch.
      void this.webhookService.dispatch(id, 'message.reaction', payload);
    } catch (err) {
      this.logger.error(`Failed to update message reaction: ${event.messageId}`, String(err));
    }
  }

  /** Persist an edit before notifying consumers, while still surfacing the occurrence if storage fails. */
  private async applyMessageEdit(id: string, message: EditedMessage): Promise<void> {
    try {
      await this.messageRepository.update({ sessionId: id, waMessageId: message.messageId }, { body: message.body });
    } catch (err) {
      this.logger.error(`Failed to update edited message: ${message.messageId}`, String(err));
    }

    const editedPayload = message as unknown as Record<string, unknown>;
    this.eventsGateway.emitMessageEdited(id, editedPayload);
    void this.webhookService.dispatch(id, 'message.edited', editedPayload);
  }

  /**
   * Reflect an OUTBOUND edit (REST MessageService.editMessage) in the stored row, routed through the
   * same per-message mutation queue as the inbound edit/reaction paths so the two writers cannot
   * interleave (latest-write-wins holds across both directions). Same best-effort semantics as
   * applyMessageEdit: a missing row or a failed write must not fail the request — the engine edit
   * already succeeded. Resolves once the queued write has run.
   */
  async recordOutboundMessageEdit(sessionId: string, messageId: string, body: string): Promise<void> {
    await new Promise<void>(resolve => {
      this.enqueueMessageMutation(sessionId, messageId, async () => {
        try {
          await this.messageRepository.update({ sessionId, waMessageId: messageId }, { body });
        } catch (err) {
          this.logger.warn(`Failed to update stored body of edited message ${messageId}`, { error: String(err) });
        } finally {
          resolve();
        }
      });
    });
  }
}
