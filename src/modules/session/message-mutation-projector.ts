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
import type { ChangeSlots, EditSlot, OwnRow } from './message-change-park';

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
  /** Why the row could not be read. */
  error?: unknown;
};

/** The verdict on the row a commit inserted, which a change it held is written to by that row's key, unread. */
export const ownRowVerdict = (own: OwnRow): StoredRowVerdict => ({ exists: true, reason: null, rowId: own.rowId });

/** What a judging read that failed threw, for a caller that keeps the change: the change is never written unread. */
export const unreadRowError = (verdict: StoredRowVerdict): unknown =>
  verdict.error ?? new Error('The stored row could not be read');

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
    // Handed a change whose write or judging read failed, to keep and try again. Standalone, it is only logged.
    private readonly park: (sessionId: string, waMessageId: string, slots: ChangeSlots, error: unknown) => void = (
      sessionId,
      waMessageId,
      _slots,
      error,
    ) => this.logger.error(`Failed to update message ${waMessageId} of session ${sessionId}`, String(error)),
    // Told of a change that landed, so one kept for the message that it supersedes is let go.
    private readonly settled: (sessionId: string, waMessageId: string, slots: ChangeSlots) => void = () => undefined,
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
    } catch (error) {
      return { exists: false, reason: null, unread: true, error };
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
      // A write that fails, or a row that cannot be read, is the same case: the reaction is kept to be written once
      // the database answers, and goes out now without the full list.
      const judge = { kind: 'reaction', chatId: event.chatId } as const;
      const kept: ChangeSlots = { reactions: new Map([[event.senderId, { value: event.reaction ?? '', judge }]]) };
      let metadata: Record<string, unknown> | null = null;
      try {
        metadata = await this.writeReactions(
          id,
          event.messageId,
          { [event.senderId]: event.reaction ?? '' },
          judge,
          verdict,
        );
        this.settled(id, event.messageId, kept);
      } catch (err) {
        this.park(id, event.messageId, kept, err);
      }
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
    const slot: EditSlot = { body: message.body, judge: source, mark: 'changed', announceText: true };
    try {
      const { changed, target } = await this.writeEdit(id, message.messageId, slot, true, verdict);
      // Nor announced onto one: the payload carries the new text of a message that was deleted, for everyone or,
      // through the REST delete, for this account only (which announced nothing). Asked only when the write changed
      // nothing, so an ordinary edit costs no extra read. A revoke that lands between the write and this read (a
      // history tombstone or a row stored deleted is written off this chain) makes it read revoked, which is right:
      // the message is deleted by then.
      if (!changed && target) {
        revoked =
          (await this.messageRepository.findOne({ where: { ...target, type: 'revoked' }, select: { id: true } })) !==
          null;
      }
      this.settled(id, message.messageId, { edit: slot });
    } catch (err) {
      this.park(id, message.messageId, { edit: slot }, err);
    }
    if (revoked) return;

    const editedPayload = message as unknown as Record<string, unknown>;
    this.eventsGateway.emitMessageEdited(id, editedPayload);
    void this.webhookService.dispatch(id, 'message.edited', editedPayload);
  }

  /**
   * Write an edit ({@link EditSlot}) to the row it is judged against ({@link writeTarget}), mark the row, and carry the
   * text into the copies the message's deliveries still hold (open outbox rows, the event data a failed delivery
   * keeps), each judged by its payload as a revoke judges them, so a replay, a queued job or a redrive sends the edited
   * text: after the write changed the stored row, or with no row to write (a message that is not stored, such as an
   * own send to a chat with disappearing messages while STORE_EPHEMERAL_MESSAGES=false), where only a payload that
   * names the edit's chat takes it. Never onto a revoked row: a late edit must not bring back text the sender deleted,
   * and an event that repeats the stored text is no edit (the write compares, not the read, as the row may change
   * between the two). A row that cannot be read is never written: the copies are rewritten by their payloads and the
   * read's error is thrown, as is any database failure, for the caller to keep the edit and try again. The slot
   * records what is done, so a retry does not repeat it. Must run on the message's chain.
   */
  async writeEdit(
    sessionId: string,
    waMessageId: string,
    slot: EditSlot,
    announce: boolean,
    verdict?: StoredRowVerdict,
  ): Promise<{ changed: boolean; target?: FindOptionsWhere<Message> }> {
    verdict ??= slot.own
      ? ownRowVerdict(slot.own)
      : slot.judge
        ? await this.storedRowVerdict(sessionId, waMessageId, slot.judge)
        : undefined;
    if (verdict?.reason) return { changed: false };
    if (verdict?.unread) {
      if (slot.body !== undefined && slot.judge && !slot.outboxSettled) {
        await this.changeCopies(sessionId, waMessageId, slot.body, slot.judge);
        slot.outboxSettled = true;
      }
      throw unreadRowError(verdict);
    }
    const target =
      verdict && (slot.judge || slot.own)
        ? this.writeTarget(sessionId, waMessageId, slot.judge!, verdict)!
        : { sessionId, waMessageId };
    if (slot.body !== undefined && !slot.textChanged) {
      const result = await this.messageRepository.update(
        { ...target, type: Not('revoked'), body: Or(Not(slot.body), IsNull()) },
        { body: slot.body },
      );
      // Kept on the slot: a retry finds the text written and must still mark, copy and announce it.
      slot.textChanged = Boolean(result?.affected);
    }
    const changed = slot.textChanged === true;
    if (slot.mark === 'always' || (slot.mark === 'changed' && changed)) {
      await this.markMessageEdited(sessionId, waMessageId, target);
    }
    if (slot.body !== undefined && (changed || (verdict && isAbsent(verdict)))) {
      await this.changeCopies(sessionId, waMessageId, slot.body, slot.judge, verdict);
      slot.outboxSettled = true;
    }
    if (changed && announce && slot.announceText) await this.onTextChanged(sessionId, waMessageId);
    return { changed, target };
  }

  /**
   * Merge reactions ('' withdraws a sender's) into the metadata of the row they are judged against, and return it, or
   * null when there is none (absent or revoked). A row that cannot be read is never written: the read's error is
   * thrown, as is a database failure. Must run on the message's chain.
   */
  async writeReactions(
    sessionId: string,
    waMessageId: string,
    changes: Record<string, string>,
    judge: MutationSource,
    verdict?: StoredRowVerdict,
  ): Promise<Record<string, unknown> | null> {
    verdict ??= await this.storedRowVerdict(sessionId, waMessageId, judge);
    return this.writeJudgedReactions(sessionId, waMessageId, changes, judge, verdict);
  }

  /** {@link writeReactions} with the verdict in hand. */
  async writeJudgedReactions(
    sessionId: string,
    waMessageId: string,
    changes: Record<string, string>,
    judge: MutationSource,
    verdict: StoredRowVerdict,
  ): Promise<Record<string, unknown> | null> {
    if (verdict.reason) return null;
    if (verdict.unread) throw unreadRowError(verdict);
    return updateMessageMetadata(
      this.messageRepository,
      this.writeTarget(sessionId, waMessageId, judge, verdict)!,
      current => {
        const reactions = { ...(current.reactions as Record<string, string> | undefined) };
        for (const [sender, reaction] of Object.entries(changes)) {
          if (reaction) reactions[sender] = reaction;
          else delete reactions[sender];
        }
        return { ...current, reactions };
      },
    );
  }

  /** Rewrite the delivery copies of an edited message, judged by their payloads; throws when the database fails. */
  private async changeCopies(
    sessionId: string,
    waMessageId: string,
    body: string,
    source: MutationSource | undefined,
    verdict?: StoredRowVerdict,
  ): Promise<void> {
    const filed = verdict?.moved && verdict.row ? revokeSourceFor(verdict.row) : undefined;
    const ours = Boolean(verdict?.exists && !verdict.reason);
    const predicate = source ? outboxPayloadPredicate(source, this.resolveLid, ours, filed) : undefined;
    await this.webhookService.changeMessageCopies?.(sessionId, waMessageId, { kind: 'rewrite', body }, predicate);
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
          // too, and only the writer that changed the text reports it. The row is marked edited either way.
          const slot: EditSlot = { body, judge: source, mark: 'always', announceText: true };
          try {
            await this.writeEdit(sessionId, messageId, slot, true, verdict);
            this.settled(sessionId, messageId, { edit: slot });
          } catch (err) {
            this.park(sessionId, messageId, { edit: slot }, err);
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
