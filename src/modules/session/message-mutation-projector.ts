import { Equal, type FindOptionsWhere, In, IsNull, Not, Or, Repository } from 'typeorm';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import { LoggerService } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { ReactionEvent, EditedMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { updateMessageMetadata } from '../message/message-metadata';
import { type MutationSource, type StoredMessageRef } from './message-mutation-guard';
import { judgeStoredRow, outboxPayloadPredicate, revokeSourceFor } from './message-row-judgement';

/** A judging read that worked and found no row under the id. */
const isAbsent = (verdict: { exists: boolean; unread?: boolean }): boolean => !verdict.exists && !verdict.unread;

/** What the stored row said of a change (see MessageMutationProjector.storedRowVerdict). */
export type StoredRowVerdict = {
  exists: boolean;
  reason: string | null;
  unread?: boolean;
  row?: StoredMessageRef;
  /** The primary key of the row the judging read found. */
  rowId?: string;
  moved?: boolean;
};

/**
 * The row of a message the change itself names, for a write made with no row read: its chat as the change names it
 * (or the chat an API caller named), the side and author the change implies where the rule judges them, and no
 * engine ref, since a row a hook moved is judged by its engine ref, which only a read applies. A row of another
 * chat, side or author under the id matches none of it.
 */
function claimedRow(sessionId: string, waMessageId: string, source: MutationSource): FindOptionsWhere<Message> {
  const group = Boolean(source.chatId?.endsWith('@g.us'));
  const memberRevoke = source.kind === 'revoke' && group && source.fromMe === false && source.admin === false;
  const authorOnly = source.kind === 'edit' || (source.kind === 'revoke' && !group);
  const chats = [...new Set([source.chatId, source.callerChatId].filter((c): c is string => Boolean(c)))];
  // A change that names no chat is judged foreign by no chat, so it claims none.
  const where: FindOptionsWhere<Message> = {
    sessionId,
    waMessageId,
    ...(chats.length ? { chatId: In(chats) } : {}),
    engineRef: IsNull(),
  };
  if ((authorOnly && source.fromMe !== undefined) || memberRevoke) {
    where.direction = source.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING;
  }
  if (source.author && (memberRevoke || (source.kind === 'edit' && group && source.fromMe === false))) {
    where.author = Or(IsNull(), Equal(source.author));
  }
  return where;
}

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
    // Told of each row the marker below lands on.
    private readonly onMarkedEdited: (sessionId: string, waMessageId: string) => void = () => undefined,
    private readonly resolveLid?: (jid: string) => Promise<string | null>,
    // Told of each row whose text an edit changed, once its marker is written. Must not reject.
    private readonly onTextChanged: (sessionId: string, waMessageId: string) => Promise<void> = () => Promise.resolve(),
  ) {}

  /**
   * Queue a reaction apply. Reactions read-modify-write the metadata column, so they must be
   * serialized per message; the caller only knows it has an event to apply. `needsRow` is for a change
   * the message still arriving under the same id judged foreign: it is applied only to a stored row that
   * accepts it, and announced only then, so a change nothing stored vouches for goes no further.
   */
  applyReactionQueued(id: string, event: ReactionEvent, needsRow = false): void {
    this.enqueueMessageMutation(id, event.messageId, () => this.applyReaction(id, event, needsRow));
  }

  /**
   * Queue an edit apply. Shares the reaction chain so rapid edit-vs-reaction on the same message
   * stays ordered rather than racing.
   */
  applyMessageEditQueued(id: string, message: EditedMessage, needsRow = false): void {
    this.enqueueMessageMutation(id, message.messageId, () => this.applyMessageEdit(id, message, needsRow));
  }

  /** Queue a message-scoped mutation. A failed operation is isolated so later events still run. */
  enqueueMessageMutation(id: string, messageId: string, work: () => Promise<void>): void {
    this.messageMutations.enqueue(`${id}:${messageId}`, work);
  }

  /**
   * Why a change must not touch the stored row it names (see message-mutation-guard), or null: the row
   * is absent, unreadable, or the change is consistent with it. Never rejects: a read that fails lets the
   * change through, as it always went.
   */
  async foreignRowReason(sessionId: string, waMessageId: string, source: MutationSource): Promise<string | null> {
    return (await this.storedRowVerdict(sessionId, waMessageId, source)).reason;
  }

  /**
   * What the stored row says of a change: whether there is one to ask, and why the change must not touch
   * it (null when it may), with the row it read. A row that cannot be read is reported absent with no reason,
   * as before, and marked unread.
   */
  async storedRowVerdict(sessionId: string, waMessageId: string, source: MutationSource): Promise<StoredRowVerdict> {
    if (!waMessageId) return { exists: false, reason: null };
    try {
      const row = await this.messageRepository.findOne({
        where: { sessionId, waMessageId },
        select: { id: true, chatId: true, direction: true, author: true, engineRef: true, from: true, to: true },
      });
      return row
        ? { exists: true, ...(await judgeStoredRow(row, waMessageId, source, this.resolveLid)), row, rowId: row.id }
        : { exists: false, reason: null };
    } catch {
      return { exists: false, reason: null, unread: true };
    }
  }

  /**
   * Where a write made for a change may land, so that it never lands on a row the change would be judged foreign to:
   * the row its judging read found, by primary key, as a row stored under the id since the read is not the one judged;
   * with no row found, only a row that carries the change's own identity ({@link claimedRow}), which is how the
   * message's own row, stored after the read, still takes it. A row that could not be read is matched by the id, as
   * before. Null when the change is foreign to the row.
   */
  writeTarget(
    sessionId: string,
    waMessageId: string,
    source: MutationSource,
    verdict: StoredRowVerdict,
  ): FindOptionsWhere<Message> | null {
    if (verdict.reason) return null;
    if (verdict.exists && verdict.rowId) return { id: verdict.rowId };
    if (verdict.unread || verdict.exists) return { sessionId, waMessageId };
    return claimedRow(sessionId, waMessageId, source);
  }

  private async applyReaction(id: string, event: ReactionEvent, needsRow: boolean): Promise<void> {
    try {
      // Guard the lookup key before it reaches TypeORM: `findOne` DROPS an undefined condition from
      // the where-clause rather than matching nothing, so an engine that couldn't resolve the reacted
      // message's id would silently match an arbitrary row and clobber/emit its reactions. `!msg` is
      // no protection against that — the row it finds is real, just the wrong one.
      if (!event.messageId) return;
      const verdict = await this.storedRowVerdict(id, event.messageId, { kind: 'reaction', chatId: event.chatId });
      if (needsRow && !verdict.exists) return;
      if (verdict.reason) {
        this.logger.warn('Dropping a reaction aimed at a message of another chat', {
          sessionId: id,
          messageId: event.messageId,
          reason: verdict.reason,
        });
        return;
      }

      // A revoked row reads as absent, like the edit paths: a reaction that lands after the delete must
      // not write a reactions map back onto the cleared metadata.
      // The stored copy is best-effort — a message is absent whenever it was never persisted (an
      // ephemeral one under STORE_EPHEMERAL_MESSAGES=false, or one that arrived before the session
      // went live) — but the notification is not: `message.reaction` is a declared webhook event and
      // the dashboard stream is the point of it, the same contract handleMessageRevoked states.
      // A write that fails is the same case: it is logged, and the reaction goes out without the full list.
      const source = { kind: 'reaction', chatId: event.chatId } as const;
      const metadata = await updateMessageMetadata(
        this.messageRepository,
        this.writeTarget(id, event.messageId, source, verdict)!,
        current => {
          const reactions = { ...(current.reactions as Record<string, string> | undefined) };
          if (!event.reaction) delete reactions[event.senderId];
          else reactions[event.senderId] = event.reaction;
          return { ...current, reactions };
        },
      ).catch((err: unknown) => {
        this.logger.error(`Failed to update message reaction: ${event.messageId}`, String(err));
        return null;
      });
      const reactions = metadata?.reactions as Record<string, string> | undefined;

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
  private async applyMessageEdit(id: string, message: EditedMessage, needsRow: boolean): Promise<void> {
    const source = { kind: 'edit', chatId: message.chatId, fromMe: message.fromMe, author: message.author } as const;
    const verdict = await this.storedRowVerdict(id, message.messageId, source);
    if (needsRow && !verdict.exists) return;
    if (verdict.reason) {
      this.logger.warn('Dropping an edit aimed at a message of another chat or sender', {
        sessionId: id,
        messageId: message.messageId,
        reason: verdict.reason,
      });
      return;
    }
    let revoked = false;
    try {
      // Never onto a revoked row: a late edit must not bring back text the sender deleted. An event that repeats the
      // stored text is no edit, and the marker would label an unedited message. The write compares, not the read
      // above, as the row may be inserted between the two.
      const target = this.writeTarget(id, message.messageId, source, verdict)!;
      const result = await this.messageRepository.update(
        { ...target, type: Not('revoked'), body: Or(Not(message.body), IsNull()) },
        { body: message.body },
      );
      if (result.affected) {
        await this.markMessageEdited(id, message.messageId, target);
        await this.rewriteDeliveries(id, message.messageId, message.body, source, verdict);
        await this.onTextChanged(id, message.messageId);
      } else {
        // Nor announced onto one: the payload carries the new text of a message that was deleted, for everyone or,
        // through the REST delete, for this account only (which announced nothing). Asked only when the write changed
        // nothing, so an ordinary edit costs no extra read. A revoke that lands between the write and this read (a
        // history tombstone or a row stored deleted is written off this chain) makes it read revoked, which is right:
        // the message is deleted by then.
        revoked =
          (await this.messageRepository.findOne({ where: { ...target, type: 'revoked' }, select: { id: true } })) !==
          null;
        if (!revoked && isAbsent(verdict))
          await this.rewriteDeliveries(id, message.messageId, message.body, source, verdict);
      }
    } catch (err) {
      this.logger.error(`Failed to update edited message: ${message.messageId}`, String(err));
    }
    if (revoked) return;

    const editedPayload = message as unknown as Record<string, unknown>;
    this.eventsGateway.emitMessageEdited(id, editedPayload);
    void this.webhookService.dispatch(id, 'message.edited', editedPayload);
  }

  /**
   * Carry the text of an edit into the copies its deliveries still hold (open outbox rows, the event data a failed
   * delivery keeps), each judged by its payload as a revoke judges them, so a replay, a queued job or a redrive sends
   * the edited text: after the edit changed the stored row, or with no row to write (a message that is not stored,
   * such as an own send to a chat with disappearing messages while STORE_EPHEMERAL_MESSAGES=false), where only a
   * payload that names the edit's chat takes it.
   */
  private async rewriteDeliveries(
    sessionId: string,
    waMessageId: string,
    body: string,
    source: MutationSource | undefined,
    verdict: Awaited<ReturnType<MessageMutationProjector['storedRowVerdict']>> | undefined,
  ): Promise<void> {
    const filed = verdict?.moved && verdict.row ? revokeSourceFor(verdict.row) : undefined;
    const ours = Boolean(verdict?.exists && !verdict.reason);
    const predicate = source ? outboxPayloadPredicate(source, this.resolveLid, ours, filed) : undefined;
    await this.webhookService.rewritePendingDeliveriesForMessage?.(sessionId, waMessageId, body, predicate);
  }

  /** Keep the marker alongside existing reactions, media and quote metadata. */
  async markMessageEdited(
    sessionId: string,
    waMessageId: string,
    target: FindOptionsWhere<Message> = { sessionId, waMessageId },
  ): Promise<void> {
    const marked = await updateMessageMetadata(this.messageRepository, target, metadata => ({
      ...metadata,
      edited: true,
    }));
    if (marked) this.onMarkedEdited(sessionId, waMessageId);
  }

  /**
   * Reflect an OUTBOUND edit (REST MessageService.editMessage) in the stored row, routed through the
   * same per-message mutation queue as the inbound edit/reaction paths so the two writers cannot
   * interleave (latest-write-wins holds across both directions). Same best-effort semantics as
   * applyMessageEdit: a missing row or a failed write must not fail the request — the engine edit
   * already succeeded. Resolves once the queued write has run. The row is the table's one under the id,
   * which another chat's message may hold: with a `source`, a row it proves foreign is left alone.
   */
  async recordOutboundMessageEdit(
    sessionId: string,
    messageId: string,
    body: string,
    source?: MutationSource,
  ): Promise<void> {
    await new Promise<void>(resolve => {
      this.enqueueMessageMutation(sessionId, messageId, async () => {
        try {
          const verdict = source && (await this.storedRowVerdict(sessionId, messageId, source));
          if (verdict?.reason) {
            this.logger.warn('Not storing an edit aimed at a message of another chat or sender', {
              sessionId,
              messageId,
              reason: verdict.reason,
            });
            return;
          }
          // Compared in the write, as applyMessageEdit does: the engine's own echo of this edit reaches the row
          // too, and only the writer that changed the text reports it.
          const target = verdict
            ? this.writeTarget(sessionId, messageId, source, verdict)!
            : { sessionId, waMessageId: messageId };
          const result = await this.messageRepository.update(
            { ...target, type: Not('revoked'), body: Or(Not(body), IsNull()) },
            { body },
          );
          await this.markMessageEdited(sessionId, messageId, target);
          if (result?.affected) {
            await this.rewriteDeliveries(sessionId, messageId, body, source, verdict);
            await this.onTextChanged(sessionId, messageId);
          } else if (verdict && isAbsent(verdict)) {
            await this.rewriteDeliveries(sessionId, messageId, body, source, verdict);
          }
        } catch (err) {
          this.logger.warn(`Failed to update stored body of edited message ${messageId}`, { error: String(err) });
        } finally {
          resolve();
        }
      });
    });
  }
}
