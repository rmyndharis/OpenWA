import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm';
import { Session } from './entities/session.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import { SessionLidResolver } from './session-lid-resolver.service';
import { buildMessageMetadata, storableWaMessageId } from './message-row.mapper';
import { MessageMutationProjector } from './message-mutation-projector';
import { persistHistoryMessages } from './message-history-projector';
import { isUniqueConstraintError } from '../../common/utils/unique-constraint.util';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { StatusStoreService } from '../status-store/status-store.service';
import { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';
import { AutomationRulesService } from '../automation/automation-rules.service';
import { buildIncomingStatus } from '../status-store/incoming-status';
import type { StatusUpdate } from '../status-store/entities/status-update.entity';
import {
  IWhatsAppEngine,
  DeliveryStatus,
  IncomingMessage,
  ReactionEvent,
  EditedMessage,
  RevokedMessage,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import {
  deliveryStatusToMessageStatus,
  deliveryStatusToAck,
  ackStatusTransitionFrom,
} from '../message/message-status.util';

/**
 * Projects engine message events into the `messages` table and out to webhooks/WebSocket.
 *
 * This is the data path for messages: inbound arrivals, own-send echoes, delivery acks, revokes,
 * reactions, edits, and the pre-connection history backfill. It is deliberately separate from
 * SessionEngineLifecycle, which owns the session *lifecycle* (start/stop/delete/reconnect). The two
 * share
 * only the engine identity guard — a late event from a superseded engine must never mutate a
 * session that now belongs to a different one, or to none — which both read from EngineRegistry.
 *
 * Every entry point takes the captured `(sessionId, engine)` pair its engine callback closed over,
 * so those staleness checks behave exactly as they did while this code sat inline in
 * initializeEngine.
 */
/**
 * Delay before retrying an ack UPDATE that matched 0 rows. A fast delivered/read ack can arrive before
 * the send's 2nd save (which writes waMessageId) has committed, so the first UPDATE finds no row. One
 * retry after this delay closes that race; the forward-only transition guard keeps it idempotent.
 */
export const ACK_RECONCILE_DELAY_MS = 750;

/** Persist-stage outcome threaded into the inbound dispatch stage (was closure state in the hook continuation). */
interface InboundPersistOutcome {
  dbMessage: Message;
  persisted: boolean;
}

/**
 * Type of the `{ ...message }` copy the `message:received` hook returns (was the closure-inferred
 * spread type in handleInboundMessage). Kept as an object type rather than the IncomingMessage
 * interface so it stays assignable to the Record<string, unknown> dispatch/emit params — interfaces
 * carry no implicit index signature.
 */
type InboundMessageData = { [K in keyof IncomingMessage]: IncomingMessage[K] };

@Injectable()
export class MessageProjector {
  private readonly logger = createLogger('MessageProjector');

  // Serializes stored-message mutations per `${sessionId}:${waMessageId}`. Reactions perform a
  // read-modify-write and rapid edits must remain latest-write-wins; sharing one chain also preserves
  // order when different mutation kinds for the same message arrive together.
  private readonly messageMutations = new KeyedMutationQueue((key, err) => {
    // Both current mutation implementations contain their own contextual error handling. Keep a
    // final guard here so a future implementation cannot leak a rejected fire-and-forget promise
    // or permanently block the message's later mutations.
    this.logger.error(`Unexpected failure applying message mutation: ${key}`, String(err));
  });

  // Reaction/edit applies, extracted to a plain collaborator. It shares this instance's
  // messageMutations queue, so the public enqueue path and the queued applies serialize on one chain.
  private readonly mutationProjector: MessageMutationProjector;

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    private readonly engines: EngineRegistry,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
    private readonly statusStore: StatusStoreService,
    private readonly lidResolver: SessionLidResolver,
    @Optional()
    private readonly configService?: ConfigService,
    // Optional so the projector can still be constructed standalone (specs, and any wiring that
    // predates the archive). Absent simply means inbound media is not archived.
    @Optional()
    private readonly chatMediaArchive?: ChatMediaArchiveService,
    // Optional for the same reason. Absent simply means no autoreply rules are evaluated.
    @Optional()
    private readonly automationRules?: AutomationRulesService,
  ) {
    this.mutationProjector = new MessageMutationProjector(
      this.messageRepository,
      this.eventsGateway,
      this.webhookService,
      this.messageMutations,
      this.logger,
    );
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleInboundMessage(id: string, engine: IWhatsAppEngine, message: IncomingMessage): void {
    if (!this.engines.isLive(id, engine)) return;
    if (message.isStatusBroadcast) {
      this.ingestInboundStatus(id, engine, message);
      return;
    }
    if (this.shouldSkipEphemeralMessage(id, message)) return;
    this.logger.debug(`Message received from ${message.from}`, {
      sessionId: id,
      messageId: message.id,
      from: message.from,
      action: 'message_received',
    });
    // Update last active timestamp
    void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
    // Convert IncomingMessage to plain object for dispatch
    const messageData = { ...message };

    // Execute hook for message received - plugins can modify or stop processing
    void this.hookManager
      .execute('message:received', messageData, {
        sessionId: id,
        source: 'Engine',
      })
      .then(({ data: finalMessage }) => this.projectInboundMessage(id, engine, finalMessage))
      .catch(err => this.logger.error(`onMessage handler failed for ${id}`, String(err)));
  }

  /** `isStatusBroadcast` arm of {@link handleInboundMessage}: ingest into the status store, not the message pipeline. */
  private ingestInboundStatus(id: string, engine: IWhatsAppEngine, message: IncomingMessage): void {
    // Status/Story posts arrive via the inbound path for some engines; ingest them into the
    // status store instead of the message pipeline. Mirrors the isStatusBroadcast guard in
    // onMessageCreate below: an own-send echo (fromMe) stays a plain drop — never ingested,
    // never dispatched — so a status you posted never re-appears in your own webhooks/API as
    // if a contact had posted it.
    if (message.fromMe) return;
    const status = buildIncomingStatus(message);
    if (status) {
      void this.statusStore
        .ingest(id, status)
        // Dispatch only on a fresh insert: ingest also resolves with the pre-existing row
        // for a duplicate delivery (or the winner's row after a lost insert race), and the
        // webhook must fire once per status, not once per (re)delivery.
        .then(({ row, created }) => {
          // The ingest awaited; a stop()/delete() can retire this engine mid-flight — don't
          // dispatch for a session that no longer exists (mirrors message.received's re-check).
          if (!this.engines.isLive(id, engine)) return;
          if (created) this.dispatchStatusReceived(id, row);
        })
        .catch(err =>
          this.logger.warn('Status ingest failed', {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
  }

  /** Operator opt-out gate for disappearing messages: true when the message must be skipped entirely. */
  private shouldSkipEphemeralMessage(id: string, message: IncomingMessage): boolean {
    // Ephemeral/disappearing messages: skip persist + dispatch when the operator opted out.
    // A message is ephemeral when its chat has a disappearing-messages timer (ephemeralDuration > 0).
    if (
      !resolveFeatureFlags(this.configService).storeEphemeralMessages &&
      message.ephemeralDuration &&
      message.ephemeralDuration > 0
    ) {
      this.logger.debug('Skipping ephemeral message', {
        sessionId: id,
        messageId: message.id,
        chatId: message.chatId,
        ephemeralDuration: message.ephemeralDuration,
      });
      return true;
    }
    return false;
  }

  /** Post-hook continuation of {@link handleInboundMessage}: resolve sender, persist, dispatch. */
  private async projectInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    finalMessage: InboundMessageData,
  ): Promise<void> {
    // `continue: false` is deliberately NOT read here. It means "stop the handler chain", which
    // HookManager has already done — the plugins after the one that returned it never ran. It
    // does not mean "this message never happened".
    //
    // Honouring it here used to skip everything below: the message was never written to the
    // messages table, never dispatched to webhooks, and never emitted over the websocket. An
    // auto-reply plugin returning `false` for its ordinary purpose — keeping other bots from
    // answering the same message — silently erased the customer's message from the operator's
    // own history, leaving a thread of bot replies answering nothing. Nothing in the hook
    // contract (`HookResult.continue`, docs/19) or the webhook contract (`message.received`
    // fires when "an inbound message arrives", docs/06) hinted at that, and a sandboxed
    // marketplace plugin could swallow a session's entire inbound traffic with no audit trail.
    //
    // The message has already arrived at WhatsApp. A plugin can stop other plugins from acting
    // on it; it cannot make the gateway forget it. Pre-action hooks are where a veto belongs —
    // `message:sending` blocks a send that has not happened yet (core/hooks/sending-gate.ts).

    // Persist the incoming message so the dashboard chats view can render history.
    const incoming: IncomingMessage = finalMessage;

    // Inline @lid -> phone resolution (#263), opt-in via RESOLVE_LID_TO_PHONE. Best-effort:
    // attaches senderPhone (digits or null) before persist/dispatch so webhook/ws consumers
    // get it in a single pass. Only for privacy-id senders, so no lookup for normal numbers.
    if (resolveFeatureFlags(this.configService).resolveLidToPhone && incoming.isLidSender && !incoming.fromMe) {
      incoming.senderPhone = await this.lidResolver.resolveSenderPhone(id, incoming.author ?? incoming.from);
    }

    const outcome = await this.persistInboundMessage(id, engine, incoming);
    if (!outcome) return;
    this.dispatchInboundMessage(id, finalMessage, outcome);
  }

  /**
   * Build the inbound row and insert it under the UNIQUE dedup oracle. Returns the row plus whether
   * the insert landed, or null when the pipeline must stop (stale engine, or duplicate re-fire).
   */
  private async persistInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    incoming: IncomingMessage,
  ): Promise<InboundPersistOutcome | null> {
    const metadata = buildMessageMetadata(incoming);

    const chatName = incoming.contact?.pushName ?? incoming.contact?.name ?? undefined;

    const dbMessage = this.messageRepository.create({
      sessionId: id,
      waMessageId: storableWaMessageId(incoming.id),
      chatId: incoming.chatId,
      chatName,
      // Group poster (participant JID) — `from` is the group JID, so this is the stable
      // sender identity the chat view keys attribution runs/colors on. Undefined for 1:1.
      author: incoming.author,
      from: incoming.from,
      to: incoming.to,
      body: incoming.body,
      type: incoming.type,
      direction: incoming.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
      timestamp: incoming.timestamp,
      status: MessageStatus.SENT,
      metadata,
    });

    // The hook chain above is async; a delete()/teardown can retire this engine while it
    // awaits. Re-check liveness so a late continuation can't persist an orphan messages row
    // (the row has no FK, so a session-delete cleanup would never reap it) or dispatch for a
    // session that no longer exists. Mirrors the synchronous isLiveEngine gate at entry.
    if (!this.engines.isLive(id, engine)) return null;

    // De-duplicate at the source: the engine can re-fire `message` for one inbound message
    // (#464). UNIQUE(sessionId, waMessageId) makes the insert the atomic dedup oracle — a
    // near-simultaneous re-fire loses the race and is skipped here, so persist + webhook + WS
    // happen exactly once. Fail-open: a non-conflict DB error still dispatches, so a real
    // message is never dropped by a transient DB failure.
    let isNewMessage = true;
    let persisted = false;
    try {
      // `insert()` (not `save()`) is load-bearing: the UNIQUE(sessionId, waMessageId) constraint
      // makes a duplicate insert throw, which is the atomic dedup oracle for #464 re-fires.
      // Unlike `save()`, `insert()` does NOT merge DB-generated columns (@PrimaryGeneratedColumn,
      // @CreateDateColumn) back onto the entity instance — so merge them explicitly here, before
      // the `message:persisted` emit. `identifiers[0]` always carries the PK on both SQLite and
      // Postgres; `generatedMaps[0]` adds createdAt where the driver returns it (Postgres yes;
      // SQLite historically does not — acceptable; the PK is the load-bearing field for plugins).
      const result = await this.messageRepository.insert(dbMessage as unknown as QueryDeepPartialEntity<Message>);
      Object.assign(dbMessage, result.identifiers[0] ?? {}, result.generatedMaps?.[0] ?? {});
      persisted = true;
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        isNewMessage = false;
      } else {
        this.logger.error(`Failed to save incoming message ${incoming.id} to database`, String(err));
      }
    }
    if (!isNewMessage) {
      return null; // duplicate re-fire — the original already persisted and dispatched
    }
    return { dbMessage, persisted };
  }

  /** Fan an accepted inbound message out: `message:persisted` plugin hook, webhook, websocket emit. */
  private dispatchInboundMessage(id: string, finalMessage: InboundMessageData, outcome: InboundPersistOutcome): void {
    const { dbMessage, persisted } = outcome;
    // Fire-and-forget: a plugin handler must never break the receive path. Both engine adapters
    // (wwjs `message` and Baileys `upsert`) converge on this persist, so one emit covers inbound.
    // The built-in FTS search provider is DB-synced and does NOT consume this; it exists for
    // plugin providers (Spec 2) + general use.
    // Gate ONLY the hook on `persisted`: on a non-unique insert error (transient SQLITE_BUSY /
    // lock-timeout / connection drop) the row was never stored and `dbMessage.id` is undefined,
    // so emitting `message:persisted` would hand plugins an id-less payload for a row that isn't
    // in the DB. The webhook/WS dispatch below stays fail-open — a real inbound message must
    // never be dropped on a transient DB failure; only the hook requires a durable row.
    if (persisted) {
      void this.hookManager
        .execute(
          'message:persisted',
          { sessionId: id, message: dbMessage },
          { sessionId: id, source: 'SessionService' },
        )
        .catch(() => undefined);

      // Fire-and-forget for the same reason as the hook above: the receive path must not wait on
      // storage. Gated on `persisted` because the archive updates the row by id, and on a failed
      // insert there is no row to point at the file. A no-op unless archiving is enabled.
      void this.chatMediaArchive?.archive(dbMessage).catch(() => undefined);
    }

    // Dispatch to webhooks with potentially modified message
    void this.webhookService.dispatch(id, 'message.received', finalMessage);
    // Autoreply rules ride the same at-most-once dispatch (the insert oracle above dedupes engine
    // re-fires) and stay fail-open like the webhook: a broken rule must never break the receive path.
    void this.automationRules?.evaluateInbound(id, finalMessage).catch(() => undefined);
    // Emit real-time event to WebSocket clients
    this.eventsGateway.emitMessage(id, finalMessage);
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleOwnSendEcho(id: string, engine: IWhatsAppEngine, message: IncomingMessage): void {
    if (!this.engines.isLive(id, engine)) return;
    // `message_create` fires for every message the account creates, including sends composed on a
    // linked phone — which the `message`/`onMessage` event never delivers. Incoming messages are
    // already handled by `onMessage`, so only outgoing (`fromMe`) ones produce `message.sent` here.
    if (!message.fromMe) {
      return;
    }

    // Status/Story posts are account-created but not real conversations; don't emit `message.sent`
    // for them. The adapter flags these (the engine-specific pseudo-JID stays out of this layer).
    if (message.isStatusBroadcast) {
      return;
    }

    this.logger.debug(`Message sent to ${message.to}`, {
      sessionId: id,
      messageId: message.id,
      to: message.to,
      action: 'message_sent',
    });
    // Update last active timestamp
    void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
    const messageData = { ...message };

    // Execute hook for message sent - plugins can modify or stop processing
    void this.hookManager
      .execute('message:sent', messageData, {
        sessionId: id,
        source: 'Engine',
      })
      .then(async ({ data: finalMessage }) => {
        // `continue: false` is not read here, for the same reason as the message:received path
        // above: the send has already happened, so a plugin can stop the handler chain but cannot
        // un-send it. Skipping the persist below dropped the operator's own outgoing message from
        // history and from `message.sent` webhooks.

        // Persist the outgoing message so local history reflects sends composed on a linked phone
        // (message_create is the ONLY event those produce). It also fires for API-originated sends,
        // which the REST send path persists itself — the UNIQUE(sessionId, waMessageId) index is
        // the atomic dedup oracle between the two writers: the loser skips its insert, and
        // persistSentState additionally drops its redundant PENDING row when the echo won. The
        // webhook/WS dispatch below is identical whether the insert won, lost, or failed — the
        // message.sent contract is unchanged.
        const outgoing: IncomingMessage = finalMessage;
        const metadata = buildMessageMetadata(outgoing, true);

        // The ephemeral opt-out gates STORAGE only (mirrors onMessage); the live dispatch below
        // is today's contract and stays.
        const mayPersist =
          resolveFeatureFlags(this.configService).storeEphemeralMessages ||
          !(outgoing.ephemeralDuration && outgoing.ephemeralDuration > 0);

        if (mayPersist) {
          const dbMessage = this.messageRepository.create({
            sessionId: id,
            waMessageId: storableWaMessageId(outgoing.id),
            chatId: outgoing.chatId,
            from: outgoing.from,
            to: outgoing.to,
            body: outgoing.body,
            type: outgoing.type,
            direction: MessageDirection.OUTGOING,
            timestamp: outgoing.timestamp,
            status: MessageStatus.SENT,
            metadata,
          });
          // The hook chain above is async; a delete()/teardown can retire this engine while it
          // awaits. Re-check liveness so a late continuation can't persist an orphan row
          // (mirrors onMessage).
          if (!this.engines.isLive(id, engine)) return;
          let persisted = false;
          try {
            const result = await this.messageRepository.insert(dbMessage as unknown as QueryDeepPartialEntity<Message>);
            Object.assign(dbMessage, result.identifiers[0] ?? {}, result.generatedMaps?.[0] ?? {});
            persisted = true;
          } catch (err) {
            // Unique violation = the REST send path already persisted this API-originated send —
            // the dedup oracle working as intended, not an error. Anything else is a real DB
            // failure; fail open so a real send is never dropped on a transient DB fault.
            if (!isUniqueConstraintError(err)) {
              this.logger.error(`Failed to save outgoing message ${outgoing.id} to database`, String(err));
            }
          }
          if (persisted) {
            // Fire-and-forget, mirroring onMessage: plugin providers (search etc.) see phone-
            // composed sends exactly like API sends.
            void this.hookManager
              .execute(
                'message:persisted',
                { sessionId: id, message: dbMessage },
                { sessionId: id, source: 'SessionService' },
              )
              .catch(() => undefined);
          }
        }

        void this.webhookService.dispatch(id, 'message.sent', finalMessage);
        // Emit real-time event to WebSocket clients (as message.sent, not message.received)
        this.eventsGateway.emitMessageSent(id, finalMessage);
      })
      .catch(err => this.logger.error(`onMessageCreate handler failed for ${id}`, String(err)));
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleMessageAck(id: string, engine: IWhatsAppEngine, messageId: string, status: DeliveryStatus): void {
    if (!this.engines.isLive(id, engine)) return;
    this.logger.debug(`Message ack: ${messageId} -> ${status}`, {
      sessionId: id,
      messageId,
      status,
      action: 'message_ack',
    });

    // Reflect real delivery state on the stored message (#220): delivered/read/failed advance the
    // stored status; pending/sent carry no upgrade (it's already SENT — visibly "not delivered").
    // The UPDATE is guarded to the allowed prior statuses so delivery state only ADVANCES: an
    // out-of-order/late ack cannot downgrade a higher status, which also makes these
    // fire-and-forget writes race-safe at the DB level.
    const messageStatus = deliveryStatusToMessageStatus(status);
    if (messageStatus) {
      // Scope by sessionId: waMessageId is unique per account/chat, not global — an ack on one
      // session must never advance a same-id row in another session. The In() guard makes the
      // UPDATE forward-only (a late/out-of-order ack can't downgrade) and idempotent on retry.
      const advanceAck = (): Promise<number> =>
        this.messageRepository
          .update(
            { sessionId: id, waMessageId: messageId, status: In(ackStatusTransitionFrom(messageStatus)) },
            { status: messageStatus },
          )
          .then(result => result.affected ?? 0);

      const logNoop = (): void =>
        this.logger.debug(`Message ack ${messageId}: no status row advanced to ${messageStatus} (${status})`, {
          sessionId: id,
          messageId,
          status,
          action: 'message_ack_noop',
        });

      const onAckError = (err: unknown): void =>
        this.logger.error(`Failed to advance ack for ${messageId}`, String(err));

      void advanceAck()
        .then(affected => {
          if (affected > 0) return;
          // affected:0 — most likely the send's 2nd save (which writes waMessageId) hasn't committed
          // yet, so the row isn't matchable. Each ack is one-shot (WhatsApp won't necessarily resend),
          // so retry ONCE after a short delay to close that race rather than leave it stuck at SENT.
          const timer = setTimeout(() => {
            void advanceAck()
              .then(retried => {
                if (retried === 0) logNoop();
              })
              .catch(onAckError);
          }, ACK_RECONCILE_DELAY_MS);
          timer.unref?.();
        })
        .catch(onAckError);
    }

    // One ack payload, emitted identically over the socket and the webhook so a client coded
    // against either channel sees the same shape. `id` mirrors the field every other message.*
    // event carries (and the idempotency-key resolver reads). `ack` is a deprecated legacy field
    // kept for backward compatibility — new consumers should read the neutral `status`.
    const ackPayload = { id: messageId, messageId, status, ack: deliveryStatusToAck(status) };

    // Push the live delivery/read tick to the dashboard over the websocket.
    this.eventsGateway.emitMessageAck(id, ackPayload);

    // Dispatch the delivery/read receipt to webhooks (#155). Outgoing `message.sent` is handled
    // solely by `onMessageCreate`, so the ack path deliberately does NOT emit `message.sent`.
    void this.webhookService.dispatch(id, 'message.ack', ackPayload);

    // Surface delivery failures actively so consumers don't have to poll for them (#220). Use a
    // distinct object (not the shared ackPayload) so this separate event can't be perturbed by an
    // in-place payload mutation in the concurrent message.ack dispatch's webhook:before hook.
    if (status === 'failed') {
      void this.webhookService.dispatch(id, 'message.failed', { ...ackPayload });
    }

    // Notify plugins of the delivery/read receipt. The `message:ack` hook event was declared in
    // the HookEvent union but never emitted, so any plugin registered for it silently never fired.
    // Fire-and-forget: an ack is a notification with nothing downstream to cancel, so the hook's
    // `continue` flag is moot. Delivery failures surface here as status `failed` — `message:failed`
    // stays reserved for send-time send failures, which carry a distinct `{ error, input }` payload.
    void this.hookManager.execute(
      'message:ack',
      { messageId, status, ack: deliveryStatusToAck(status) },
      { sessionId: id, source: 'Engine' },
    );
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleMessageRevoked(id: string, engine: IWhatsAppEngine, message: RevokedMessage): void {
    if (!this.engines.isLive(id, engine)) return;
    this.logger.debug(`Message revoked: ${message.id}`, {
      sessionId: id,
      messageId: message.id,
      action: 'message_revoked',
    });

    // Flag the stored message as revoked (best-effort; the message may not be in the
    // DB). The dashboard renders the localized "message deleted" text, so no display
    // string is persisted here.
    //
    // Match on `revokedId` (the ORIGINAL deleted message's id) when present: on wwebjs
    // `message.id` is the revocation notification, which never matches a stored row.
    // `revokedId` falls back to `id` (Baileys, where the two are the same).
    const revokedWaMessageId = message.revokedId ?? message.id;
    void this.messageRepository
      .update({ sessionId: id, waMessageId: revokedWaMessageId }, { body: '', type: 'revoked' })
      .catch(err => {
        this.logger.error(`Failed to update revoked message: ${revokedWaMessageId}`, String(err));
      });

    // Notify consumers regardless of whether the row existed: webhook (message.revoked
    // is a declared event) + the real-time dashboard stream.
    const revokedPayload = message as unknown as Record<string, unknown>;
    void this.webhookService.dispatch(id, 'message.revoked', revokedPayload);
    this.eventsGateway.emitMessageRevoked(id, revokedPayload);
  }

  /** History backfill persist, extracted to message-history-projector.ts (stateless function). */
  persistHistoryMessages(id: string, messages: IncomingMessage[]): Promise<void> {
    return persistHistoryMessages(this.messageRepository, this.configService, id, messages, this.logger);
  }

  /** Reaction apply, queued on the per-message mutation chain — see MessageMutationProjector. */
  applyReactionQueued(id: string, event: ReactionEvent): void {
    this.mutationProjector.applyReactionQueued(id, event);
  }

  /** Edit apply, queued on the per-message mutation chain — see MessageMutationProjector. */
  applyMessageEditQueued(id: string, message: EditedMessage): void {
    this.mutationProjector.applyMessageEditQueued(id, message);
  }

  /** Queue a message-scoped mutation. A failed operation is isolated so later events still run. */
  enqueueMessageMutation(id: string, messageId: string, work: () => Promise<void>): void {
    this.mutationProjector.enqueueMessageMutation(id, messageId, work);
  }

  /** Stored-row update for a REST outbound edit, on the same mutation chain — see MessageMutationProjector. */
  recordOutboundMessageEdit(sessionId: string, messageId: string, body: string): Promise<void> {
    return this.mutationProjector.recordOutboundMessageEdit(sessionId, messageId, body);
  }

  /**
   * Dispatches the opt-in `status.received` webhook once an inbound status row is ingested, and
   * mirrors it over the websocket so the dashboard's statuses view refreshes live instead of
   * waiting for a focus refetch. `WebhookService.dispatch` already filters delivery to webhooks
   * whose `events` array includes `status.received`, so no extra gating is needed here. No media
   * bytes are included in the payload — consumers fetch media via the status media endpoint.
   */
  private dispatchStatusReceived(sessionId: string, row: StatusUpdate): void {
    const payload = {
      sessionId,
      statusId: row.waStatusId,
      contact: {
        id: row.contactJid,
        ...(row.contactName ? { name: row.contactName } : {}),
        ...(row.contactPushName ? { pushName: row.contactPushName } : {}),
      },
      type: row.type,
      ...(row.caption ? { caption: row.caption } : {}),
      hasMedia: Boolean(row.mediaPath) && !row.mediaOmitted,
      mediaOmitted: row.mediaOmitted,
      ...(row.omitReason ? { omitReason: row.omitReason } : {}),
      postedAt: row.postedAt,
      expiresAt: row.expiresAt,
    };
    void this.webhookService.dispatch(sessionId, 'status.received', payload);
    this.eventsGateway.emitStatusReceived(sessionId, payload);
  }
}
