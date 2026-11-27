import { randomUUID } from 'node:crypto';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { chatKind } from '../../engine/identity/wa-id';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, type FindOptionsWhere, Repository, In, Not } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm';
import { Session } from './entities/session.entity';
import { judgeStoredRow, outboxPayloadPredicate, revokeSourceFor } from './message-row-judgement';
import { Message, MessageDirection, MessageStatus, type MessageEngineRef } from '../message/entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import { awaitNoOpenTransaction } from '../../common/utils/shared-connection';
import { captureSessionWrites } from '../../common/utils/session-write-scope';
import { SessionLidResolver } from './session-lid-resolver.service';
import { SessionOwnershipService, nodeOwnsSession } from './session-ownership.service';
import { buildMessageMetadata, REVOKED_ROW_PATCH, storableWaMessageId } from './message-row.mapper';
import {
  MessageMutationProjector,
  ownRowVerdict,
  type StoredRowVerdict,
  unreadRowError,
} from './message-mutation-projector';
import {
  ParkedChange,
  journalChange,
  restoredChange,
  slotNames,
  type AckSlot,
  type ChangeSlots,
  type OwnRow,
  type ParkedChangeSteps,
  type RevokeSlot,
} from './message-change-park';
import {
  RECOVERY_MAX_AGE_MS,
  RECOVERY_MAX_RECORDS,
  RecoveryQueue,
  isDatabaseUnavailable,
  receivedRowKey,
  recoveryQueueOptions,
  sendRerunKey,
  type RecoveryLoss,
} from '../../common/utils/recovery-queue';
import {
  KeptInbound,
  ReceivedRow,
  journalKeptInbound,
  journalReceivedRow,
  keptInboundKey,
  restoredKeptInbound,
  restoredReceivedRow,
  type KeptInboundKind,
  type KeptInboundSteps,
  type ReceivedRowSteps,
} from './received-row';
import { resolveWebhookReconcilerOptions } from '../webhook/webhook-reconciler.service';
import {
  mutationTargetsForeignRow,
  mutationTargetsForeignRowPersisted,
  receiptTargetsForeignRow,
  receiptTargetsForeignRowPersisted,
  type MutationSource,
  type StoredMessageRef,
} from './message-mutation-guard';
import { mergeSentMetadata, updateMessageMetadata } from '../message/message-metadata';
import { persistHistoryMessages } from './message-history-projector';
import { isTransientDbError, isUniqueViolation } from '../../common/utils/db-errors';
import { resolveFeatureFlags } from '../../config/feature-flags';
import { StatusStoreService } from '../status-store/status-store.service';
import { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';
import { AutomationRulesService } from '../automation/automation-rules.service';
import { buildIncomingStatus, type IncomingStatus } from '../status-store/incoming-status';
import type { StatusUpdate } from '../status-store/entities/status-update.entity';
import {
  IWhatsAppEngine,
  DeliveryStatus,
  MessageReceiptEvent,
  IncomingMessage,
  InboundOutcome,
  InboundReceipt,
  InboundTicket,
  ReactionEvent,
  EditedMessage,
  RevokedMessage,
} from '../../engine/interfaces/whatsapp-engine.interface';
import { handsBackInbound } from '../../engine/interfaces/inbound-redelivery';
import { deferred, InboundRoom, roomState, type RoomState } from './inbound-room';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { type PreparedWebhookDelivery, WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import {
  deliveryStatusToMessageStatus,
  deliveryStatusToAck,
  ackStatusTransitionFrom,
} from '../message/message-status.util';
import { isMessagePayload } from '../../core/hooks/hook-results';

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

/**
 * Delay before the single retry of a message insert that failed transiently (lock contention, a
 * dropped connection, a pool timeout). The engine delivers each message once, so without the retry
 * one busy moment loses the row for good.
 */
export const PERSIST_RETRY_DELAY_MS = 300;

/**
 * The most often one engine stamps its session's `lastActiveAt`. Its readers (the session response, the dashboard,
 * the data export) need nothing near per-message precision, so a write per message cost a row version per message
 * on the one session row for nothing. `lastActive` can therefore lag the latest message by up to this long.
 */
export const LAST_ACTIVE_WRITE_WINDOW_MS = 30_000;

/** How many of its messages marked edited a session remembers as marked (see markedEdited). */
const EDITED_MARKS_KEPT_PER_SESSION = 500;

/**
 * Value snapshot of the in-flight mutation fields that affect `withChangesMadeInFlight()`.
 * Used to detect post-prepare edits or revokes without relying on object reference identity.
 */
interface InFlightMutationSnapshot {
  revoked: boolean;
  revokeAnnounced: boolean;
  editedBody: string | undefined;
  edited: boolean;
  rowMarked: boolean;
}

const snapshotInFlight = (entry: InFlightEntry, rowMarked = false): InFlightMutationSnapshot => ({
  revoked: entry?.revoked === true,
  revokeAnnounced: entry?.revokeAnnounced === true,
  editedBody: entry?.editedBody,
  edited: entry?.edited === true,
  rowMarked,
});

const sameInFlightSnapshot = (a: InFlightMutationSnapshot, b: InFlightMutationSnapshot): boolean =>
  a.revoked === b.revoked &&
  a.revokeAnnounced === b.revokeAnnounced &&
  a.editedBody === b.editedBody &&
  a.edited === b.edited &&
  a.rowMarked === b.rowMarked;

/**
 * How a message insert ended: `yes` the row landed (with `openedDeliveries` holding the subset of
 * prepared outbox rows newly inserted in the transaction, or `rowOnly` when that transaction failed
 * and the row was then stored without any of them), `dup` a unique violation (`retried` says
 * whether it came from a later attempt, when an earlier one may have committed before its error),
 * `failed` a non-conflict error, `stale` the engine was retired while the retry waited.
 */
/** Bounds of the changes kept while the database refuses them: per message id, and for how long one with content stays. */
export const PARKED_CHANGES_MAX = RECOVERY_MAX_RECORDS.change;
export const PARKED_CHANGE_MAX_AGE_MS = RECOVERY_MAX_AGE_MS;
/** Changes of one kind kept for one message whose claims disagree, each judged against the row when it is tried. */
export const PARKED_VARIANTS_MAX = 4;

/** What an unlink drops of what is kept for the engine of the account it unlinked (see forgetKeptInbound). */
const FORGOTTEN_AT_UNLINK: ReadonlySet<KeptInboundKind> = new Set(['message', 'copy', 'blank', 'text', 'remove']);

/** The log line and action of each kind of kept inbound record given up. */
const KEPT_INBOUND_LOSS: Readonly<Record<KeptInboundKind, [string, string]>> = {
  message: [
    'A message kept until its stored target could be read could not be kept any longer',
    'message_inbound_lost',
  ],
  copy: ['The stored copy of a message the database refused could not be kept any longer', 'message_copy_lost'],
  blank: [
    'A delete of the stored copy of a message could not be kept any longer: its deleted text may survive in the copy',
    'message_copy_blank_lost',
  ],
  text: ['An edit of the stored copy of a message could not be kept any longer', 'message_copy_edit_lost'],
  remove: [
    'The removal of a stored copy a conflicting message left could not be kept any longer: the copy stays',
    'message_copy_remove_lost',
  ],
  story: [
    'A received status the database refused could not be kept any longer: it is not stored or announced',
    'status_ingest_lost',
  ],
  'story-removal': [
    'A status its poster deleted could not be removed: it stays listed until it expires',
    'status_removal_lost',
  ],
  wipe: [
    'What an unlinked account left in the stored messages and chat states could not be cleared: the next account may see it',
    'message_store_wipe_lost',
  ],
};

/** The one pass the kept changes get at shutdown, once the engines are gone (a stage of shutdown-budget.ts). */
export const PARKED_CHANGES_SHUTDOWN_PASS_MS = 1_000;

/** The ref a change claims, as the rule reads a row: so a later change can be told consistent with a kept one. */
const refOfSource = (source: MutationSource): StoredMessageRef => ({
  chatId: source.chatId,
  direction:
    source.fromMe === undefined ? undefined! : source.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
  author: source.author,
});

type InsertOutcome =
  | { landed: 'yes'; openedDeliveries?: PreparedWebhookDelivery[]; rowOnly?: true }
  | { landed: 'failed'; error?: unknown }
  | { landed: 'stale' }
  | { landed: 'dup'; retried: boolean };

/** Persist-stage outcome threaded into the inbound dispatch stage (was closure state in the hook continuation). */
interface InboundPersistOutcome {
  dbMessage: Message;
  persisted: boolean;
  prepared?: PreparedWebhookDelivery[];
  openedDeliveries?: PreparedWebhookDelivery[];
  preparedCommitted?: boolean;
  preparedSnapshot?: InFlightMutationSnapshot;
  retriedDup?: boolean;
}

/**
 * Type of the `{ ...message }` copy the `message:received` hook returns (was the closure-inferred
 * spread type in handleInboundMessage). Kept as an object type rather than the IncomingMessage
 * interface so it stays assignable to the Record<string, unknown> dispatch/emit params — interfaces
 * carry no implicit index signature.
 */
type InboundMessageData = { [K in keyof IncomingMessage]: IncomingMessage[K] };

const quoteOf = (m: Pick<IncomingMessage, 'chatId' | 'body'>) => ({ chatId: m.chatId, body: m.body });

/**
 * What a hook chain cannot take from a message, by leaving it out of a rewrite, returning it as null or removing
 * it from the object it was handed: which message it is, who sent it, when and as what, which its row cannot be
 * written without; what kind of chat it is in, which webhook filters judge it by; and the chat's disappearing
 * timer, which decides whether an own send is stored at all. Each with the type the engine reports it in: a value
 * of another type (an object for the sender) is none either, as the row could not take it.
 */
const FIELDS_KEPT_FROM_ENGINE = {
  id: 'string',
  chatId: 'string',
  from: 'string',
  to: 'string',
  fromMe: 'boolean',
  timestamp: 'number',
  type: 'string',
  author: 'string',
  isGroup: 'boolean',
  kind: 'string',
  isLidSender: 'boolean',
  ephemeralDuration: 'number',
} as const satisfies Partial<Record<keyof IncomingMessage, 'string' | 'number' | 'boolean'>>;

const KEPT_FIELDS = Object.keys(FIELDS_KEPT_FROM_ENGINE) as Array<keyof typeof FIELDS_KEPT_FROM_ENGINE>;

/** Those fields as the engine reported them. Read before the hook chain, which may change the object it is handed. */
const identityOf = (message: InboundMessageData): Partial<IncomingMessage> =>
  Object.fromEntries(KEPT_FIELDS.map(field => [field, message[field]]));

/** A deleted message as hooks and consumers see it: nothing of its content survives, as in REVOKED_ROW_PATCH. */
const deletedPlaceholder = (message: InboundMessageData): InboundMessageData => {
  /* eslint-disable @typescript-eslint/no-unused-vars */
  const {
    media,
    quotedMessage,
    call,
    buttons,
    button,
    location,
    order,
    product,
    poll,
    mentionedIds,
    isForwarded,
    forwardingScore,
    ...kept
  } = message;
  /* eslint-enable @typescript-eslint/no-unused-vars */
  return { ...kept, body: '', type: 'revoked' };
};

/** Where a message lives and who wrote it: what a change aimed at it is held to (see mutationTargetsForeignRow). */
const refOf = (m: Pick<IncomingMessage, 'chatId' | 'fromMe' | 'author'>): StoredMessageRef => ({
  chatId: m.chatId,
  direction: m.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
  author: m.author,
});

/** A message's chat, side and author as the engine reported them, copied before a hook can change the message. */
type EngineIdentity = Pick<IncomingMessage, 'chatId' | 'fromMe' | 'author'>;
/** {@link EngineIdentity} with the engine's `from` and `to`, which a hook may rewrite too. */
type EngineEnvelope = EngineIdentity & Pick<IncomingMessage, 'from' | 'to'>;
const engineIdentityOf = (m: EngineEnvelope): EngineEnvelope => ({
  chatId: m.chatId,
  fromMe: m.fromMe,
  author: m.author,
  from: m.from,
  to: m.to,
});
const endsRewritten = (engine: EngineEnvelope, filed: Pick<IncomingMessage, 'from' | 'to'>): boolean =>
  engine.from !== filed.from || engine.to !== filed.to;

/**
 * A delivery's claim as the engine reported it, with how a hook `filed` it when that differs (MutationSource.filedAs).
 * Only for telling the engine whether its copy stands for the stored row: no write may follow a filed claim, as the
 * chat a hook filed a delivery under may hold another message under the same id.
 */
const asFiled = (claim: MutationSource, filed: EngineIdentity): MutationSource =>
  filed.chatId === claim.chatId && filed.fromMe === claim.fromMe && filed.author === claim.author
    ? claim
    : { ...claim, filedAs: { chatId: filed.chatId, fromMe: filed.fromMe, author: filed.author } };

/** The engine ref a row filed as `filed` keeps (see Message.engineRef): null when the hooks kept what the engine said. */
const engineRefFor = (engine: StoredMessageRef, filed: StoredMessageRef, ends: boolean): MessageEngineRef | null =>
  !ends &&
  engine.chatId === filed.chatId &&
  engine.direction === filed.direction &&
  (engine.author ?? null) === (filed.author ?? null)
    ? null
    : { chatId: engine.chatId, direction: engine.direction, author: engine.author ?? null };

/** A row as `message:persisted` hands it over: the engine ref of a moved message stays in the gateway. */
const persistedRow = (row: Message): Message => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { engineRef, ...rest } = row;
  return rest;
};

/** What a delivery claims to be, as the rule that refuses a change aimed at a stored row reads it. */
const claimOf = (m: Pick<IncomingMessage, 'chatId' | 'fromMe' | 'author'>): MutationSource => ({
  kind: 'edit',
  chatId: m.chatId,
  fromMe: m.fromMe,
  author: m.author,
});

/** A message not yet written, and the changes that reached it meanwhile (see inboundInFlight). */
interface InFlightEntry {
  // What a quote of it may lend, as the hook chain last left it. Never the message itself: a repeat
  // delivery shares the entry, and its payload must not outlive the slot that accounts for it.
  // Unset while the message is admitted but not yet emitted (see admitInbound).
  quote?: Pick<IncomingMessage, 'chatId' | 'body'>;
  // Only the active delivery that supplied the checked quote may replace or clear it.
  quoteOwner?: object;
  // Where the message lives and who wrote it, so a change recorded for it meanwhile is held to the same
  // chat, direction and author rule as the row it will become (see mutationTargetsForeignRow).
  ref?: StoredMessageRef;
  revoked?: boolean;
  // Set when the revoke came from the engine, so message.revoked went out for it.
  revokeAnnounced?: boolean;
  editedBody?: string;
  // The text the message arrived with, which an edit is compared with: one that repeats the text so far changes
  // nothing. Unset while the message is admitted but not yet emitted.
  body?: string;
  // An edit held for the message or applied by the engine changed its text, or was asked for: the row it lands on is
  // marked edited.
  edited?: boolean;
  // The furthest ack kept for the row per chat its receipt named ('' when it named none), so one naming another chat
  // cannot displace one naming this message's: the insert advances the row by those its chat proves to be the row's.
  acks?: Map<string, MessageStatus>;
  // Latest reaction per sender; '' means the sender withdrew theirs.
  reactions?: Record<string, string>;
  // Deliveries sharing the entry: a repeat keeps what was recorded for the first one.
  holders?: number;
  // Shared by repeat deliveries while an identity comparison waits for the directory.
  changes?: { pending?: Promise<void> };
}

/** Scalar arrival data and the changes this delivery's identity may inherit. */
interface InFlightDelivery {
  entry: InFlightEntry;
  body: string;
  edited: boolean;
}

/**
 * A message admitted on arrival (PostgreSQL only): its place in the chat's hook and commit order, its
 * claim on the session's room when it downloads media, and its in-flight entry, so a change that
 * targets it before its emit is kept for its row.
 */
class InboundTurn implements InboundTicket {
  state: 'pending' | 'emitted' | 'dropped' = 'pending';
  /** The commit to run in the chat's turn, or null when the message will not be emitted. */
  readonly outcome = deferred<(() => Promise<void>) | null>();
  readonly emitted = deferred<void>();
  /** Resolved once every earlier message of the chat was emitted or dropped: the hook may start. */
  readonly hookGate = deferred<void>();
  private preparing?: Promise<void>;

  constructor(
    readonly engine: IWhatsAppEngine,
    public entry: InFlightEntry,
    private readonly room?: InboundRoom,
    readonly s?: RoomState,
  ) {}

  get revoked(): boolean {
    return this.entry.revoked === true;
  }

  /** A cross-form repeat inherits changes only once its directory comparison has finished. */
  prepareIdentity(pending: Promise<void>): void {
    this.preparing = Promise.race([pending, this.outcome.promise.then(() => undefined)]);
  }

  // A message revoked before its download needs none: its row is stored cleared.
  reserve(): boolean | Promise<boolean> {
    if (!this.s || !this.room || this.state === 'dropped') return false;
    if (this.preparing) {
      const preparing = this.preparing;
      return preparing.then(() => {
        if (this.preparing === preparing) this.preparing = undefined;
        return this.reserve();
      });
    }
    if (this.entry.revoked) return this.giveUp();
    return this.s.granted || this.room.wait(this.s).then(granted => granted && !this.entry.revoked);
  }

  /** Leave the room's queue, if still in it: once admitted, the claim passes the slot straight on. */
  giveUp(): false {
    if (this.s && !this.s.granted) {
      this.s.abandoned = true;
      this.s.grant.resolve(false);
    }
    return false;
  }

  holdUntil(p: Promise<unknown>): void {
    this.s?.holds.push(p.catch(() => undefined));
  }

  emit(job: () => Promise<void>): void {
    if (this.state !== 'pending') return;
    this.state = 'emitted';
    this.emitted.resolve();
    this.outcome.resolve(job);
  }

  drop(): void {
    if (this.state !== 'pending') return;
    this.state = 'dropped';
    this.outcome.resolve(null);
    this.emitted.resolve();
    this.giveUp();
  }
}

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

  // Serializes the insert and dispatch of each chat's messages, by `${sessionId}:${chatId}`: hook
  // chains finish in any order, but a chat's rows, websocket events and webhooks follow arrival.
  private readonly chatCommits = new KeyedMutationQueue((key, err) => {
    this.logger.error(`Unexpected failure committing a message: ${key}`, String(err));
  });

  // PostgreSQL only: a chat's `message:received` / `message:sent` chains start in arrival order, each
  // once every earlier admitted message of the chat was emitted or dropped (see admitInbound).
  private readonly chatEmits = new KeyedMutationQueue((key, err) => {
    this.logger.error(`Unexpected failure ordering a message: ${key}`, String(err));
  });

  // Per session, not per engine: a replaced engine's payloads still waiting for their rows keep
  // counting, so a reconnect cannot multiply the room.
  private readonly rooms = new Map<string, InboundRoom>();

  // Admitted messages not yet committed, by session, so retiring an engine can release its own.
  private readonly tickets = new Map<string, Set<InboundTurn>>();

  // Messages not yet written, by `${sessionId}:${waMessageId}`: inbound ones from the start of their
  // `message:received` chain, own-send echoes from the start of their `message:sent` chain, each until
  // its commit (which may wait behind earlier messages of the chat) ends. A handler that quotes the
  // message reads it from here, and a revoke, edit or ack landing meanwhile finds no row to update: it
  // is recorded here and applied once the row is written (see applyChangesMadeInFlight).
  // On PostgreSQL the entry exists from the message's arrival (admitInbound), before its emit.
  private readonly inboundInFlight = new Map<string, InFlightEntry>();

  // Ids whose row was marked edited, by session, while it has an engine: an own message delivered again loses its
  // insert to that row, and is announced with the mark without reading it (see commitOwnSendEcho). Never stored; past
  // EDITED_MARKS_KEPT_PER_SESSION the oldest is forgotten, and a repeat of it goes out unmarked.
  private readonly markedEdited = new Map<string, Set<string>>();

  // When each engine last stamped its session's lastActiveAt. By engine, not session, so a replacement engine stamps
  // with its first message and an entry goes with its engine.
  private readonly lastActiveStamped = new WeakMap<IWhatsAppEngine, number>();

  // Reaction/edit applies, extracted to a plain collaborator. It shares this instance's
  // messageMutations queue, so the public enqueue path and the queued applies serialize on one chain.
  private readonly mutationProjector: MessageMutationProjector;

  // Changes the database refused (a write that failed, or a row it could not read to judge them), kept to try again
  // once it answers, one record per message id: see ParkedChange and RecoveryQueue.
  private readonly recovery: RecoveryQueue;
  // The records kept for each message, oldest first: more than one when the claims of its kept changes disagree.
  private readonly parkedFor = new Map<string, ParkedChange[]>();
  // The changes of each message being parked now: they hold its deliveries as kept ones do until their records are final.
  private readonly parking = new Map<string, ChangeSlots[]>();
  private parkSeq = 0;
  private readonly parkSteps: ParkedChangeSteps = {
    outbox: change => this.parkedOutboxSteps(change),
    apply: change =>
      this.onChain(change.sessionId, change.waMessageId, () =>
        this.runSlots(change.sessionId, change.waMessageId, change.slots, {
          // One the journal restored announces its row whether or not the engine runs yet: the one it came from is
          // gone, and the plugins it reaches are back before it is tried.
          announce:
            change.restored || (change.engine !== undefined && this.engines.isLive(change.sessionId, change.engine)),
          owned: nodeOwnsSession(this.ownership, change.sessionId),
        }),
      ).finally(() => this.holdCopies(change.sessionId, change.waMessageId)),
    released: (change, reason) => this.releaseParked(change, reason),
  };

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
    @Optional() private readonly lidMappingStore?: LidMappingStoreService,
    @Optional() private readonly ownership?: SessionOwnershipService,
  ) {
    // The queue the delivery service keeps its refused dispatches in, so a pass withdraws or rewrites what a kept change
    // touches before the events it touches go out; one of its own where none is wired (a projector built standalone).
    const shared = this.webhookService.recoveryQueue?.();
    this.recovery =
      shared instanceof RecoveryQueue
        ? shared
        : new RecoveryQueue(
            recoveryQueueOptions(
              this.messageRepository.manager?.connection?.options?.type === 'postgres',
              resolveWebhookReconcilerOptions().graceMs,
            ),
          );
    this.webhookService.setSessionOwnership?.(sessionId => nodeOwnsSession(this.ownership, sessionId));
    this.mutationProjector = new MessageMutationProjector(
      this.messageRepository,
      this.eventsGateway,
      this.webhookService,
      this.messageMutations,
      this.logger,
      (sessionId, waMessageId) => this.noteMarkedEdited(sessionId, waMessageId),
      this.lidMappingStore ? jid => this.lidMappingStore!.findPhoneForLid(jid) : undefined,
      (sessionId, waMessageId) => this.announceChangedRow(sessionId, waMessageId),
      (sessionId, waMessageId, slots, error) => this.parkChange(sessionId, waMessageId, slots, error),
      (sessionId, waMessageId, slots) => this.settleParked(sessionId, waMessageId, slots),
      this.lidMappingStore ? phone => this.lidMappingStore!.findLidsForPhone(phone) : undefined,
      this.lidMappingStore ? () => this.lidMappingStore!.rowVetoes() : undefined,
      (sessionId, waMessageId) => this.rowPending(sessionId, waMessageId),
    );
    // A received row the database refused comes back before anything is tried, and holds the changes of its message;
    // so does a message the engine could not read for a stored message it could not read, to be handed back to it.
    this.recovery.register('receive', {
      encode: record =>
        record instanceof ReceivedRow
          ? journalReceivedRow(record)
          : record instanceof KeptInbound
            ? journalKeptInbound(record)
            : undefined,
      decode: (key, value) => {
        const inbound = restoredKeptInbound(value);
        if (inbound) {
          const { sessionId, messageId, raw, kind, targetId, since } = inbound;
          return new KeptInbound(key, sessionId, messageId, raw, kind, targetId, since, this.inboundSteps);
        }
        const restored = restoredReceivedRow(value);
        return restored
          ? new ReceivedRow(key, restored.sessionId, restored.row, restored.direction, restored.since, this.rowSteps)
          : undefined;
      },
    });
    // What the last process kept of these changes comes back before anything is tried, its deliveries held again.
    this.recovery.register('change', {
      encode: record => journalChange(record as ParkedChange),
      decode: (key, value) => this.restoreChange(key, value),
    });
    this.engines.onRetire((id, engine) => {
      for (const t of this.tickets.get(id) ?? []) if (t.engine === engine) t.drop();
      this.deleteRoomIfIdle(id);
      if (!this.engines.has(id)) this.markedEdited.delete(id);
    });
  }

  /** Whether the row of a message is kept to be written (a send's SENT write, a received row), so a change waits for it. */
  private rowPending(sessionId: string, waMessageId: string): boolean {
    return (
      this.recovery.get('send', sendRerunKey(sessionId, waMessageId)) !== undefined ||
      this.recovery.get('receive', receivedRowKey(sessionId, waMessageId)) !== undefined
    );
  }

  private readonly rowSteps: ReceivedRowSteps = {
    store: row => this.storeReceivedRow(row),
    released: (row, reason) => {
      if (!reason) return;
      this.logger.error(
        'A received message the database refused could not be kept any longer and is not stored',
        undefined,
        {
          sessionId: row.sessionId,
          messageId: row.row.waMessageId as string | undefined,
          reason,
          action: 'message_row_lost',
        },
      );
    },
  };

  private readonly inboundSteps: KeptInboundSteps = {
    redeliver: async kept => {
      // A status is the session's own: stored or removed whatever engine runs, behind an older record of the same story.
      if (kept.kind === 'story' || kept.kind === 'story-removal') {
        return this.keptBefore(kept) ? false : this.applyKeptStory(kept);
      }
      const engine = this.engines.get(kept.sessionId);
      // Kept until the session's engine runs here again (after a restart, or a reconnect), and behind an older change of
      // the same message still kept (one that failed for a reason of its own), so they land in the order they came in.
      if (!engine || !handsBackInbound(engine) || this.keptBefore(kept)) return false;
      if (kept.kind === 'message') return engine.redeliverInbound(kept.raw);
      if (kept.kind === 'wipe') return engine.restoreStoredWipe(kept.raw);
      // A change of a copy comes after the copy and the older changes kept of it (keptBefore), so a delete wins over an
      // edit in either order: an edit finds nothing to set in a blank copy.
      if (kept.kind !== 'copy') return engine.restoreStoredChange(kept.raw);
      // A copy waits for its row and the changes kept of its message, and is written blank when the row says revoked:
      // a revoke that landed while it was kept found no copy to clear, and its mark did not outlive a restart.
      const { sessionId, messageId } = kept;
      if (this.rowPending(sessionId, messageId) || this.recovery.get('change', `${sessionId}:${messageId}`))
        return false;
      const revoked = await this.messageRepository.exists({
        where: { sessionId, waMessageId: messageId, type: 'revoked' },
      });
      return engine.restoreStoredCopy(kept.raw, revoked);
    },
    released: (kept, reason) => {
      if (!reason) return;
      const [message, action] = KEPT_INBOUND_LOSS[kept.kind];
      this.logger.error(message, undefined, {
        sessionId: kept.sessionId,
        messageId: kept.kind === 'message' ? kept.messageId : kept.targetId,
        reason,
        action,
      });
    },
  };

  /**
   * Keep a message the engine could not read because a stored message it needs could not be read (the database
   * failing), to hand it back to the engine once the database answers (see KeptInbound).
   */
  keepUnreadInbound(sessionId: string, kept: { messageId: string; raw: string; targetId?: string }): void {
    const key = keptInboundKey(sessionId, kept.messageId, 'message');
    this.keepInbound(key, sessionId, kept.messageId, kept.raw, 'message', kept.targetId);
  }

  /** Keep the engine's copy of a message the database refused, to write it once it answers (see KeptInbound). */
  keepStoredCopy(sessionId: string, kept: { messageId: string; raw: string }): void {
    const key = keptInboundKey(sessionId, kept.messageId, 'copy');
    this.keepInbound(key, sessionId, kept.messageId, kept.raw, 'copy', kept.messageId);
  }

  /** Keep the clear of what an unlinked account left in the engine's stores, refused by the database (see KeptInbound). */
  keepStoredWipe(sessionId: string, kept: { raw: string }): void {
    this.keepInbound(keptInboundKey(sessionId, '', 'wipe'), sessionId, '', kept.raw, 'wipe', undefined);
  }

  /** Keep an edit or delete of the engine's copy of a message the database refused, to apply it once it answers. */
  keepStoredChange(
    sessionId: string,
    kept: { messageId: string; changeId: string; raw: string; kind: 'blank' | 'text' | 'remove' },
  ): void {
    const { kind } = kept;
    const key = keptInboundKey(sessionId, kept.messageId, kind, kept.changeId);
    this.keepInbound(key, sessionId, kept.changeId, kept.raw, kind, kept.messageId);
  }

  private keepInbound(
    key: string,
    sessionId: string,
    messageId: string,
    raw: string,
    kind: KeptInboundKind,
    targetId: string | undefined,
  ): void {
    this.recovery.park(
      key,
      new KeptInbound(key, sessionId, messageId, raw, kind, targetId, Date.now(), this.inboundSteps),
    );
  }

  /**
   * Drop what is kept to hand back to the engine of an account the session unlinked (see keepUnreadInbound,
   * keepStoredCopy): its store was cleared, and the next account to link the session must get none of it.
   */
  forgetKeptInbound(sessionId: string): void {
    for (const record of [...this.recovery.records('receive')]) {
      // A pending clear of an account unlinked before stays: it is what keeps that account from the next one. So do the
      // session's statuses, which are not the engine's.
      if (record instanceof KeptInbound && record.sessionId === sessionId && FORGOTTEN_AT_UNLINK.has(record.kind)) {
        this.recovery.settle('receive', record.key);
      }
    }
  }

  /** Whether the engine's copy of `messageId` is kept to be written (see keepStoredCopy). */
  isStoredCopyKept(sessionId: string, messageId: string): boolean {
    return this.recovery.get('receive', keptInboundKey(sessionId, messageId, 'copy')) !== undefined;
  }

  /** Whether a message that changes `targetId` is kept to be handed back (see keepUnreadInbound). */
  isChangeKept(sessionId: string, targetId: string): boolean {
    for (const record of this.recovery.records('receive')) {
      if (record instanceof KeptInbound && record.sessionId === sessionId && record.targetId === targetId) return true;
    }
    return false;
  }

  /** Whether a change of the same message as `kept` was kept before it, and is still kept. */
  private keptBefore(kept: KeptInbound): boolean {
    if (!kept.targetId) return false;
    for (const record of this.recovery.records('receive')) {
      if (record === kept) return false;
      if (record instanceof KeptInbound && record.sessionId === kept.sessionId && record.targetId === kept.targetId) {
        return true;
      }
    }
    return false;
  }

  /** Keep a message's row the database refused, to store it once it answers (see ReceivedRow). */
  private keepReceivedRow(sessionId: string, row: Message, direction: 'incoming' | 'outgoing', error: unknown): void {
    const data = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
    const key = receivedRowKey(sessionId, row.waMessageId ?? row.id);
    this.logger.warn('Keeping a received message the database refused, to store it once it answers', {
      sessionId,
      messageId: row.waMessageId,
      error: error instanceof Error ? error.message : String(error),
      action: 'message_row_kept',
    });
    this.recovery.park(key, new ReceivedRow(key, sessionId, data, direction, Date.now(), this.rowSteps));
  }

  /**
   * One more try of a kept received row: inserted under the same dedup oracle as a live insert, so a row another
   * writer stored meanwhile (a re-delivery, a commit that landed before its error) ends it with nothing written, and
   * `message:persisted` runs once for the row that lands. Throws while the database refuses it.
   */
  private async storeReceivedRow(record: ReceivedRow): Promise<boolean> {
    const { sessionId, row, direction } = record;
    const connection = this.messageRepository.manager?.connection;
    const writes = captureSessionWrites(connection ?? this.messageRepository, sessionId);
    let stored: Message;
    try {
      const result = await writes
        .write(() => this.messageRepository.insert(row as QueryDeepPartialEntity<Message>))
        .finally(() => writes.close());
      stored = Object.assign(
        this.messageRepository.create(row as Partial<Message>),
        result.identifiers[0] ?? {},
        result.generatedMaps?.[0] ?? {},
      );
    } catch (error) {
      if (isUniqueViolation(error)) return true;
      throw error;
    }
    void this.hookManager
      .execute(
        'message:persisted',
        { sessionId, message: persistedRow(stored) },
        { sessionId, source: 'SessionService' },
      )
      .catch(() => undefined);
    if (direction === 'incoming' || this.configService?.get<boolean>('chatMedia.archiveOutbound', false) === true) {
      void this.chatMediaArchive?.archive(stored).catch(() => undefined);
    }
    return true;
  }

  /** Drop per-session in-memory state held by collaborators when a session row is removed. */
  forgetSession(sessionId: string): void {
    this.automationRules?.forgetSession(sessionId);
    this.recovery.forget(sessionId);
  }

  /**
   * At shutdown, once the engines are gone: one bounded pass over the changes the database refused, then the loss of
   * what is left is logged (`message_change_lost`), as nothing outlives the process.
   */
  settleParkedChanges(budgetMs = PARKED_CHANGES_SHUTDOWN_PASS_MS): Promise<void> {
    // The kept webhook dispatches get their own pass, in the delivery service's shutdown drain.
    return this.recovery.drain(budgetMs, ['send', 'receive', 'change']);
  }

  /** The queue this process keeps what the database refused in, shared with the send path's SENT writes. */
  recoveryQueue(): RecoveryQueue {
    return this.recovery;
  }

  /** Run the kept changes now: a test's clock, and the shutdown pass, do not wait for the timer. */
  retryParkedChanges(): Promise<void> {
    return this.recovery.flush();
  }

  /**
   * Keep changes of a message the database refused (see ParkedChange), merged into what is kept for it already, kind by
   * kind: with a kept one whose claim agrees (a newer edit or reaction of a sender replaces it, a revoke stays once kept,
   * though an engine revoke replaces a delete through the API, as it withdraws more), else beside the others, in a record
   * of its own if need be. Each is judged against the row when it is tried, so a change of another chat or sender
   * neither applies nor cancels a kept one. Past {@link PARKED_VARIANTS_MAX} of a kind, the oldest is lost.
   */
  private async parkChange(
    sessionId: string,
    waMessageId: string,
    slots: ChangeSlots,
    error: unknown,
    engine = this.engines.get(sessionId),
  ): Promise<void> {
    if (!waMessageId || !slotNames(slots).length) return;
    const key = `${sessionId}:${waMessageId}`;
    const parking = this.parking.get(key) ?? [];
    this.parking.set(key, parking);
    parking.push(slots);
    this.holdCopies(sessionId, waMessageId);
    try {
      await this.keepChange(sessionId, waMessageId, slots, error, engine);
    } finally {
      parking.splice(parking.indexOf(slots), 1);
      if (!parking.length) this.parking.delete(key);
      this.holdCopies(sessionId, waMessageId);
    }
  }

  /** Keep a change in the records of its message (see parkChange), which holds the message's deliveries meanwhile. */
  private async keepChange(
    sessionId: string,
    waMessageId: string,
    slots: ChangeSlots,
    error: unknown,
    engine: IWhatsAppEngine | undefined,
  ): Promise<void> {
    const key = `${sessionId}:${waMessageId}`;
    const records = this.parkedFor.get(key) ?? [];
    this.parkedFor.set(key, records);
    const touched = new Set<ParkedChange>();
    // A revoke never shares a record with content: the bounds may then give up the content, never the revoke.
    const content = (record: ParkedChange): boolean =>
      Boolean(record.slots.edit || record.slots.reactions?.size || record.slots.acks);
    /**
     * The record a change of a kind goes to: one whose kept change agrees with it, else one without that kind that a
     * revoke and content do not then share.
     */
    const recordFor = async (
      keptOf: (record: ParkedChange) => MutationSource | false | undefined,
      by: MutationSource | undefined,
      kind: string,
    ): Promise<{ record: ParkedChange; agrees: boolean }> => {
      for (const record of records) {
        const kept = keptOf(record);
        if (kept !== false && (await this.claimsAgree(kept, by))) return { record, agrees: true };
      }
      this.boundVariants(records, keptOf, kind);
      const free = records.find(
        record => keptOf(record) === false && (kind === 'revoke' ? !content(record) : !record.slots.revoke),
      );
      if (free) return { record: free, agrees: false };
      const record = new ParkedChange(
        sessionId,
        waMessageId,
        engine,
        Date.now(),
        this.parkSteps,
        `${key}#${++this.parkSeq}`,
      );
      records.push(record);
      return { record, agrees: false };
    };
    if (slots.revoke) {
      const by = slots.revoke.judge ?? slots.revoke.source;
      // What it supersedes goes now, as for a revoke that lands: an edit or a reaction whose claim agrees with it.
      await this.supersedeKept(records, { revoke: slots.revoke });
      const { record, agrees } = await recordFor(
        r => (r.slots.revoke ? (r.slots.revoke.judge ?? r.slots.revoke.source) : false),
        by,
        'revoke',
      );
      const kept = record.slots.revoke;
      if (!agrees || !kept || (slots.revoke.announced && !kept.announced)) record.slots.revoke = slots.revoke;
      touched.add(record);
    }
    // A revoke kept whose claim agrees with an edit or a reaction wins over it: such a change is not kept beside it.
    const revoked = async (by: MutationSource | undefined): Promise<boolean> => {
      for (const { slots: kept } of records) {
        if (kept.revoke && (await this.claimsAgree(kept.revoke.judge ?? kept.revoke.source, by))) return true;
      }
      return false;
    };
    if (slots.edit && !(await revoked(slots.edit.judge))) {
      const { record } = await recordFor(r => Boolean(r.slots.edit) && r.slots.edit!.judge, slots.edit.judge, 'edit');
      record.slots.edit = slots.edit;
      touched.add(record);
    }
    for (const [sender, reaction] of slots.reactions ?? []) {
      if (await revoked(reaction.judge)) continue;
      const { record } = await recordFor(
        r => r.slots.reactions?.has(sender) === true && r.slots.reactions.get(sender)!.judge,
        reaction.judge,
        'reactions',
      );
      (record.slots.reactions ??= new Map()).set(sender, reaction);
      touched.add(record);
    }
    if (slots.acks) {
      const { record } = await recordFor(r => Boolean(r.slots.acks) && r.slots.acks!.judge, slots.acks.judge, 'acks');
      const acks = (record.slots.acks ??= { ...slots.acks, acks: new Map<string, MessageStatus>() }).acks;
      for (const [chat, status] of slots.acks.acks) {
        const parked = acks.get(chat);
        if (!parked || ackStatusTransitionFrom(status).includes(parked)) acks.set(chat, status);
      }
      touched.add(record);
    }
    this.logger.warn('Keeping changes the database refused, to write them once it answers', {
      sessionId,
      messageId: waMessageId,
      slots: slotNames(slots),
      error: error instanceof Error ? error.message : String(error),
      action: 'message_change_parked',
    });
    for (const record of touched) {
      if (engine) record.engine = engine;
      record.measure();
    }
    // A record let go while the claims were judged may have taken the list out of the map.
    if (records.length) this.parkedFor.set(key, records);
    for (const record of touched) this.recovery.park(record.key, record);
  }

  /** A change the journal kept across a restart, back among the message's records and holding its deliveries. */
  private restoreChange(key: string, value: unknown): ParkedChange | undefined {
    const restored = restoredChange(value);
    if (!restored) return undefined;
    const { sessionId, waMessageId, since, slots } = restored;
    const record = new ParkedChange(sessionId, waMessageId, undefined, since, this.parkSteps, key);
    Object.assign(record.slots, slots);
    record.restored = true;
    record.measure();
    const message = `${sessionId}:${waMessageId}`;
    this.parkedFor.set(message, [...(this.parkedFor.get(message) ?? []), record]);
    const seq = Number(key.slice(key.lastIndexOf('#') + 1));
    if (Number.isInteger(seq)) this.parkSeq = Math.max(this.parkSeq, seq);
    this.holdCopies(sessionId, waMessageId);
    return record;
  }

  /** Whether a change claimed by `by` agrees with one kept under `kept`: no claim, or one the rule does not prove foreign. */
  private async claimsAgree(kept: MutationSource | undefined, by: MutationSource | undefined): Promise<boolean> {
    if (!kept || !by) return true;
    const resolveLid = this.lidMappingStore ? (jid: string) => this.lidMappingStore!.findPhoneForLid(jid) : undefined;
    return (await mutationTargetsForeignRowPersisted(refOfSource(kept), by, resolveLid)) === null;
  }

  /** Make room for one more change of a kind whose claim agrees with none kept: the oldest past the bound is lost. */
  private boundVariants(
    records: ParkedChange[],
    keptOf: (record: ParkedChange) => MutationSource | false | undefined,
    kind: string,
  ): void {
    const holding = records.filter(record => keptOf(record) !== false);
    for (const record of holding.slice(0, Math.max(0, holding.length - PARKED_VARIANTS_MAX + 1))) {
      this.logger.error(
        'Too many changes of one message whose claims disagree are kept; the oldest is lost',
        undefined,
        {
          sessionId: record.sessionId,
          messageId: record.waMessageId,
          slots: [kind],
          reason: 'conflict',
          action: 'message_change_lost',
        },
      );
      if (kind === 'revoke') delete record.slots.revoke;
      else if (kind === 'edit') delete record.slots.edit;
      else if (kind === 'acks') delete record.slots.acks;
      else record.slots.reactions?.clear();
      if (record.empty()) this.recovery.settle('change', record.key);
      else {
        record.measure();
        this.recovery.remeasure('change', record.key);
      }
    }
  }

  /**
   * A change of the message landed: what is kept for it that the change supersedes is let go. An edit supersedes a kept
   * edit, a reaction the same sender's, and a revoke the kept edit and reactions, each only where the kept one's claim
   * agrees with it, so a change of another chat neither applies nor cancels a kept one. A kept revoke stays.
   */
  private async settleParked(sessionId: string, waMessageId: string, landed: ChangeSlots): Promise<void> {
    const records = this.parkedFor.get(`${sessionId}:${waMessageId}`);
    if (!records?.length) return;
    await this.supersedeKept(records, landed);
    this.holdCopies(sessionId, waMessageId);
  }

  /** Let go of what `landed` supersedes in `records` (see settleParked); a record left empty leaves the queue. */
  private async supersedeKept(records: ParkedChange[], landed: ChangeSlots): Promise<void> {
    const by = landed.revoke?.judge ?? landed.revoke?.source ?? landed.edit?.judge;
    for (const record of [...records]) {
      const kept = record.slots;
      if ((landed.edit || landed.revoke) && kept.edit && (await this.claimsAgree(kept.edit.judge, by)))
        delete kept.edit;
      for (const [sender, reaction] of kept.reactions ?? []) {
        const landedReaction = landed.reactions?.get(sender);
        if (
          (landedReaction || landed.revoke) &&
          (await this.claimsAgree(reaction.judge, landedReaction?.judge ?? by))
        ) {
          kept.reactions!.delete(sender);
        }
      }
      if (record.empty()) this.recovery.settle('change', record.key);
      else {
        record.measure();
        this.recovery.remeasure('change', record.key);
      }
    }
  }

  /**
   * Hold the message's deliveries on this node while any of its kept records may still withdraw or rewrite their copies
   * (a revoke, an edit with its text); a reaction or a receipt leaves them as they are.
   */
  private holdCopies(sessionId: string, waMessageId: string): void {
    const key = `${sessionId}:${waMessageId}`;
    // A change still being parked holds them too: a record it supersedes may leave before its own is listed.
    const kept = [...(this.parkedFor.get(key) ?? []).map(({ slots }) => slots), ...(this.parking.get(key) ?? [])];
    // A kept revoke holds the message's edit events too, which it withdraws as well.
    const held = kept.some(slots => slots.revoke)
      ? 'revoke'
      : kept.some(slots => slots.edit?.body !== undefined)
        ? 'copies'
        : false;
    this.webhookService.holdMessage?.(sessionId, waMessageId, held);
  }

  /** A kept change left the queue: its deliveries are let go unless another record holds them, and a loss is logged. */
  private releaseParked(change: ParkedChange, reason?: RecoveryLoss): void {
    const key = `${change.sessionId}:${change.waMessageId}`;
    const records = this.parkedFor.get(key) ?? [];
    if (records.includes(change)) records.splice(records.indexOf(change), 1);
    if (!records.length) this.parkedFor.delete(key);
    this.holdCopies(change.sessionId, change.waMessageId);
    if (!reason) return;
    this.logger.error('A change the database refused could not be kept any longer and is lost', undefined, {
      sessionId: change.sessionId,
      messageId: change.waMessageId,
      slots: slotNames(change.slots),
      reason,
      action: 'message_change_lost',
    });
  }

  /** Run `work` on the message's mutation chain, after what is queued there, and hand back its outcome or error. */
  private onChain<T>(sessionId: string, waMessageId: string, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      this.enqueueMessageMutation(sessionId, waMessageId, () => work().then(resolve, reject)),
    );
  }

  /**
   * The outbox steps of a kept change, before any kept change writes a row: the delivery copies of a revoked message
   * are withdrawn and those of an edited one rewritten, judged by their payloads alone (no row is read). The row step
   * repeats them with what the row says (the chat a handler filed a moved message under).
   */
  private async parkedOutboxSteps(change: ParkedChange): Promise<void> {
    const { sessionId, waMessageId, slots } = change;
    if (slots.revoke && !slots.revoke.outboxSettled) {
      await this.revokeCopies(sessionId, waMessageId, slots.revoke);
      slots.revoke.outboxSettled = true;
    } else if (slots.edit?.body !== undefined && slots.edit.judge && !slots.edit.outboxSettled) {
      await this.webhookService.changeMessageCopies?.(
        sessionId,
        waMessageId,
        { kind: 'rewrite', body: slots.edit.body },
        this.outboxPredicateFor(slots.edit.judge),
      );
      slots.edit.outboxSettled = true;
    }
  }

  /** Withdraw the delivery copies of a revoked message: an engine revoke closes them, a delete through the API redacts. */
  private async revokeCopies(
    sessionId: string,
    waMessageId: string,
    slot: RevokeSlot,
    verdict?: StoredRowVerdict,
  ): Promise<void> {
    const filed = verdict?.moved && verdict.row ? revokeSourceFor(verdict.row) : undefined;
    const ours = Boolean(verdict?.exists && !verdict.reason);
    const predicate = slot.source ? this.outboxPredicateFor(slot.source, ours, filed) : undefined;
    await this.webhookService.changeMessageCopies?.(
      sessionId,
      waMessageId,
      { kind: slot.announced ? 'close' : 'redact' },
      predicate,
    );
  }

  /**
   * Write kept or held changes to the row they are judged against, dropping each slot that settles: the revoke first,
   * then the edit, the reactions and the receipts. Throws when the database fails or the row cannot be read, with the
   * slots not yet settled left in `slots`. `announce` says the engine that took the changes is still live; `owned`
   * that this node still owns the session: an edit or a reaction kept past a takeover is dropped (the new owner may
   * have a newer one, and the row has no version to order them), a revoke and receipts always apply. Must run on the
   * message's chain.
   */
  private async runSlots(
    sessionId: string,
    waMessageId: string,
    slots: ChangeSlots,
    opts: { announce: boolean; owned: boolean },
  ): Promise<void> {
    if (slots.revoke) {
      await this.applyRevoke(sessionId, waMessageId, slots.revoke, opts.announce);
      delete slots.revoke;
    }
    if (!opts.owned && (slots.edit || slots.reactions?.size)) {
      this.logger.error('A kept change of a session this node no longer owns is dropped', undefined, {
        sessionId,
        messageId: waMessageId,
        slots: slotNames({ edit: slots.edit, reactions: slots.reactions }),
        reason: 'ownership',
        action: 'message_change_lost',
      });
      delete slots.edit;
      delete slots.reactions;
    }
    if (slots.edit) {
      await this.mutationProjector.writeEdit(sessionId, waMessageId, slots.edit, opts.announce);
      delete slots.edit;
    }
    // One write for the reactions judged alike (those held for a message in flight are), one per judgement else.
    while (slots.reactions?.size) {
      const [, first] = slots.reactions.entries().next().value!;
      const alike = [...slots.reactions].filter(
        ([, r]) => r.judge.chatId === first.judge.chatId && r.own?.rowId === first.own?.rowId,
      );
      const changes = Object.fromEntries(alike.map(([sender, r]) => [sender, r.value]));
      await this.storeReactions(sessionId, waMessageId, changes, first.judge, first.own);
      for (const [sender] of alike) slots.reactions.delete(sender);
    }
    if (slots.reactions && !slots.reactions.size) delete slots.reactions;
    if (slots.acks) {
      await this.advanceKeptAcks(sessionId, waMessageId, slots.acks);
      delete slots.acks;
    }
  }

  /** {@link runSlots} for changes not kept yet: what the database refuses is kept to try again. */
  private async runOrPark(
    sessionId: string,
    waMessageId: string,
    slots: ChangeSlots,
    announce: boolean,
    engine?: IWhatsAppEngine,
  ): Promise<void> {
    try {
      await this.runSlots(sessionId, waMessageId, slots, { announce, owned: true });
    } catch (err) {
      await this.parkChange(sessionId, waMessageId, slots, err, engine);
    }
  }

  /** Stamp the session's last-active time, at most once per {@link LAST_ACTIVE_WRITE_WINDOW_MS} for this engine. */
  private touchLastActive(id: string, engine: IWhatsAppEngine): void {
    const now = Date.now();
    const stamped = this.lastActiveStamped.get(engine);
    // A clock set back re-arms the stamp instead of silencing it until the old time comes round again.
    if (stamped !== undefined && now >= stamped && now - stamped < LAST_ACTIVE_WRITE_WINDOW_MS) return;
    this.lastActiveStamped.set(engine, now);
    // A write that fails leaves the next message to try again, not the rest of the window without a stamp.
    // Fence on nodeId when cluster ownership is active so a lapsed-lease replica never updates a peer's row.
    const nodeId = this.ownership?.nodeId;
    void this.sessionRepository.update(nodeId ? { id, nodeId } : id, { lastActiveAt: new Date(now) }).catch(() => {
      if (this.lastActiveStamped.get(engine) === now) this.lastActiveStamped.delete(engine);
    });
  }

  private noteMarkedEdited(sessionId: string, waMessageId: string): void {
    let marks = this.markedEdited.get(sessionId);
    if (!marks) this.markedEdited.set(sessionId, (marks = new Set()));
    marks.add(waMessageId);
    if (marks.size > EDITED_MARKS_KEPT_PER_SESSION) marks.delete(marks.values().next().value!);
  }

  /**
   * Whether the engines hold each inbound message from its arrival until its row is written. Only
   * PostgreSQL needs it: a downloaded payload waits in memory for its asynchronous insert, while
   * better-sqlite3 writes synchronously, so the backlog drains within the arrival's own task.
   */
  get holdsInbound(): boolean {
    return this.messageRepository.manager?.connection?.options?.type === 'postgres';
  }

  /**
   * Admit a message as it arrives (see EngineEventCallbacks.admitInbound), synchronously, in arrival
   * order. The engine passes the ticket to its emit or drops it. Each admitted message of a chat
   * starts its hook chain and is committed in this order, and changes that target it before its emit
   * are recorded on its in-flight entry. One that downloads media asks the session's room for a slot
   * now, granted in arrival order and held until its row is written.
   */
  admitInbound(
    id: string,
    engine: IWhatsAppEngine,
    a: { id: string; chatId: string; needsRoom: boolean; status: boolean; fromMe?: boolean; author?: string },
  ): InboundTicket | undefined {
    if (!this.engines.isLive(id, engine)) return undefined;
    const key = a.status || !a.id ? null : `${id}:${a.id}`;
    let entry: InFlightEntry = {};
    if (key) {
      entry = this.inboundInFlight.get(key) ?? entry;
      this.inboundInFlight.set(key, entry);
      // From the arrival, so a change that reaches the message while it downloads media is held to the rule
      // of the row it will become. Only when the engine says whose message it is: a guessed direction
      // would refuse the account's own change.
      if (a.fromMe !== undefined) entry.ref ??= refOf({ chatId: a.chatId, fromMe: a.fromMe, author: a.author });
    }
    entry.holders = (entry.holders ?? 0) + 1;
    const room = a.needsRoom ? this.room(id) : undefined;
    const source: MutationSource = { kind: 'edit', chatId: a.chatId, fromMe: a.fromMe, author: a.author };
    const separate = entry.ref && mutationTargetsForeignRow(entry.ref, source) !== null;
    const scoped: InFlightEntry = separate
      ? { ref: a.fromMe === undefined ? undefined : refOf({ chatId: a.chatId, fromMe: a.fromMe, author: a.author }) }
      : entry;
    const t = new InboundTurn(engine, scoped, room, room && roomState());
    let set = this.tickets.get(id);
    if (!set) this.tickets.set(id, (set = new Set()));
    set.add(t);
    const finish = (): void => {
      if (entry.holders) entry.holders--;
      if (key && !entry.holders && this.inboundInFlight.get(key) === entry) this.inboundInFlight.delete(key);
      set.delete(t);
      if (!set.size && this.tickets.get(id) === set) this.tickets.delete(id);
      t.s?.done.resolve();
    };
    if (a.status) {
      void t.outcome.promise.then(finish);
    } else {
      const chatKey = `${id}:${a.chatId}`;
      this.chatEmits.enqueue(chatKey, () => {
        t.hookGate.resolve();
        return t.emitted.promise;
      });
      this.chatCommits.enqueue(chatKey, async () => {
        try {
          const job = await t.outcome.promise;
          if (job) await job();
        } finally {
          finish();
        }
      });
    }
    if (room && t.s) {
      void room.request(t.s).then(() => {
        if (!this.engines.has(id)) this.deleteRoomIfIdle(id);
      });
    }
    if (key && separate && this.lidMappingStore) {
      const pending = this.changeInFlight(id, a.id, source, (needsRow, shared) => {
        if (!this.engines.isLive(id, engine) || t.state === 'dropped') return;
        if (shared && !needsRow) {
          t.entry = shared;
          if (shared.revoked) t.giveUp();
        }
      });
      // A revoke queued during the directory read must reach the ticket before its download starts.
      if (pending) t.prepareIdentity(pending.then(() => this.waitForInFlightChanges(id, a.id)));
    }
    return t;
  }

  private room(id: string): InboundRoom {
    let room = this.rooms.get(id);
    if (!room) this.rooms.set(id, (room = new InboundRoom()));
    return room;
  }

  private deleteRoomIfIdle(id: string): void {
    if (this.rooms.get(id)?.idle) this.rooms.delete(id);
  }

  /**
   * Engine callback body, lifted out of initializeEngine so the wiring table stays readable. With a
   * ticket (PostgreSQL), the hook chain starts in the chat's arrival order and the commit takes the
   * turn admitInbound reserved; whatever path returns early drops the ticket. The receipt, for an
   * engine that wants to know what became of its message, settles once the commit ends (see
   * {@link InboundOutcome}). There is none when the engine is no longer live or the message is skipped as
   * ephemeral; one that settles with nothing says nothing, as when the hook chain failed.
   */
  handleInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    message: IncomingMessage,
    ticket?: InboundTicket,
  ): InboundReceipt | undefined {
    const turn = ticket instanceof InboundTurn ? ticket : undefined;
    try {
      return this.receiveInbound(id, engine, message, turn);
    } finally {
      turn?.drop();
    }
  }

  private receiveInbound(
    id: string,
    engine: IWhatsAppEngine,
    message: IncomingMessage,
    turn?: InboundTurn,
  ): InboundReceipt | undefined {
    if (!this.engines.isLive(id, engine)) return;
    if (message.isStatusBroadcast) {
      const ingest = this.ingestInboundStatus(id, engine, message);
      // The status store holds the payload until the ingest settles.
      turn?.holdUntil(ingest);
      // Its own table takes the status whatever the id, and a story is never a row of `messages`: one
      // that finds a message there under its id reuses that id. Only an engine that keeps its own copy of
      // a message reads the outcome, so the lookup is made when it is asked for, and once.
      let judged: Promise<InboundOutcome | undefined> | undefined;
      const judge = (): Promise<InboundOutcome | undefined> => ingest.then(() => this.judgeRepeat(id, message));
      return {
        get settled(): Promise<InboundOutcome | undefined> {
          return (judged ??= judge());
        },
      };
    }
    if (this.shouldSkipEphemeralMessage(id, message)) return;
    this.logger.debug(`Message received from ${message.from}`, {
      sessionId: id,
      messageId: message.id,
      from: message.from,
      action: 'message_received',
    });
    this.touchLastActive(id, engine);
    // Convert IncomingMessage to plain object for dispatch. One delivered deleted reaches the hooks with no content,
    // whatever text the engine handed over with it.
    const messageData = message.type === 'revoked' ? deletedPlaceholder(message) : { ...message };
    // What an engine says of the edit it applied is for the session alone: no hook, row or consumer sees it.
    delete messageData.originalBody;
    const engineIdentity = engineIdentityOf(message);
    // Tracks what the chain's current copy lends a quote, so one taken mid-chain carries an earlier
    // handler's rewrite.
    const inFlightKey = `${id}:${message.id}`;
    const inFlight = turn
      ? Object.assign(turn.entry, { ref: turn.entry.ref ?? refOf(messageData) })
      : this.trackInFlight(inFlightKey, messageData);
    const delivery = {
      entry: inFlight,
      body: message.originalBody ?? message.body,
      edited: message.originalBody !== undefined,
    };
    const quoteOwner = {};

    const onFailure = (err: unknown): null => {
      this.logger.error(`onMessage handler failed for ${id}`, String(err));
      return null;
    };
    // Execute hook for message received - plugins can modify or stop processing. The hook chain and
    // sender resolution run concurrently across messages; the catch is attached now so a failure
    // while the commit waits its turn is never an unhandled rejection.
    const prepared = this.startHookChain(id, engine, turn, messageData, delivery, quoteOwner, messageData => {
      const identity = identityOf(messageData);
      // The message the chain last held: the one it was handed, then each rewrite it accepted.
      let held = messageData;
      return this.hookManager
        .execute('message:received', messageData, {
          sessionId: id,
          source: 'Engine',
          accept: data => {
            if (!isMessagePayload(data)) return false;
            held = data;
            if (delivery.entry.quoteOwner === quoteOwner) delivery.entry.quote = quoteOf(data);
            return true;
          },
        })
        .then(({ data }) =>
          this.prepareInboundMessage(id, this.messageOrLastHeld(id, 'message:received', data, held, identity)),
        );
    }).catch(onFailure);
    const outcome = deferred<InboundOutcome | undefined>();
    this.commitInTurn(id, message, turn, async () => {
      try {
        const finalMessage = await prepared;
        if (finalMessage) {
          outcome.resolve(await this.commitInboundMessage(id, engine, finalMessage, delivery.entry, engineIdentity));
        }
      } catch (err) {
        onFailure(err);
      } finally {
        outcome.resolve(undefined); // no effect once settled above
        this.clearQuote(delivery.entry, quoteOwner);
        if (!turn) this.untrackInFlight(inFlightKey, inFlight);
      }
    });
    return { settled: outcome.promise };
  }

  /**
   * Start a message's hook chain: at once without a turn. With one, once every earlier admitted
   * message of the chat was emitted or dropped, so hooks start in arrival order. A message revoked
   * before then skips its hooks, as its content is gone, and an edit made before then reaches them.
   * A delivery of content checks for a stored tombstone before either hook; one that came deleted
   * reaches them cleared. An unavailable database keeps the delivery, as the storage path does.
   */
  private startHookChain(
    id: string,
    engine: IWhatsAppEngine,
    turn: InboundTurn | undefined,
    messageData: InboundMessageData,
    delivery: InFlightDelivery,
    quoteOwner: object,
    run: (message: InboundMessageData) => Promise<InboundMessageData>,
  ): Promise<InboundMessageData | null> {
    const checked = async (): Promise<InboundMessageData | null> => {
      let data = messageData;
      if (data.id && data.type !== 'revoked') {
        try {
          const connection = this.messageRepository.manager?.connection;
          if (connection && !(await awaitNoOpenTransaction(connection))) {
            throw new Error('Timed out waiting for the message database transaction');
          }
          // The unique message key bounds this read. A tombstone outlives this projector and any engine copy.
          const row = await this.messageRepository.findOne({
            where: { sessionId: id, waMessageId: data.id, type: 'revoked' },
            select: { type: true, chatId: true, direction: true, author: true, engineRef: true, from: true, to: true },
          });
          if (
            row?.type === 'revoked' &&
            !(
              await judgeStoredRow(
                row,
                data.id,
                claimOf(data),
                this.lidMappingStore ? jid => this.lidMappingStore!.findPhoneForLid(jid) : undefined,
              )
            ).reason
          ) {
            data = deletedPlaceholder(data);
          }
        } catch (error) {
          // Preserve the receive path's fail-open behavior when storage is unavailable.
          this.logger.warn('Failed to read the stored message before its hooks; keeping the delivery', {
            sessionId: id,
            messageId: data.id,
            error: String(error),
          });
        }
      }
      if (!this.engines.isLive(id, engine)) return null;
      let result: Promise<InboundMessageData> | null = null;
      const preparing = this.changeInFlight(id, data.id, claimOf(data), (needsRow, pending) => {
        if (!this.engines.isLive(id, engine)) return;
        // A reused id from another identity keeps its own scalar changes, never the first delivery's.
        delivery.entry = pending && !needsRow ? pending : { ref: refOf(data) };
        this.arrive(delivery.entry, delivery);
        const skipHooks = turn && delivery.entry.revoked && messageData.type !== 'revoked';
        if (data.type === 'revoked') this.holdRevoked(id, delivery.entry);
        if (pending && !needsRow) {
          if (pending.revoked) data = deletedPlaceholder(data);
          else if (pending.editedBody !== undefined) data.body = pending.editedBody;
          if (skipHooks) {
            result = Promise.resolve(data);
            return;
          }
          pending.quote = quoteOf(data);
          pending.quoteOwner = quoteOwner;
        }
        // Start the hook in this preparation turn, but never make preparation wait for the hook.
        result = run(data);
      });
      if (preparing) await preparing;
      return result;
    };
    if (!turn) return checked();
    return turn.hookGate.promise.then(async () => {
      await this.waitForInFlightChanges(id, messageData.id);
      if (!this.engines.isLive(id, engine)) return null;
      return checked();
    });
  }

  /** Queue a message's commit on its chat, or hand it to the turn admitInbound already queued. */
  private commitInTurn(
    id: string,
    message: IncomingMessage,
    turn: InboundTurn | undefined,
    job: () => Promise<void>,
  ): void {
    if (turn) turn.emit(job);
    else this.chatCommits.enqueue(this.chatCommitKey(id, message), job);
  }

  /** Record a message as not yet written; a re-fire of the same id keeps the changes recorded so far. */
  private trackInFlight(key: string, message: InboundMessageData): InFlightEntry {
    // A message whose id the engine could not read is registered under no key: the empty id would be shared by
    // every such message, and a revoke or ack that names no message would reach all of them.
    if (!message.id) return { ref: refOf(message) };
    const inFlight = this.inboundInFlight.get(key) ?? {
      // The first delivery of an id says whose message it is: a repeat sent from another chat must not
      // take that over from it, or a change aimed through the repeat would be judged by the wrong rule.
      ref: refOf(message),
    };
    // Repeats can commit through different chat spellings, so none may forget the others' changes.
    // A new entry lends no unchecked quote; a repeat keeps only the previous checked quote.
    inFlight.holders = (inFlight.holders ?? 0) + 1;
    this.inboundInFlight.set(key, inFlight);
    return inFlight;
  }

  /**
   * The engine handed the message over: an edit held until now is compared with the text it arrived with. One the
   * engine applied itself changed that text, though a later one may have restored it (it names the arrival text only
   * then, so it can equal the body), and marks the row the same way.
   */
  private arrive(entry: InFlightEntry, arrival: Pick<InFlightDelivery, 'body' | 'edited'>): void {
    entry.body = arrival.body;
    if (arrival.edited || (entry.editedBody !== undefined && entry.editedBody !== entry.body)) {
      entry.edited = true;
    }
  }

  /** Keep an edit for the row of a message not written yet. One that repeats the text so far changes nothing. */
  private holdEdit(entry: InFlightEntry, body: string): void {
    const soFar = entry.editedBody ?? entry.body;
    if (soFar !== undefined && body !== soFar) entry.edited = true;
    entry.editedBody = body;
  }

  /** Drop the entry once every delivery sharing it has committed. */
  private untrackInFlight(key: string, inFlight: InFlightEntry): void {
    if (inFlight.holders) inFlight.holders--;
    if (!inFlight.holders && this.inboundInFlight.get(key) === inFlight) this.inboundInFlight.delete(key);
  }

  private clearQuote(entry: InFlightEntry, owner: object): void {
    if (entry.quoteOwner !== owner) return;
    delete entry.quote;
    delete entry.quoteOwner;
  }

  /**
   * Key of the per-chat commit queue. A slow hook chain for one message must not let a later message
   * of the same chat be stored and announced first, so the insert and dispatch of every message in a
   * chat (inbound and own-send echo alike) run in arrival order. Keyed on the engine's chatId, not
   * on a hook's rewrite.
   */
  private chatCommitKey(id: string, message: IncomingMessage): string {
    return `${id}:${message.chatId}`;
  }

  /**
   * The inbound message a `message:received` chain is carrying, as the chain last rewrote it, from the
   * moment the chain starts until the message's row is written; undefined otherwise. The row does not
   * exist while the chain runs, so a handler that replies to the message finds nothing to quote in the
   * table.
   */
  inFlightInbound(sessionId: string, waMessageId: string): Pick<IncomingMessage, 'chatId' | 'body'> | undefined {
    const entry = waMessageId ? this.inboundInFlight.get(`${sessionId}:${waMessageId}`) : undefined;
    // Admitted but not emitted yet: nobody can have heard of it, so it has nothing to lend.
    if (!entry?.quote) return undefined;
    // A revoked message lends no text, as its cleared row would not; the chatId still scopes the quote.
    return entry.revoked ? { chatId: entry.quote.chatId, body: '' } : entry.quote;
  }

  /**
   * The message a `message:received` / `message:sent` hook chain handed back, or a copy of `held`, the
   * message the chain last held, when it is not one: null, a primitive, or an object without the string
   * `id` and `chatId` every row and dispatch keys on. HookManager already skips such a result per handler
   * ({@link isMessagePayload}), keeping an earlier handler's rewrite; this is the last guard, for a
   * handler that damaged the object it was handed. A plugin returning `data: null` to mean "I consumed
   * it" used to throw below and erase the message from history, webhooks and the websocket. A plugin may
   * rewrite a message; it cannot make the gateway forget it (see {@link prepareInboundMessage}).
   *
   * `held` is the message the chain was handed or the last rewrite it accepted, as the chain left it,
   * never the engine's message as it arrived: text or media an earlier handler took out stays out
   * whatever a later one does to the object.
   *
   * Either way, one of {@link FIELDS_KEPT_FROM_ENGINE} the chain left without a value of its type (a
   * redaction returning the id, the chat and a new text, or a handler clearing it on the object it was
   * handed, or putting an object where a string belongs) takes the one in `identity`, read before the
   * chain ran. A value of its type the chain did set stays as it is, false, zero and the empty string
   * included, and content it dropped is not put back.
   */
  private messageOrLastHeld(
    id: string,
    event: 'message:received' | 'message:sent',
    data: unknown,
    held: IncomingMessage,
    identity: Partial<IncomingMessage>,
  ): InboundMessageData {
    let result = data as Partial<IncomingMessage>;
    if (!isMessagePayload(result)) {
      this.logger.warn(`A ${event} hook left a payload that is not a message; keeping the last one the chain held`, {
        sessionId: id,
        messageId: identity.id,
        received: data === null ? 'null' : typeof data,
        action: 'hook_message_discarded',
      });
      result = { ...held };
      delete result.originalBody;
    }
    // What the engine said of the chat holds for that chat alone: a message the chain moved to another one is
    // classified by the chat it ends up in, as the engine's mapper classifies the chat of a message.
    const chatId = typeof result.chatId === 'string' ? result.chatId : identity.chatId;
    const moved = chatId !== undefined && chatId !== identity.chatId;
    const engine = moved ? { ...identity, kind: chatKind(chatId), isGroup: chatKind(chatId) === 'group' } : identity;
    // Only those are touched, so a message that carries them all is passed on as it came, key order included.
    const kept: Record<string, unknown> = { ...result };
    for (const field of KEPT_FIELDS) {
      const value = result[field];
      if (typeof value === FIELDS_KEPT_FROM_ENGINE[field]) continue;
      // Missing, null or of another type: the engine's value, and where it has none, nothing of another type.
      if (engine[field] != null) kept[field] = engine[field];
      else if (value != null) delete kept[field];
    }
    return kept as InboundMessageData;
  }

  /** `isStatusBroadcast` arm of {@link handleInboundMessage}: ingest into the status store, not the message pipeline. */
  private ingestInboundStatus(id: string, engine: IWhatsAppEngine, message: IncomingMessage): Promise<void> {
    // Status/Story posts arrive via the inbound path for some engines; ingest them into the
    // status store instead of the message pipeline. Mirrors the isStatusBroadcast guard in
    // onMessageCreate below: an own-send echo (fromMe) stays a plain drop — never ingested,
    // never dispatched — so a status you posted never re-appears in your own webhooks/API as
    // if a contact had posted it.
    if (message.fromMe) return Promise.resolve();
    const status = buildIncomingStatus(message);
    if (!status) return Promise.resolve();
    return (
      this.statusStore
        .ingest(id, status)
        // Dispatch only on a fresh insert: ingest also resolves with the pre-existing row
        // for a duplicate delivery (or the winner's row after a lost insert race), and the
        // webhook must fire once per status, not once per (re)delivery.
        .then(({ row, created }) => {
          // The ingest awaited; a stop()/delete() can retire this engine mid-flight — don't
          // dispatch for a session that no longer exists (mirrors message.received's re-check).
          if (!this.engines.isLive(id, engine)) return;
          // One that expired while the ingest ran (a slow media write) is gone from every read: announcing it
          // would point a consumer at a status the API no longer serves.
          if (created && row.expiresAt > Date.now()) this.dispatchStatusReceived(id, row);
        })
        .catch(err => {
          // Kept rather than lost: no backfill brings a status back on every engine, and it is announced only once stored.
          if (isDatabaseUnavailable(err)) return this.keepStory(id, status, err);
          this.logger.warn('Status ingest failed', {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        })
    );
  }

  /** Keep a received status the database refused, to store and announce it once it answers. */
  private keepStory(id: string, status: IncomingStatus, error: unknown): void {
    this.logger.warn('Keeping a received status the database refused, to store it once it answers', {
      sessionId: id,
      statusId: status.waStatusId,
      error: error instanceof Error ? error.message : String(error),
      action: 'status_ingest_kept',
    });
    const key = keptInboundKey(id, status.waStatusId, 'story');
    this.keepInbound(key, id, status.waStatusId, JSON.stringify(status), 'story', status.waStatusId);
  }

  /** One more try of a kept status: stored and announced as a live one is, or its poster's delete applied. */
  private async applyKeptStory(kept: KeptInbound): Promise<boolean> {
    const statusId = kept.targetId ?? kept.messageId;
    if (kept.kind === 'story-removal') {
      const { by } = JSON.parse(kept.raw) as { by?: { poster?: string } };
      await this.statusStore.removeRevoked(kept.sessionId, statusId, by);
      return true;
    }
    const { row, created } = await this.statusStore.ingest(kept.sessionId, JSON.parse(kept.raw) as IncomingStatus);
    if (created && row.expiresAt > Date.now()) this.dispatchStatusReceived(kept.sessionId, row);
    return true;
  }

  /**
   * Drop a story its poster deleted from the status store, with its media. An engine that passes an actor does not
   * vouch for who sent the delete (Baileys), so the store holds the sender to the poster of the story, and removes
   * nothing when the sender is unknown. One that passes none (whatsapp-web.js) reports a delete only after WhatsApp
   * Web accepted it.
   */
  private removeDeletedStory(id: string, statusId: string, actor?: { participant?: string }): void {
    const by = actor && { poster: actor.participant };
    const keep = (): void => {
      const key = keptInboundKey(id, statusId, 'story-removal');
      this.keepInbound(key, id, statusId, JSON.stringify({ by }), 'story-removal', statusId);
    };
    // A copy of the story kept to be stored would land after the delete: the delete waits behind it, judged by the
    // store as any delete is once the story is there.
    if (this.recovery.get('receive', keptInboundKey(id, statusId, 'story'))) return keep();
    void this.statusStore.removeRevoked(id, statusId, by).catch((err: unknown) => {
      if (isDatabaseUnavailable(err)) return keep();
      this.logger.warn('Failed to remove a status its poster deleted', {
        sessionId: id,
        statusId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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

  /** Post-hook continuation of {@link handleInboundMessage} that may run concurrently: resolve the sender. */
  private async prepareInboundMessage(id: string, finalMessage: InboundMessageData): Promise<InboundMessageData> {
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
    return finalMessage;
  }

  /** Per-chat, in-order stage of {@link handleInboundMessage}: persist, then dispatch. */
  private async commitInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    finalMessage: InboundMessageData,
    entry: InFlightEntry,
    identity: EngineEnvelope,
  ): Promise<InboundOutcome | undefined> {
    const outcome = await this.persistInboundMessage(id, engine, finalMessage, entry, identity);
    if (outcome === 'repeat') return this.judgeRepeat(id, finalMessage, identity);
    if (outcome) await this.dispatchInboundMessage(id, finalMessage, outcome, entry);
    return undefined;
  }

  /**
   * Whether a message the insert refused as a repeat is another message than the one holding its id.
   * A re-fire of the same message is not, but an id reused from another chat, another side of the
   * conversation or another author of a group is: the engine is told, so its copy under that id does
   * not stand in for the stored message. Judged by the rule that refuses a change aimed at the row, so
   * what that rule would refuse to edit is not this message, with the message as the engine reported it
   * (`identity`). A row that cannot be read, or that does not prove a difference, says nothing and the engine
   * keeps its copy. So does a row from before engine refs were kept that the message as a hook filed it
   * (`message`) does not prove different: the engine would otherwise drop its copy of a message moved back then.
   */
  private async judgeRepeat(
    id: string,
    message: InboundMessageData,
    identity: EngineIdentity = message,
  ): Promise<InboundOutcome | undefined> {
    const reason = await this.mutationProjector.foreignRowReason(
      id,
      storableWaMessageId(message.id) ?? '',
      asFiled(claimOf(identity), message),
    );
    if (!reason) return undefined;
    this.logger.warn('Dropping a message that reuses the id of a different stored message', {
      sessionId: id,
      messageId: message.id,
      reason,
      action: 'message_id_reused',
    });
    return { conflict: true };
  }

  /**
   * Build the inbound row and insert it under the UNIQUE dedup oracle. Returns the row plus whether
   * the insert landed, 'repeat' when the id already has a row (an engine re-fire, or another message
   * under the same id), or null when the pipeline must stop (stale engine).
   */
  private async persistInboundMessage(
    id: string,
    engine: IWhatsAppEngine,
    incoming: IncomingMessage,
    entry: InFlightEntry,
    identity: EngineEnvelope,
  ): Promise<InboundPersistOutcome | 'repeat' | null> {
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
      engineRef: engineRefFor(refOf(identity), refOf(incoming), endsRewritten(identity, incoming)),
    });

    // The hook chain above is async; a delete()/teardown can retire this engine while it
    // awaits. Re-check liveness so a late continuation can't persist an orphan messages row
    // (the row has no FK, so a session-delete cleanup would never reap it) or dispatch for a
    // session that no longer exists. Mirrors the synchronous isLiveEngine gate at entry.
    await this.waitForInFlightChanges(id, incoming.id);
    if (!this.engines.isLive(id, engine)) return null;
    let insertedCleared = this.applyHeldChanges(dbMessage, entry);

    let prepared: PreparedWebhookDelivery[] | undefined;
    let preparedSnapshot: InFlightMutationSnapshot | undefined;
    let lookupFailed = false;
    if (this.canTransactWithOutbox()) {
      const prep = await this.prepareTransactionalDeliveries(
        id,
        engine,
        'message.received',
        incoming,
        entry,
        dbMessage,
        insertedCleared,
      );
      if (prep.stale) return null;
      insertedCleared = prep.insertedCleared;
      lookupFailed = prep.failed;
      if (!lookupFailed) {
        prepared = prep.prepared;
        preparedSnapshot = prep.snapshot;
      }
    }

    // De-duplicate at the source: the engine can re-fire `message` for one inbound message
    // (#464). UNIQUE(sessionId, waMessageId) makes the insert the atomic dedup oracle: a
    // near-simultaneous re-fire loses the race and is skipped here, so persist + webhook + WS
    // happen exactly once. When a transactional DataSource and webhook outbox are wired, the
    // message row and its pending outbox rows commit in one database transaction. Fail-open: a
    // non-conflict DB error still dispatches, so a real message is never dropped by a DB fault.
    // Nor by webhooks that could not be read: the engine delivers a message once, so its row is
    // inserted all the same, with no outbox row, and the live dispatch reads the webhooks again.
    const deliveries = lookupFailed ? [] : prepared;
    const outcome = await this.insertWithRetry(id, engine, dbMessage, 'incoming', deliveries, async () => {
      await this.waitForInFlightChanges(id, incoming.id);
      insertedCleared = this.applyHeldChanges(dbMessage, entry) || insertedCleared;
    });
    await this.waitForInFlightChanges(id, incoming.id);
    const engineMessage = { ...identity, id: incoming.id };
    const claim = claimOf(identity);
    if (!this.engines.isLive(id, engine)) {
      await this.settleOnRetire(id, 'message.received', incoming, entry, outcome, prepared, identity);
      return null;
    }
    if (outcome.landed === 'yes') {
      this.applyChangesMadeInFlight(id, engineMessage, entry, insertedCleared, undefined, false, dbMessage);
      if (prepared !== undefined && !outcome.rowOnly) {
        return {
          dbMessage,
          persisted: true,
          prepared,
          openedDeliveries: outcome.openedDeliveries ?? [],
          preparedCommitted: true,
          preparedSnapshot,
        };
      }
      return { dbMessage, persisted: true };
    }
    if (outcome.landed === 'stale') return null;
    // A duplicate on the first attempt is a re-fire, whose original already persisted and dispatched, or a row
    // another writer stored meanwhile (a history sync, an import): that row still takes a change held for the
    // message, which found no row when it arrived. It clears only a row not cleared already, so a re-fire does not
    // announce the row its original cleared once more. A duplicate on the retry is ambiguous: the first attempt
    // may have committed before its error, in which case nothing dispatched yet, so dispatch fail-open (without
    // the row-bound hook), and that row still has to take a revoke or edit that arrived in flight. So does the row
    // of an insert that failed, when its commit landed before the error and the row stored alone after it failed too.
    // A row the database refused is kept to be stored once it answers, before the changes held for it are tried.
    if (outcome.landed === 'failed') this.keepReceivedRow(id, dbMessage, 'incoming', outcome.error);
    if (outcome.landed === 'dup' || outcome.landed === 'failed') {
      const firstAttemptDup = outcome.landed === 'dup' && !outcome.retried;
      this.applyChangesMadeInFlight(id, engineMessage, entry, false, claim, firstAttemptDup);
    }
    // A delivery that came deleted clears the row it lost to, as a revoke does, once the row proves to be the message.
    if (outcome.landed === 'dup' && incoming.type === 'revoked') {
      void this.recordRevoke(id, incoming.id, claim);
    }
    if (outcome.landed === 'dup' && !outcome.retried) return 'repeat';
    const retriedDup = outcome.landed === 'dup' && outcome.retried;
    return {
      dbMessage,
      persisted: false,
      ...(retriedDup ? { prepared, preparedSnapshot } : {}),
      retriedDup,
    };
  }

  /**
   * An engine that retired around the insert announces nothing, yet the changes held for the message are
   * still written to the row the insert may have left, as on a live engine but with no `message:persisted`:
   * a revoke clears it, and what is pending in the outbox for the message is closed (engine revoke) or
   * redacted (a delete through the API), so the sweep cannot deliver the content after teardown; an edit
   * or a reaction is written to it, and an edit to its pending outbox rows too, so the sweep does not
   * deliver the text from before an edit that was announced already. A revoke wins over an edit. A receipt
   * kept for the message advances its status, which the receipt's own retry misses when the commit came later.
   *
   * Whatever the insert reported: a commit can land and still report its failure, or the engine retire
   * before the next attempt asks, and the outcome then names no row although one is there. Each write holds
   * the stored row (and {@link revokeRow} each outbox row) to the chat and sender of the message as the engine
   * reported them (`identity`), as on a live engine, so a row of another chat under the same id is left alone, and
   * nothing is found when no commit landed.
   */
  private async settleOnRetire(
    id: string,
    event: 'message.received' | 'message.sent',
    message: InboundMessageData,
    entry: InFlightEntry,
    outcome: InsertOutcome,
    prepared: PreparedWebhookDelivery[] | undefined,
    identity: EngineIdentity,
  ): Promise<void> {
    const edited = entry?.editedBody !== undefined || entry?.edited === true;
    if (!entry?.revoked && !edited && !entry?.reactions && !entry?.acks?.size) return;
    const claim = claimOf(identity);
    // The outbox rows of this commit: those it opened, or, when it reported an error, the prepared ones if the
    // row it would have written is there.
    let committed = outcome.landed === 'yes' ? outcome.openedDeliveries : undefined;
    if (!committed && !entry.revoked && edited && prepared?.length && (outcome.landed !== 'dup' || outcome.retried)) {
      const verdict = await this.mutationProjector.storedRowVerdict(id, message.id, claim);
      if (verdict.exists && !verdict.reason) committed = prepared;
    }
    // A delete through the API still announces the message, as deleted, and an edit as edited: the rows are judged
    // again by their webhooks' filters, which a change of the payload alone would not do. Null for an engine revoke.
    const final = this.withChangesMadeInFlight(message, entry);
    if (final && committed?.length && (entry.revoked || edited)) {
      // The prepared rows may never have been written (the row can be the send path's): correct them, open none.
      const openNew = outcome.landed === 'yes';
      await this.webhookService.reconcilePreparedDeliveries?.(committed, id, event, final, committed, openNew);
    }
    // Judged by the message as the engine reported it, which its row keeps when a handler filed it elsewhere.
    const engineOf = this.engines.get(id);
    await new Promise<void>(resolve =>
      this.enqueueMessageMutation(id, message.id, async () => {
        try {
          // A row that could not be read may be another chat's, as in applyChangesMadeInFlight: the changes are kept
          // until a read tells, and written then, with nothing announced for the retired engine.
          const slots = this.heldSlots(entry, identity, false);
          const verdict = await this.mutationProjector.storedRowVerdict(id, message.id, claim);
          if (!slots || verdict.reason || (!verdict.exists && !verdict.unread)) return;
          if (verdict.unread) return this.parkChange(id, message.id, slots, unreadRowError(verdict), engineOf);
          await this.runOrPark(id, message.id, slots, false, engineOf);
        } finally {
          resolve();
        }
      }),
    );
  }

  /**
   * Build a payload ownership predicate for pending webhook outbox rows matching `source`, using
   * the same foreign-row rule applied to stored `messages` rows. A payload carries the message as a handler
   * filed it: `filed`, the row's own ref once its engine ref accepted the change, also matches.
   */
  /** Dispatch a message event, with what the engine reported of the message when a handler filed it elsewhere. */
  private dispatchMessage(
    id: string,
    event: string,
    data: Record<string, unknown>,
    engineRef: MessageEngineRef | null,
  ): void {
    void (engineRef
      ? this.webhookService.dispatch(id, event, data, { engineRef })
      : this.webhookService.dispatch(id, event, data));
  }

  /**
   * The copies a delivery of this message opened: by what the engine reported when a handler filed it elsewhere (the
   * copies keep it), and by the filed message too, as a copy from before engine refs were kept carries only that.
   */
  private ownCopiesPredicate(
    message: Pick<IncomingMessage, 'chatId' | 'fromMe' | 'author'>,
    engineRef?: MessageEngineRef | null,
  ): ReturnType<typeof outboxPayloadPredicate> {
    const filed = revokeSourceFor(refOf(message));
    return engineRef
      ? this.outboxPredicateFor(revokeSourceFor(engineRef), false, filed)
      : this.outboxPredicateFor(filed);
  }

  private outboxPredicateFor(
    source: MutationSource,
    allowUnverifiedFallback = false,
    filed?: MutationSource,
  ): (payload: Record<string, unknown>) => Promise<boolean> {
    const resolveLid = this.lidMappingStore ? (jid: string) => this.lidMappingStore!.findPhoneForLid(jid) : undefined;
    return outboxPayloadPredicate(source, resolveLid, allowUnverifiedFallback, filed);
  }

  /**
   * True when both a transaction-capable DataSource and the composable webhook outbox methods are
   * present (always true in production; false only in unit tests that stub repositories/webhooks).
   */
  private canTransactWithOutbox(): boolean {
    const connection = this.messageRepository.manager?.connection;
    return (
      typeof connection?.transaction === 'function' &&
      typeof this.webhookService.prepareDeliveries === 'function' &&
      typeof this.webhookService.openPreparedDeliveries === 'function' &&
      typeof this.webhookService.reconcilePreparedDeliveries === 'function' &&
      typeof this.webhookService.dispatchPreparedDeliveries === 'function'
    );
  }

  /**
   * Read-only pre-transaction preparation for transactional message + webhook outbox commits.
   * Runs strictly before opening any DB transaction so zero non-DB awaits (LID lookups, webhook
   * reads, filter evaluation) occur while holding a transaction or SQLite's shared connection.
   *
   * Propagates lookup errors (`throwOnLookupError: true`) with one transient retry instead of
   * silently degrading to 0 webhooks. A lookup that still fails is reported as `failed`, never thrown:
   * the caller stores the row without deliveries and leaves the announcement to the live dispatch.
   * Tracks in-flight mutation state by value so pre-edited messages are prepared only once.
   */
  private async prepareTransactionalDeliveries(
    id: string,
    engine: IWhatsAppEngine,
    event: 'message.received' | 'message.sent',
    message: InboundMessageData,
    entry: InFlightEntry,
    dbMessage: Message,
    insertedCleared: boolean,
  ): Promise<{
    prepared: PreparedWebhookDelivery[];
    snapshot: InFlightMutationSnapshot;
    insertedCleared: boolean;
    stale: boolean;
    failed: boolean;
  }> {
    const prepareStrict = async (
      payload: Record<string, unknown>,
    ): Promise<{ deliveries: PreparedWebhookDelivery[]; stale: boolean; failed: boolean }> => {
      const label = `Failed to load webhooks before persisting ${event} for message ${message.id}`;
      try {
        const deliveries = await this.webhookService.prepareDeliveries(id, event, payload, {
          throwOnLookupError: true,
          engineRef: dbMessage.engineRef ?? null,
        });
        return { deliveries, stale: false, failed: false };
      } catch (err) {
        if (!isTransientDbError(err)) {
          this.logger.error(label, String(err));
          return { deliveries: [], stale: false, failed: true };
        }
        this.logger.warn(`${label}, retrying once`, { sessionId: id, error: String(err) });
      }
      await new Promise(resolve => setTimeout(resolve, PERSIST_RETRY_DELAY_MS));
      if (!this.engines.isLive(id, engine)) {
        return { deliveries: [], stale: true, failed: false };
      }
      try {
        const deliveries = await this.webhookService.prepareDeliveries(id, event, payload, {
          throwOnLookupError: true,
          engineRef: dbMessage.engineRef ?? null,
        });
        return { deliveries, stale: false, failed: false };
      } catch (err) {
        this.logger.error(label, String(err));
        return { deliveries: [], stale: false, failed: true };
      }
    };

    const snapBefore = snapshotInFlight(entry);
    const preAnnounced = this.withChangesMadeInFlight(message, entry);
    if (!preAnnounced) {
      return { prepared: [], snapshot: snapBefore, insertedCleared, stale: false, failed: false };
    }
    const first = await prepareStrict(preAnnounced);
    if (first.stale) {
      return { prepared: [], snapshot: snapBefore, insertedCleared, stale: true, failed: false };
    }
    let prepared = first.deliveries;
    let snapshot = snapBefore;

    await this.waitForInFlightChanges(id, message.id);
    if (!this.engines.isLive(id, engine)) {
      return { prepared: [], snapshot, insertedCleared, stale: true, failed: false };
    }
    insertedCleared = this.applyHeldChanges(dbMessage, entry) || insertedCleared;
    // The row is inserted without deliveries: it has taken the changes that arrived during the lookup.
    if (first.failed) return { prepared: [], snapshot, insertedCleared, stale: false, failed: true };
    const snapAfter = snapshotInFlight(entry);
    if (!sameInFlightSnapshot(snapBefore, snapAfter)) {
      snapshot = snapAfter;
      const afterPrepare = this.withChangesMadeInFlight(message, entry);
      if (!afterPrepare) {
        return { prepared: [], snapshot, insertedCleared, stale: false, failed: false };
      }
      const second = await prepareStrict(afterPrepare);
      if (second.stale) {
        return { prepared: [], snapshot, insertedCleared, stale: true, failed: false };
      }
      prepared = second.deliveries;
      await this.waitForInFlightChanges(id, message.id);
      if (!this.engines.isLive(id, engine)) {
        return { prepared: [], snapshot, insertedCleared, stale: true, failed: false };
      }
      insertedCleared = this.applyHeldChanges(dbMessage, entry) || insertedCleared;
      if (second.failed) return { prepared: [], snapshot, insertedCleared, stale: false, failed: true };
      const finalSnap = snapshotInFlight(entry);
      if (!this.withChangesMadeInFlight(message, entry)) {
        return { prepared: [], snapshot: finalSnap, insertedCleared, stale: false, failed: false };
      }
    }
    return { prepared, snapshot, insertedCleared, stale: false, failed: false };
  }

  /**
   * Conflict-ignoring insert of one `messages` row inside an active EntityManager. Returns the
   * committed PK/timestamp metadata if the row was newly inserted, or null if a row already holds
   * its UNIQUE(sessionId, waMessageId) key or the primary key its caller chose for it, without
   * throwing a unique error that would abort a PostgreSQL transaction or roll back SQLite's shared
   * connection.
   */
  private async insertMessageOrIgnore(
    manager: EntityManager,
    dbMessage: Message,
  ): Promise<{ id?: string; createdAt?: Date } | null> {
    const supportsReturning = manager.connection?.driver?.isReturningSqlSupported?.('insert') === true;
    if (supportsReturning) {
      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(Message)
        .values({ ...dbMessage } as unknown as QueryDeepPartialEntity<Message>)
        .orIgnore()
        .returning(['id', 'createdAt'])
        .updateEntity(false)
        .execute();
      const row = Array.isArray(result.raw)
        ? (result.raw[0] as { id?: string; createdAt?: Date } | undefined)
        : undefined;
      return row ?? null;
    }
    const candidateId = dbMessage.id ?? randomUUID();
    // A key chosen ahead of the insert is shared by the attempts at it (see insertWithRetry): the row may be
    // there already, and the read-back below could not tell that row from one written now.
    if (dbMessage.id && (await manager.existsBy(Message, { id: candidateId }))) return null;
    await manager
      .createQueryBuilder()
      .insert()
      .into(Message)
      .values({ ...dbMessage, id: candidateId } as unknown as QueryDeepPartialEntity<Message>)
      .orIgnore()
      .updateEntity(false)
      .execute();
    const row = await manager.findOne(Message, {
      where: { id: candidateId },
      select: { id: true, createdAt: true },
    });
    if (!row) return null;
    return { id: row.id, createdAt: row.createdAt };
  }

  /**
   * A revoke or edit can arrive while a message waits for its hook or insert: write
   * the row as the change leaves it, so `message:persisted` and the media archive never see content
   * that was taken back. A change landing during the insert is still applied after it. A message
   * delivered deleted is written cleared on either database, as the history sync stores one, and takes
   * no edit. Returns whether the row is written cleared.
   */
  private applyHeldChanges(dbMessage: Message, entry: InFlightEntry): boolean {
    if (dbMessage.type === 'revoked') {
      Object.assign(dbMessage, REVOKED_ROW_PATCH);
      return true;
    }
    if (entry?.revoked) Object.assign(dbMessage, REVOKED_ROW_PATCH);
    else {
      if (entry?.editedBody !== undefined) dbMessage.body = entry.editedBody;
      if (entry?.edited) dbMessage.metadata = { ...dbMessage.metadata, edited: true };
    }
    return entry?.revoked === true;
  }

  /**
   * Insert a message row under the UNIQUE(sessionId, waMessageId) dedup oracle. When `prepared` is
   * supplied, the conflict-ignoring message insert and prepared webhook outbox rows commit together
   * inside one database transaction (guarded by `awaitNoOpenTransaction` on SQLite's shared
   * connection), returning only the newly inserted outbox deliveries so pre-existing keys are never
   * double-dispatched. Without `prepared` (unit-mocked repositories/services), falls back to a bare
   * `insert()`. A transient failure is retried once after {@link PERSIST_RETRY_DELAY_MS}, re-checking
   * that the engine is still live so a retired session never gets an orphan row. On success the
   * DB-generated columns are merged onto `dbMessage`.
   *
   * A transaction of row and outbox rows that fails for good is followed, while the engine is still
   * live, by one insert of the row alone: no engine delivers the message again, so a fault of the
   * outbox half must not cost the row.
   * The prepared deliveries are dropped then (`rowOnly`) and the caller's live dispatch reads the
   * webhooks itself. A row that insert finds stored means the transaction landed before its error
   * surfaced: the caller is told `dup` after a retry, which it already takes as that case.
   *
   * Either later attempt (the retry, the row alone) follows a wait or a failure during which a revoke
   * or edit may have reached the message. `takeHeldChanges` is called before each, for the caller to
   * write those onto `dbMessage` ({@link applyHeldChanges}): the attempt does not write the row, nor
   * hand it to `message:persisted` and the media archive, with text that was taken back before the
   * attempt began. A change that arrives during the attempt itself reaches the row after it, as on a
   * first attempt.
   */
  private async insertWithRetry(
    id: string,
    engine: IWhatsAppEngine,
    dbMessage: Message,
    direction: 'incoming' | 'outgoing',
    prepared?: readonly PreparedWebhookDelivery[],
    takeHeldChanges?: () => Promise<void>,
  ): Promise<InsertOutcome> {
    const label = `Failed to save ${direction} message ${dbMessage.waMessageId} to database`;
    // A message whose id the engine could not read is stored with no waMessageId, which the unique index
    // exempts: nothing would stop an attempt that follows a commit that landed before its error from storing
    // it again. Its attempts share one primary key instead, so the later one finds that row.
    if (!dbMessage.waMessageId) dbMessage.id ??= randomUUID();
    // Whether the latest attempt got as far as the transaction of row and outbox rows.
    let transacted = false;
    const insert = async (retried: boolean, deliveries = prepared): Promise<InsertOutcome> => {
      transacted = false;
      // Registered with the session's write scope, so a delete drains an insert already under way before it
      // removes the session's rows; the row has no foreign key to refuse one that lands afterwards.
      const connection = this.messageRepository.manager?.connection;
      const writes = captureSessionWrites(connection ?? this.messageRepository, id);
      if (deliveries !== undefined && connection) {
        let insertedMeta: { id?: string; createdAt?: Date } | null = null;
        let openedDeliveries: PreparedWebhookDelivery[] = [];
        await writes
          .write(async () => {
            if (!(await awaitNoOpenTransaction(connection))) {
              throw new Error('Timed out waiting for the message database transaction');
            }
            if (deliveries.length > 0) {
              transacted = true;
              await connection.transaction(async manager => {
                insertedMeta = await this.insertMessageOrIgnore(manager, dbMessage);
                if (!insertedMeta) return;
                openedDeliveries = (await this.webhookService.openPreparedDeliveries(deliveries, manager)) ?? [];
              });
            } else {
              insertedMeta = await this.insertMessageOrIgnore(this.messageRepository.manager, dbMessage);
            }
          })
          .finally(() => writes.close());
        if (!insertedMeta) return { landed: 'dup', retried };
        Object.assign(dbMessage, insertedMeta);
        return { landed: 'yes', openedDeliveries };
      }
      const result = await writes
        .write(() => this.messageRepository.insert(dbMessage as unknown as QueryDeepPartialEntity<Message>))
        .finally(() => writes.close());
      // `insert()` (not `save()`) does NOT merge DB-generated columns (@PrimaryGeneratedColumn,
      // @CreateDateColumn) back onto the entity instance, so merge them explicitly here before
      // the `message:persisted` emit.
      Object.assign(dbMessage, result.identifiers[0] ?? {}, result.generatedMaps?.[0] ?? {});
      return { landed: 'yes' };
    };
    // An insert that failed for good. One that never reached the transaction (it waited in vain for
    // another one to end, or its session is being deleted) has nothing the row alone would do better.
    const failed = async (err: unknown): Promise<InsertOutcome> => {
      if (!transacted) {
        this.logger.error(label, String(err));
        return { landed: 'failed', error: err };
      }
      await takeHeldChanges?.();
      // As before the retry: an engine retired meanwhile gets no row, which nothing would announce.
      if (!this.engines.isLive(id, engine)) return { landed: 'stale' };
      this.logger.warn(`${label} with its webhook outbox rows, storing it alone`, {
        sessionId: id,
        error: String(err),
      });
      try {
        const alone = await insert(true, []);
        return alone.landed === 'yes' ? { landed: 'yes', rowOnly: true } : alone;
      } catch (aloneErr) {
        this.logger.error(label, String(aloneErr));
        return { landed: 'failed', error: aloneErr };
      }
    };
    try {
      return await insert(false);
    } catch (err) {
      if (isUniqueViolation(err)) return { landed: 'dup', retried: false };
      if (!isTransientDbError(err)) return failed(err);
      this.logger.warn(`${label}, retrying once`, { sessionId: id, error: String(err) });
    }
    await new Promise(resolve => setTimeout(resolve, PERSIST_RETRY_DELAY_MS));
    await takeHeldChanges?.();
    if (!this.engines.isLive(id, engine)) return { landed: 'stale' };
    try {
      return await insert(true);
    } catch (err) {
      if (isUniqueViolation(err)) return { landed: 'dup', retried: true };
      return failed(err);
    }
  }

  /**
   * Write a revoke, edit, reaction or ack that arrived before the message's row existed onto the row
   * just inserted: its own write matched no row then. Queued on the message's mutation chain, so it
   * lands after any edit already queued, and a revoke wins over the rest. A change arriving after the
   * insert finds the row itself. Reactions are only stored here; their event already went out. A row
   * inserted cleared is cleared again, in case a change raced the insert, without announcing it:
   * `message:persisted` already carried it cleared. Where the insert lost, a pending revoke announces the
   * row it clears, which an earlier revoke may have cleared and announced already, and a revoke event still
   * waiting for its own row read when the insert lands announces it once more: a consumer may see the
   * cleared row more than once under the same id.
   *
   * `lostInsert`, set when the delivery's insert lost to a row under the id or failed, says what the delivery
   * claims to be. A row under the id may be the message itself (an attempt committed before its error) or
   * another message's (an id reused from another chat): the changes go to it only if it is the message. The
   * judgement is the first step of the slot taken on the chain here, not a read ahead of it, so a change
   * of the message that arrives while the row is read queues behind the write instead of being
   * overwritten by it. A row that cannot be read, and a write the database refuses, keep the changes to be
   * judged and written once it answers (see ParkedChange); none is written to a row nobody could read.
   *
   * `message` is the delivery as the engine reported it: a change held for it was judged against that, and its
   * row keeps it as its engine ref when a handler filed the row under another chat, side or author. A row from
   * before engine refs were kept is judged by its own columns: a message of the chat a handler filed the delivery
   * under may hold the same id there.
   */
  private applyChangesMadeInFlight(
    id: string,
    message: Pick<IncomingMessage, 'id' | 'chatId' | 'fromMe' | 'author'>,
    pending: InFlightEntry,
    insertedCleared = false,
    lostInsert?: MutationSource,
    unrevokedOnly = false,
    inserted?: Pick<Message, 'id'>,
  ): void {
    const waMessageId = message.id;
    // The row this commit inserted is the message's own: its changes go to it by its key, with no read.
    const own = lostInsert ? undefined : { rowId: inserted?.id };
    const slots = this.heldSlots(pending, message, !insertedCleared, unrevokedOnly, own);
    if (!slots) return;
    const engine = this.engines.get(id);
    this.enqueueMessageMutation(id, waMessageId, async () => {
      if (lostInsert) {
        const verdict = await this.mutationProjector.storedRowVerdict(id, waMessageId, lostInsert);
        if (verdict.reason) {
          this.logger.warn('Not applying the changes of a message to the stored message that holds its id', {
            sessionId: id,
            messageId: waMessageId,
            reason: verdict.reason,
          });
          return;
        }
        // A row that cannot be read may be the message's (an attempt that committed before its error) or another
        // chat's: nothing is written to it, and nothing is dropped, until a read tells which.
        if (verdict.unread) return this.parkChange(id, waMessageId, slots, unreadRowError(verdict), engine);
        // No row: the commit did not land, and nothing is left to change.
        if (!verdict.exists) return;
      }
      await this.runOrPark(id, waMessageId, slots, true, engine);
    });
  }

  /**
   * The changes held on a message's in-flight entry, as slots judged by what the commit computed: the revoke by the
   * message as the engine reported it (`message`), the rest by its claim. `notify` hands a row the revoke clears to
   * `message:persisted` (not when it was inserted cleared); `unrevokedOnly` clears only a row not cleared already.
   */
  private heldSlots(
    pending: InFlightEntry,
    message: Pick<IncomingMessage, 'chatId' | 'fromMe' | 'author'>,
    notify: boolean,
    unrevokedOnly = false,
    own?: OwnRow,
  ): ChangeSlots | undefined {
    const claim = claimOf(message);
    const slots: ChangeSlots = {};
    if (pending.revoked) {
      slots.revoke = {
        source: revokeSourceFor(refOf(message)),
        judge: claim,
        own,
        announced: pending.revokeAnnounced === true,
        notify,
        unrevokedOnly,
      };
    } else {
      if (pending.editedBody !== undefined || pending.edited) {
        slots.edit = {
          body: pending.editedBody,
          judge: claim,
          own,
          mark: pending.edited ? 'always' : 'never',
          announceText: notify,
        };
      }
      if (pending.reactions) {
        const judge: MutationSource = { kind: 'reaction', chatId: message.chatId };
        slots.reactions = new Map(
          Object.entries(pending.reactions).map(([sender, value]) => [sender, { value, judge, own }]),
        );
      }
    }
    if (pending.acks?.size) slots.acks = { judge: claim, own, ref: pending.ref, acks: new Map(pending.acks) };
    return slotNames(slots).length ? slots : undefined;
  }

  /**
   * Advance the row by the receipts kept for it, judged by the message's claim: each receipt by the receipt rule
   * against the message as it was in flight, or, kept with no such ref (a receipt that came while the send's SENT write
   * waited), against the row read. A row that cannot be read throws, so the receipts are kept; none is written to a row
   * of another chat.
   */
  private async advanceKeptAcks(sessionId: string, waMessageId: string, slot: AckSlot): Promise<void> {
    const verdict = slot.own
      ? ownRowVerdict(slot.own)
      : await this.mutationProjector.storedRowVerdict(sessionId, waMessageId, slot.judge);
    if (verdict.unread) throw unreadRowError(verdict);
    if (!verdict.exists || verdict.reason) return;
    const status = await this.furthestParkedAck(slot.ref ?? verdict.row, slot.acks);
    if (status) {
      await this.advanceAck(sessionId, waMessageId, status, verdict.rowId ? { id: verdict.rowId } : undefined);
    }
  }

  /**
   * The furthest of the acks kept for a message in flight whose receipt named its chat, or no chat: one naming another
   * chat (through the lid directory, as {@link receiptVerdict} judges a written row) is left out. The queued receipt
   * judgement already logged it.
   */
  private async furthestParkedAck(
    ref: StoredMessageRef | undefined,
    acks: Map<string, MessageStatus>,
  ): Promise<MessageStatus | undefined> {
    const resolveLid = this.lidMappingStore ? (jid: string) => this.lidMappingStore!.findPhoneForLid(jid) : undefined;
    let furthest: MessageStatus | undefined;
    for (const [chat, status] of acks) {
      if (chat && ref && (await receiptTargetsForeignRowPersisted(ref, chat, resolveLid))) continue;
      if (!furthest || ackStatusTransitionFrom(status).includes(furthest)) furthest = status;
    }
    return furthest;
  }

  /**
   * A forward of a message the gateway holds no row for stores a placeholder of type 'forward', the only writer of
   * that type, because the send path has nothing but the engine id to go on. When that row takes the id first, the
   * own-send echo, which carries the forwarded type, caption and media marker, loses its insert and lands here: its
   * content replaces the placeholder and the row is announced again. Status is left alone, an ack may have advanced
   * it, and so is an edit that reached the message while its insert was running. Must run on the message's mutation
   * chain. Never rejects.
   */
  private async replaceForwardPlaceholder(
    id: string,
    echoRow: Message,
    source: MutationSource,
    entry: InFlightEntry,
  ): Promise<void> {
    const { waMessageId, type, metadata } = echoRow;
    const body = entry.editedBody ?? echoRow.body;
    if (!waMessageId || type === 'revoked') return;
    try {
      const placeholder = await this.messageRepository.findOne({
        where: { sessionId: id, waMessageId, type: 'forward' },
        select: { id: true },
      });
      if (!placeholder) return;
      const reason = await this.mutationProjector.foreignRowReason(id, waMessageId, source);
      if (reason) {
        this.logger.warn('Not replacing the forward placeholder with a message that is not the one it holds', {
          sessionId: id,
          messageId: waMessageId,
          reason,
        });
        return;
      }
      // Before the type flips, so a merge that fails leaves the placeholder as it was, not a typed row without its media.
      // The placeholder read above, by its key, so a row stored under the id since is not the one replaced.
      if (metadata) {
        await updateMessageMetadata(this.messageRepository, { id: placeholder.id }, current =>
          mergeSentMetadata(current, metadata),
        );
      }
      const replaced = await this.messageRepository.update({ id: placeholder.id, type: 'forward' }, { type, body });
      if (replaced?.affected) await this.announceChangedRow(id, waMessageId);
    } catch (err) {
      this.logger.error(`Failed to replace the forward placeholder of ${waMessageId}`, String(err));
    }
  }

  /**
   * Hand a stored row whose text an edit changed to `message:persisted` again, as {@link revokeRow} does for a
   * cleared one, so a plugin keeping a copy keyed by the row id follows the edit. Re-read, so the payload carries
   * the edited marker. Never rejects.
   */
  private async announceChangedRow(sessionId: string, waMessageId: string): Promise<void> {
    try {
      const row = await this.messageRepository.findOne({ where: { sessionId, waMessageId } });
      if (!row) return;
      void this.hookManager
        .execute('message:persisted', { sessionId, message: row }, { sessionId, source: 'SessionService' })
        .catch(() => undefined);
    } catch (err) {
      this.logger.warn('Failed to read an edited message for message:persisted', {
        sessionId,
        messageId: waMessageId,
        error: String(err),
      });
    }
  }

  /** Merge reactions into the row's metadata, withdrawing a sender's on ''. Must run on the mutation chain. */
  private async storeReactions(
    sessionId: string,
    waMessageId: string,
    changes: Record<string, string>,
    judge: MutationSource,
    own?: OwnRow,
  ): Promise<void> {
    if (own)
      await this.mutationProjector.writeJudgedReactions(sessionId, waMessageId, changes, judge, ownRowVerdict(own));
    else await this.mutationProjector.writeReactions(sessionId, waMessageId, changes, judge);
  }

  /**
   * Clear a revoked message's stored row, on the message's mutation chain so a reaction or edit queued
   * before it cannot write content back afterwards. Used by the engine's revoke event, by the REST
   * delete, and by a delivery that came deleted and lost its insert. Best-effort like every stored-message
   * mutation: never rejects, and resolves once the write has run.
   *
   * With `source`, the caller has not had the stored row judge the revoke yet: the message still arriving
   * is taken back only if the revoke agrees with it, and the row is cleared only if the revoke is not
   * foreign to it. Without one, the revoke was judged by the caller (the engine's revoke event is).
   */
  recordRevoke(sessionId: string, waMessageId: string, source?: MutationSource, announced = false): Promise<void> {
    let stored: Promise<void> | undefined;
    const pending = this.changeInFlight(sessionId, waMessageId, source, (needsRow, entry) => {
      if (entry && !needsRow) {
        this.holdRevoked(sessionId, entry);
        if (announced) entry.revokeAnnounced = true;
      }
      stored = new Promise(resolve =>
        this.enqueueMessageMutation(sessionId, waMessageId, () =>
          this.revokeRow(sessionId, waMessageId, true, source, announced).finally(resolve),
        ),
      );
    });
    return Promise.resolve(pending).then(() => stored);
  }

  /** Take back a message not written yet: its row is stored cleared, and media waiting for room needs none. */
  private holdRevoked(sessionId: string, entry: InFlightEntry): void {
    entry.revoked = true;
    for (const t of this.tickets.get(sessionId) ?? []) if (t.entry === entry) t.giveUp();
  }

  /**
   * Clear a revoked message's row (see {@link applyRevoke}); what the database refuses is kept and written once it
   * answers (see ParkedChange). Must run on the message's mutation chain. Never rejects.
   */
  private async revokeRow(
    sessionId: string,
    waMessageId: string,
    notify = true,
    source?: MutationSource,
    announced = false,
  ): Promise<void> {
    // An undefined condition is DROPPED from the where-clause, which would clear every row of the session.
    if (!waMessageId) return;
    const slot: RevokeSlot = { source, announced, notify };
    try {
      await this.applyRevoke(sessionId, waMessageId, slot, true);
      await this.settleParked(sessionId, waMessageId, { revoke: slot });
    } catch (err) {
      await this.parkChange(sessionId, waMessageId, { revoke: slot }, err);
    }
  }

  /**
   * Apply {@link REVOKED_ROW_PATCH}, then hand the cleared row to `message:persisted` so a plugin index keyed by row id
   * drops the content too. The row is the table's one under the id, which another chat's message may hold: one that
   * the slot's `judge` (else its `source`) proves foreign is left alone. A revoke with neither was judged by its
   * caller (the engine's revoke event without an actor).
   *
   * The delivery copies go first (engine revokes close them, REST deletes redact them), each judged by its own
   * payload, so a database that stops answering between the two never leaves a cleared row whose deliveries still
   * carry the content, and a spoofed cross-chat revoke cannot withdraw another chat's delivery; a payload that names no
   * chat goes only when the stored row was read as the message's. A row that cannot be read is never cleared: the
   * copies go, judged by their payloads, and the read's error is thrown, as is any database failure, for the caller
   * to keep the revoke and try again. `announce` says the engine is still live. Must run on the message's chain.
   */
  private async applyRevoke(
    sessionId: string,
    waMessageId: string,
    slot: RevokeSlot,
    announce: boolean,
  ): Promise<void> {
    const judgeBy = slot.judge ?? slot.source;
    const judge = async (): Promise<StoredRowVerdict | undefined> => {
      const judged = judgeBy && (await this.mutationProjector.storedRowVerdict(sessionId, waMessageId, judgeBy));
      if (judged?.reason) {
        this.logger.warn('Dropping a revoke aimed at a message of another chat or sender', {
          sessionId,
          messageId: waMessageId,
          reason: judged.reason,
        });
      }
      return judged;
    };
    let verdict = slot.own ? ownRowVerdict(slot.own) : await judge();
    if (verdict?.reason) return;
    if (verdict?.unread) {
      if (!slot.outboxSettled) {
        await this.revokeCopies(sessionId, waMessageId, slot);
        slot.outboxSettled = true;
      }
      throw unreadRowError(verdict);
    }
    // Again once the row is read: a payload of a moved message carries the chat a handler filed it under.
    if (!slot.outboxSettled || verdict?.moved) {
      await this.revokeCopies(sessionId, waMessageId, slot, verdict);
      slot.outboxSettled = true;
    }
    // A row stored under the id while the deliveries went (none was there to judge) is judged before it is cleared.
    if (verdict && !verdict.exists) {
      verdict = await judge();
      if (verdict?.reason) return;
      if (verdict?.unread) throw unreadRowError(verdict);
    }
    // The row judged is cleared by its key, and with none found only the message's own row can take it.
    const target =
      (judgeBy || slot.own) && verdict
        ? await this.mutationProjector.writeTarget(sessionId, waMessageId, judgeBy!, verdict)
        : { sessionId, waMessageId };
    if (!target) return;
    const result = await this.messageRepository.update(
      slot.unrevokedOnly ? { ...target, type: Not('revoked') } : target,
      REVOKED_ROW_PATCH,
    );
    this.markedEdited.get(sessionId)?.delete(waMessageId);
    if (!result?.affected || !slot.notify || !announce) return;
    const row = await this.messageRepository.findOne({ where: target }).catch(() => null);
    if (!row) return;
    void this.hookManager
      .execute('message:persisted', { sessionId, message: row }, { sessionId, source: 'SessionService' })
      .catch(() => undefined);
  }

  /** Fan an accepted inbound message out: `message:persisted` plugin hook, webhook, websocket emit. */
  private async dispatchInboundMessage(
    id: string,
    finalMessage: InboundMessageData,
    outcome: InboundPersistOutcome,
    entry: InFlightEntry,
  ): Promise<void> {
    const { dbMessage, persisted, prepared, openedDeliveries, preparedCommitted, preparedSnapshot, retriedDup } =
      outcome;
    // Fire-and-forget: a plugin handler must never break the receive path. Both engine adapters
    // (wwjs `message` and Baileys `upsert`) converge on this persist, so one emit covers inbound.
    // The built-in FTS search provider is DB-synced and does NOT consume this; it exists for
    // plugin providers (Spec 2) + general use.
    // Gate ONLY the hook on `persisted`: on a non-unique insert error (transient SQLITE_BUSY /
    // lock-timeout / connection drop) the row was never stored and `dbMessage.id` is undefined,
    // so emitting `message:persisted` would hand plugins an id-less payload for a row that isn't
    // in the DB. The webhook/WS dispatch below stays fail-open: a real inbound message must
    // never be dropped on a transient DB failure; only the hook requires a durable row.
    if (persisted) {
      void this.hookManager
        .execute(
          'message:persisted',
          { sessionId: id, message: persistedRow(dbMessage) },
          { sessionId: id, source: 'SessionService' },
        )
        .catch(() => undefined);

      // Fire-and-forget for the same reason as the hook above: the receive path must not wait on
      // storage. Gated on `persisted` because the archive updates the row by id, and on a failed
      // insert there is no row to point at the file. A no-op unless archiving is enabled.
      void this.chatMediaArchive?.archive(dbMessage).catch(() => undefined);
    }

    const engineRef = dbMessage.engineRef ?? null;
    const announced = this.withChangesMadeInFlight(finalMessage, entry);
    const currentSnap = snapshotInFlight(entry);
    if (!announced) {
      if (preparedCommitted && openedDeliveries?.length) {
        await this.webhookService.cancelPreparedDeliveries?.(openedDeliveries);
      } else if (retriedDup) {
        await this.webhookService.closePendingDeliveriesForMessage?.(
          id,
          finalMessage.id,
          this.ownCopiesPredicate(finalMessage, engineRef),
        );
      }
      return;
    }
    // Dispatch to webhooks with potentially modified message (fire-and-forget so HTTP/retries never
    // stall the per-chat commit queue).
    if (preparedCommitted) {
      if (preparedSnapshot && sameInFlightSnapshot(preparedSnapshot, currentSnap)) {
        if (prepared && prepared.length > 0) void this.webhookService.dispatchPreparedDeliveries(prepared);
      } else {
        const reconciled = await this.webhookService.reconcilePreparedDeliveries(
          prepared ?? [],
          id,
          'message.received',
          announced,
          openedDeliveries,
          undefined,
          engineRef,
        );
        if (reconciled.length > 0) void this.webhookService.dispatchPreparedDeliveries(reconciled);
      }
    } else if (retriedDup && prepared !== undefined) {
      if (preparedSnapshot && sameInFlightSnapshot(preparedSnapshot, currentSnap)) {
        if (prepared.length > 0) {
          await this.webhookService.openPreparedDeliveries(prepared);
          void this.webhookService.dispatchPreparedDeliveries(prepared);
        }
      } else {
        const reconciled = await this.webhookService.reconcilePreparedDeliveries(
          prepared,
          id,
          'message.received',
          announced,
          undefined,
          undefined,
          engineRef,
        );
        if (reconciled.length > 0) void this.webhookService.dispatchPreparedDeliveries(reconciled);
      }
    } else {
      this.dispatchMessage(id, 'message.received', announced, engineRef);
    }
    // Autoreply rules ride the same at-most-once dispatch (the insert oracle above dedupes engine
    // re-fires) and stay fail-open like the webhook: a broken rule must never break the receive path.
    void this.automationRules?.evaluateInbound(id, announced).catch(() => undefined);
    // Emit real-time event to WebSocket clients
    this.eventsGateway.emitMessage(id, announced);
  }

  /**
   * The message as a revoke or edit that arrived while it was in flight left it, for its announcement:
   * null once the engine revoked it (message.revoked already went out, so the deleted content is not
   * announced after it), the revoked placeholder when only the REST delete did (a delete-for-me emits no
   * engine revoke, and the message still exists for its sender) or when it was delivered deleted, the edited
   * body when edited (message.edited already went out with it), plus `edited: true` when the row is marked
   * for it or already was (`rowMarked`): a consumer that held no copy of the message could not apply that
   * event. The stored row takes the same changes in {@link applyChangesMadeInFlight}. One delivered deleted
   * is stored cleared and takes no edit ({@link applyHeldChanges}), and clears the row it lost its insert to
   * when that row is the message.
   */
  private withChangesMadeInFlight(
    message: InboundMessageData,
    pending: InFlightEntry,
    rowMarked = false,
  ): (InboundMessageData & { edited?: true }) | null {
    if (pending?.revokeAnnounced) return null;
    // No edit held for it, and no mark.
    if (pending?.revoked || message.type === 'revoked') return deletedPlaceholder(message);
    const edited = rowMarked || pending?.edited;
    // An edit the engine applied before the hand-over is in the body already.
    if (pending?.editedBody === undefined) return edited ? { ...message, edited: true as const } : message;
    return { ...message, body: pending.editedBody, ...(edited ? { edited: true as const } : {}) };
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleOwnSendEcho(id: string, engine: IWhatsAppEngine, message: IncomingMessage, ticket?: InboundTicket): void {
    const turn = ticket instanceof InboundTurn ? ticket : undefined;
    try {
      this.receiveOwnSendEcho(id, engine, message, turn);
    } finally {
      turn?.drop();
    }
  }

  /** {@link handleOwnSendEcho} with the ticket resolved; every early return leaves the ticket to be dropped. */
  private receiveOwnSendEcho(id: string, engine: IWhatsAppEngine, message: IncomingMessage, turn?: InboundTurn): void {
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
    this.touchLastActive(id, engine);
    // As on the inbound path, one delivered deleted reaches the hooks with no content.
    const messageData = message.type === 'revoked' ? deletedPlaceholder(message) : { ...message };
    delete messageData.originalBody;
    const engineIdentity = engineIdentityOf(message);

    const onFailure = (err: unknown): null => {
      this.logger.error(`onMessageCreate handler failed for ${id}`, String(err));
      return null;
    };
    // The commit may wait behind a slow earlier message of the chat; a revoke, edit or ack of this
    // send landing meanwhile is recorded here and applied once the row is written. Like the inbound
    // path, the entry follows the chain's rewrites, so a quote carries what the row will hold.
    const inFlightKey = `${id}:${message.id}`;
    const inFlight = turn
      ? Object.assign(turn.entry, { ref: turn.entry.ref ?? refOf(messageData) })
      : this.trackInFlight(inFlightKey, messageData);
    const delivery = {
      entry: inFlight,
      body: message.originalBody ?? message.body,
      edited: message.originalBody !== undefined,
    };
    const quoteOwner = {};
    // Execute hook for message sent - plugins can modify or stop processing. Like the inbound path,
    // the hook chain runs concurrently and the commit waits its turn on the chat's queue.
    const prepared = this.startHookChain(id, engine, turn, messageData, delivery, quoteOwner, async messageData => {
      await this.hookManager?.waitForPendingEchoOriginSends?.(id);
      if (messageData.id && this.hookManager?.consumeEchoOrigin?.(id, messageData.id)) {
        this.logger.warn(
          `Hook re-entrancy blocked: message:sent echo suppressed for ${messageData.id} (session: ${id})`,
        );
        return messageData;
      }
      const identity = identityOf(messageData);
      let held = messageData;
      const { data } = await this.hookManager.execute('message:sent', messageData, {
        sessionId: id,
        source: 'Engine',
        accept: data => {
          if (!isMessagePayload(data)) return false;
          held = data;
          if (delivery.entry.quoteOwner === quoteOwner) delivery.entry.quote = quoteOf(data);
          return true;
        },
      });
      return this.messageOrLastHeld(id, 'message:sent', data, held, identity);
    }).catch(onFailure);
    this.commitInTurn(id, message, turn, async () => {
      try {
        const finalMessage = await prepared;
        if (finalMessage) await this.commitOwnSendEcho(id, engine, finalMessage, delivery.entry, engineIdentity);
      } catch (err) {
        onFailure(err);
      } finally {
        this.clearQuote(delivery.entry, quoteOwner);
        if (!turn) this.untrackInFlight(inFlightKey, inFlight);
      }
    });
  }

  /** Per-chat, in-order stage of {@link handleOwnSendEcho}: persist, then dispatch `message.sent`. */
  private async commitOwnSendEcho(
    id: string,
    engine: IWhatsAppEngine,
    finalMessage: InboundMessageData,
    entry: InFlightEntry,
    identity: EngineEnvelope,
  ): Promise<void> {
    // `continue: false` is not read here, for the same reason as the message:received path
    // above: the send has already happened, so a plugin can stop the handler chain but cannot
    // un-send it. Skipping the persist below dropped the operator's own outgoing message from
    // history and from `message.sent` webhooks.

    // Persist the outgoing message so local history reflects sends composed on a linked phone
    // (message_create is the ONLY event those produce). It also fires for API-originated sends,
    // which the REST send path persists itself; the UNIQUE(sessionId, waMessageId) index is
    // the atomic dedup oracle between the two writers: the loser skips its insert, and
    // persistSentState additionally drops its redundant PENDING row when the echo won. The
    // webhook/WS dispatch below is identical whether the insert won, lost, or failed: the
    // message.sent contract is unchanged.
    await this.waitForInFlightChanges(id, finalMessage.id);
    if (!this.engines.isLive(id, engine)) return;
    const outgoing: IncomingMessage = finalMessage;
    const metadata = buildMessageMetadata(outgoing, true);

    // The ephemeral opt-out gates STORAGE only (mirrors onMessage); the live dispatch below
    // is today's contract and stays.
    const mayPersist =
      resolveFeatureFlags(this.configService).storeEphemeralMessages ||
      !(outgoing.ephemeralDuration && outgoing.ephemeralDuration > 0);

    // An echo row is outgoing and keeps no author whatever a hook says: only its chat, `from` and `to` can differ.
    const engineRef = engineRefFor(
      { chatId: identity.chatId, direction: MessageDirection.OUTGOING },
      { chatId: outgoing.chatId, direction: MessageDirection.OUTGOING },
      endsRewritten(identity, outgoing),
    );
    let rowMarked = false;
    let prepared: PreparedWebhookDelivery[] | undefined;
    let openedDeliveries: PreparedWebhookDelivery[] | undefined;
    let preparedSnapshot: InFlightMutationSnapshot | undefined;
    let preparedCommitted = false;
    let dupPrepared = false;
    let retriedDup = false;
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
        engineRef,
      });
      // The hook chain above is async; a delete()/teardown can retire this engine while it
      // awaits. Re-check liveness so a late continuation can't persist an orphan row
      // (mirrors onMessage).
      if (!this.engines.isLive(id, engine)) return;
      let insertedCleared = this.applyHeldChanges(dbMessage, entry);
      let lookupFailed = false;
      if (this.canTransactWithOutbox()) {
        const prep = await this.prepareTransactionalDeliveries(
          id,
          engine,
          'message.sent',
          outgoing,
          entry,
          dbMessage,
          insertedCleared,
        );
        if (prep.stale) return;
        insertedCleared = prep.insertedCleared;
        lookupFailed = prep.failed;
        if (!lookupFailed) {
          prepared = prep.prepared;
          preparedSnapshot = prep.snapshot;
        }
      }
      // A unique violation means the REST send path already persisted this API-originated
      // send: the dedup oracle working as intended, not an error. Any other failure (after the
      // one transient retry) fails open, so a real send is never dropped on a DB fault. Webhooks
      // that could not be read do not cost the row either: it is inserted with no outbox row, as
      // on the inbound path, and the live dispatch below reads them again.
      const deliveries = lookupFailed ? [] : prepared;
      const outcome = await this.insertWithRetry(id, engine, dbMessage, 'outgoing', deliveries, async () => {
        await this.waitForInFlightChanges(id, outgoing.id);
        insertedCleared = this.applyHeldChanges(dbMessage, entry) || insertedCleared;
      });
      await this.waitForInFlightChanges(id, outgoing.id);
      const engineMessage = { ...identity, id: outgoing.id };
      const claim = claimOf(identity);
      if (!this.engines.isLive(id, engine)) {
        await this.settleOnRetire(id, 'message.sent', outgoing, entry, outcome, prepared, identity);
        return;
      }
      if (outcome.landed === 'stale') return;
      // The REST writer may have won either attempt; its row still takes the echo's pending changes.
      if (outcome.landed === 'dup') {
        retriedDup = outcome.retried;
        dupPrepared = prepared !== undefined;
        this.applyChangesMadeInFlight(id, engineMessage, entry, false, claim);
        // A delivery that came deleted clears that row, as a revoke does, once the row proves to be the message.
        if (outgoing.type === 'revoked') void this.recordRevoke(id, outgoing.id, claim);
        // That row may be older than this delivery and edited since, the edit still being written: announced once the
        // changes queued for the message have run, with the mark they left.
        rowMarked = await new Promise<boolean>(resolve =>
          this.enqueueMessageMutation(id, outgoing.id, async () => {
            await this.replaceForwardPlaceholder(id, dbMessage, claim, entry);
            const marked = this.markedEdited.get(id)?.has(outgoing.id) === true;
            const foreign = marked && (await this.mutationProjector.foreignRowReason(id, outgoing.id, claim));
            resolve(marked && !foreign);
          }),
        );
      }
      if (outcome.landed === 'yes') {
        if (prepared !== undefined && !outcome.rowOnly) {
          openedDeliveries = outcome.openedDeliveries ?? [];
          preparedCommitted = true;
        }
        // The id had no row, so a mark remembered for it was of a row removed since.
        this.markedEdited.get(id)?.delete(outgoing.id);
        this.applyChangesMadeInFlight(id, engineMessage, entry, insertedCleared, undefined, false, dbMessage);
        // Fire-and-forget, mirroring onMessage: plugin providers (search etc.) see phone-
        // composed sends exactly like API sends.
        void this.hookManager
          .execute(
            'message:persisted',
            { sessionId: id, message: persistedRow(dbMessage) },
            { sessionId: id, source: 'SessionService' },
          )
          .catch(() => undefined);

        // Archive this send's media, mirroring onMessage. This is the ONLY path a phone-composed
        // send takes, so the REST-side chokepoint would never see it. Opt-in twice over
        // (CHAT_MEDIA_ARCHIVE_ENABLED + _OUTBOUND) and a no-op otherwise; archive() itself
        // refuses a row that is already archived, so the REST writer racing us costs at most one
        // duplicate file write, which archive() deletes because the first pointer wins.
        if (this.configService?.get<boolean>('chatMedia.archiveOutbound', false) === true) {
          void this.chatMediaArchive?.archive(dbMessage).catch(() => undefined);
        }
      }
      // A commit can land before its error and the row stored alone after it fail: that row, if it is the
      // message's, still takes the changes that arrived in flight.
      if (outcome.landed === 'failed') {
        this.keepReceivedRow(id, dbMessage, 'outgoing', outcome.error);
        this.applyChangesMadeInFlight(id, engineMessage, entry, false, claim);
      }
    }

    if (!this.engines.isLive(id, engine)) {
      if (preparedCommitted && openedDeliveries?.length) {
        if (entry?.revokeAnnounced) {
          await this.webhookService.cancelPreparedDeliveries?.(openedDeliveries);
        } else if (entry?.revoked) {
          await this.webhookService.reconcilePreparedDeliveries?.(
            openedDeliveries,
            id,
            'message.sent',
            deletedPlaceholder(outgoing),
            openedDeliveries,
            undefined,
            engineRef,
          );
        }
      } else if (retriedDup) {
        const predicate = this.ownCopiesPredicate(finalMessage, engineRef);
        if (entry?.revokeAnnounced) {
          await this.webhookService.closePendingDeliveriesForMessage?.(id, finalMessage.id, predicate);
        } else if (entry?.revoked) {
          await this.webhookService.redactPendingDeliveriesForMessage?.(id, finalMessage.id, predicate);
        }
      }
      return;
    }
    const sent = this.withChangesMadeInFlight(finalMessage, entry, rowMarked);
    const currentSnap = snapshotInFlight(entry, rowMarked);
    if (!sent) {
      if (preparedCommitted && openedDeliveries?.length) {
        await this.webhookService.cancelPreparedDeliveries?.(openedDeliveries);
      } else if (retriedDup) {
        await this.webhookService.closePendingDeliveriesForMessage?.(
          id,
          finalMessage.id,
          this.ownCopiesPredicate(finalMessage, engineRef),
        );
      }
      return;
    }
    if (preparedCommitted) {
      if (preparedSnapshot && sameInFlightSnapshot(preparedSnapshot, currentSnap)) {
        if (prepared && prepared.length > 0) void this.webhookService.dispatchPreparedDeliveries(prepared);
      } else {
        const reconciled = await this.webhookService.reconcilePreparedDeliveries(
          prepared ?? [],
          id,
          'message.sent',
          sent,
          openedDeliveries,
          undefined,
          engineRef,
        );
        if (reconciled.length > 0) void this.webhookService.dispatchPreparedDeliveries(reconciled);
      }
    } else if (dupPrepared && prepared !== undefined) {
      if (preparedSnapshot && sameInFlightSnapshot(preparedSnapshot, currentSnap)) {
        if (prepared.length > 0) {
          await this.webhookService.openPreparedDeliveries(prepared);
          void this.webhookService.dispatchPreparedDeliveries(prepared);
        }
      } else if (retriedDup) {
        const reconciled = await this.webhookService.reconcilePreparedDeliveries(
          prepared,
          id,
          'message.sent',
          sent,
          undefined,
          undefined,
          engineRef,
        );
        if (reconciled.length > 0) void this.webhookService.dispatchPreparedDeliveries(reconciled);
      } else {
        this.dispatchMessage(id, 'message.sent', sent, engineRef);
      }
    } else {
      this.dispatchMessage(id, 'message.sent', sent, engineRef);
    }
    // Emit real-time event to WebSocket clients (as message.sent, not message.received)
    this.eventsGateway.emitMessageSent(id, sent);
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleMessageAck(
    id: string,
    engine: IWhatsAppEngine,
    messageId: string,
    status: DeliveryStatus,
    chatId?: string,
  ): void {
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
    const inFlight = this.inboundInFlight.get(`${id}:${messageId}`);
    // Baileys relays a peer's receipt under the peer's chat with every id it lists, unchecked, so a receipt that
    // names a chat is held to the message it names before it changes or announces anything. An id that embeds its
    // chat, as whatsapp-web.js serializes them, cannot name another chat's message.
    const receiptChat = chatId && !messageId.includes('@') ? chatId : undefined;
    if (receiptChat && inFlight?.ref && receiptTargetsForeignRow(inFlight.ref, receiptChat)) {
      this.logForeignReceipt(id, messageId, receiptChat);
      return;
    }
    if (messageStatus && inFlight) {
      // A message not written yet (its commit waits behind an earlier one of the chat) keeps the
      // furthest ack per chat for when its row lands; the UPDATEs below would match nothing.
      const acks = (inFlight.acks ??= new Map<string, MessageStatus>());
      const chat = receiptChat ?? '';
      const parked = acks.get(chat);
      if (!parked || ackStatusTransitionFrom(messageStatus).includes(parked)) acks.set(chat, messageStatus);
    }

    const logNoop = (): void =>
      this.logger.debug(`Message ack ${messageId}: no status row advanced to ${messageStatus} (${status})`, {
        sessionId: id,
        messageId,
        status,
        action: 'message_ack_noop',
      });

    // Kept with the message's changes, which advance it once the database answers: the row is read naming no chat, and
    // the receipt judged against it as receiptVerdict judges one (advanceKeptAcks).
    const keepAck = (error: unknown): Promise<void> | undefined => {
      if (!messageStatus) return undefined;
      const chat = receiptChat ?? '';
      const acks: AckSlot = { judge: { kind: 'reaction', chatId: '' }, acks: new Map([[chat, messageStatus]]) };
      return this.parkChange(id, messageId, { acks }, error);
    };
    const onAckError = (err: unknown): Promise<void> | void =>
      isDatabaseUnavailable(err)
        ? keepAck(err)
        : this.logger.error(`Failed to advance ack for ${messageId}`, String(err));

    // The send's row takes the id only once its SENT write, which the database refused, runs again: the ack is kept
    // with the message's changes, which run after that write, on its first try or on its retry.
    const keepForSend = (): Promise<void> | undefined =>
      this.rowPending(id, messageId) ? keepAck(new Error('The row of the send is not written yet')) : undefined;
    const advance = (first: () => Promise<number>, retry: () => Promise<number> = first): Promise<void> =>
      first()
        .then(affected => {
          if (affected > 0) return;
          const kept = keepForSend();
          if (kept) return kept;
          // affected:0 — most likely the send's 2nd save (which writes waMessageId) hasn't committed
          // yet, so the row isn't matchable. Each ack is one-shot (WhatsApp won't necessarily resend),
          // so retry ONCE after a short delay to close that race rather than leave it stuck at SENT.
          const timer = setTimeout(() => {
            void retry()
              .then(retried => {
                if (retried === 0) return keepForSend() ?? logNoop();
              })
              .catch(onAckError);
          }, ACK_RECONCILE_DELAY_MS);
          timer.unref?.();
        })
        .catch(onAckError);

    // One ack payload, emitted identically over the socket and the webhook so a client coded
    // against either channel sees the same shape. `id` mirrors the field every other message.*
    // event carries (and the idempotency-key resolver reads). `ack` is a deprecated legacy field
    // kept for backward compatibility — new consumers should read the neutral `status`. `chatId`
    // rides along when the engine's update names the chat, so a webhook `chatId` condition scopes
    // ack and failure events to that chat instead of suppressing them outright.
    const ackPayload = {
      id: messageId,
      messageId,
      status,
      ack: deliveryStatusToAck(status),
      ...(chatId ? { chatId } : {}),
    };

    const announce = (): void => {
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
    };

    if (!receiptChat) {
      if (messageStatus) void advance(() => this.advanceAck(id, messageId, messageStatus));
      announce();
      return;
    }
    this.enqueueMessageMutation(id, messageId, async () => {
      let verdict: Awaited<ReturnType<MessageProjector['receiptVerdict']>>;
      try {
        verdict = await this.receiptVerdict(id, messageId, receiptChat, inFlight);
      } catch (error) {
        // The row could not be read: the receipt goes out, and its status is kept to be judged once the database answers.
        if (!this.engines.isLive(id, engine)) return;
        announce();
        return keepAck(error);
      }
      if (verdict === 'foreign' || !this.engines.isLive(id, engine)) return;
      announce();
      if (!messageStatus) return;
      const target = messageStatus;
      // A row the verdict did not see is advanced by the retry, which judges it again once it is written, and for a
      // message still in flight by its insert, with the status parked above, which the insert judges by its chat too.
      const judged = async (): Promise<number> =>
        (await this.receiptVerdict(id, messageId, receiptChat, inFlight)) === 'stored'
          ? this.advanceAck(id, messageId, target)
          : 0;
      await advance(
        verdict === 'stored' ? () => this.advanceAck(id, messageId, target) : () => Promise.resolve(0),
        judged,
      );
    });
  }

  /**
   * What the stored row says of a receipt naming `chatId`: absent, the row it may advance, or a row of another chat.
   * Without a row, a message still in flight (`inFlight`, or the entry held now) is judged by the chat it will be
   * written under, and is absent unless that proves the receipt foreign.
   * A row that cannot be read for a reason of its own reads as absent, so the receipt goes out and its retry judges
   * again; one the database could not answer for rejects, so the caller keeps the receipt's status for when it does.
   */
  private async receiptVerdict(
    id: string,
    messageId: string,
    chatId: string,
    inFlight?: InFlightEntry,
  ): Promise<'absent' | 'stored' | 'foreign'> {
    try {
      const row = await this.messageRepository.findOne({
        where: { sessionId: id, waMessageId: messageId },
        select: { chatId: true, direction: true, author: true, engineRef: true },
      });
      const ref = row ?? (this.inboundInFlight.get(`${id}:${messageId}`) ?? inFlight)?.ref;
      if (!ref) return 'absent';
      const foreign = await receiptTargetsForeignRowPersisted(
        ref,
        chatId,
        this.lidMappingStore ? jid => this.lidMappingStore!.findPhoneForLid(jid) : undefined,
      );
      if (!foreign) return row ? 'stored' : 'absent';
      this.logForeignReceipt(id, messageId, chatId);
      return 'foreign';
    } catch (error) {
      if (isDatabaseUnavailable(error)) throw error;
      return 'absent';
    }
  }

  private logForeignReceipt(id: string, messageId: string, chatId: string): void {
    this.logger.warn('Dropping a receipt that names a message of another chat', {
      sessionId: id,
      messageId,
      chatId,
      action: 'message_ack_foreign_chat',
    });
  }

  /**
   * Engine callback body for one recipient's receipt (Baileys group and status messages). Nothing is
   * stored: the event is forwarded as is, over the socket and the webhook with the same shape. `id`
   * mirrors the other message.* events (and is what the idempotency-key resolver reads); `chatId` lets
   * webhook chatId filters scope it.
   */
  handleMessageReceipt(id: string, engine: IWhatsAppEngine, event: MessageReceiptEvent): void {
    if (!this.engines.isLive(id, engine)) return;
    const payload = {
      id: event.messageId,
      messageId: event.messageId,
      chatId: event.chatId,
      participant: event.participant,
      status: event.status,
      timestamp: event.timestamp,
    };
    this.eventsGateway.emitMessageReceipt(id, payload);
    void this.webhookService.dispatch(id, 'message.receipt', payload);
  }

  /**
   * Advance a stored message's delivery status, returning the rows changed. Scoped by sessionId:
   * waMessageId is unique per account/chat, not global, so an ack on one session must never advance a
   * same-id row in another session. The In() guard makes the UPDATE forward-only (a late/out-of-order
   * ack can't downgrade) and idempotent on retry.
   */
  private advanceAck(
    id: string,
    messageId: string,
    messageStatus: MessageStatus,
    target: FindOptionsWhere<Message> = { sessionId: id, waMessageId: messageId },
  ): Promise<number> {
    return this.messageRepository
      .update({ ...target, status: In(ackStatusTransitionFrom(messageStatus)) }, { status: messageStatus })
      .then(result => result.affected ?? 0);
  }

  /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
  handleMessageRevoked(
    id: string,
    engine: IWhatsAppEngine,
    message: RevokedMessage,
    actor?: { fromMe: boolean; participant?: string; admin?: boolean },
  ): void {
    if (!this.engines.isLive(id, engine)) return;
    this.logger.debug(`Message revoked: ${message.id}`, {
      sessionId: id,
      messageId: message.id,
      action: 'message_revoked',
    });

    // Clear the stored message (best-effort; the message may not be in the DB). The
    // dashboard renders the localized "message deleted" text, so no display string is
    // persisted here.
    //
    // Match on `revokedId` (the ORIGINAL deleted message's id) when present: on wwebjs
    // `message.id` is the revocation notification, which never matches a stored row.
    // `revokedId` falls back to `id` (Baileys, where the two are the same).
    const revokedWaMessageId = message.revokedId ?? message.id;
    // A story is not a row of `messages`: the status store drops it, and the rest of the revoke goes on as for any chat.
    if (message.chatId === 'status@broadcast') this.removeDeletedStory(id, revokedWaMessageId, actor);
    const source: MutationSource | undefined = actor
      ? { kind: 'revoke', chatId: message.chatId, fromMe: actor.fromMe, author: actor.participant, admin: actor.admin }
      : undefined;
    const apply = (): void => {
      void this.recordRevoke(id, revokedWaMessageId, source, true);

      // Notify consumers regardless of whether the row existed: webhook (message.revoked
      // is a declared event) + the real-time dashboard stream.
      const revokedPayload = message as unknown as Record<string, unknown>;
      void this.webhookService.dispatch(id, 'message.revoked', revokedPayload);
      this.eventsGateway.emitMessageRevoked(id, revokedPayload);
    };
    // whatsapp-web.js reports only what WhatsApp Web itself accepted, so it passes no actor and is applied at
    // once: its ids name the chat, so no row of another chat can hold the id. An engine that applies no
    // validation to a revoke says who made it, and the stored row says whose message it names: a revoke the
    // row proves foreign is dropped, announcement included.
    if (!source) {
      apply();
      return;
    }
    void this.changeInFlight(id, revokedWaMessageId, source, (needsRow, inFlight) => {
      if (inFlight && !needsRow) {
        this.holdRevoked(id, inFlight);
        inFlight.revokeAnnounced = true;
      }
      void this.mutationProjector.storedRowVerdict(id, revokedWaMessageId, source).then(verdict => {
        if (!this.engines.isLive(id, engine)) return;
        if (verdict.reason || (needsRow && !verdict.exists)) {
          if (verdict.reason) {
            this.logger.warn('Dropping a revoke aimed at a message of another chat or sender', {
              sessionId: id,
              messageId: revokedWaMessageId,
              reason: verdict.reason,
            });
          }
          return;
        }
        apply();
      });
    });
  }

  /** History backfill persist, extracted to message-history-projector.ts (stateless function). */
  persistHistoryMessages(id: string, engine: IWhatsAppEngine, messages: IncomingMessage[]): Promise<IncomingMessage[]> {
    return persistHistoryMessages(
      this.messageRepository,
      this.configService,
      id,
      messages,
      this.logger,
      () => this.engines.isLive(id, engine),
      row => {
        if (!this.engines.isLive(id, engine)) return;
        void this.hookManager
          .execute('message:persisted', { sessionId: id, message: row }, { sessionId: id, source: 'SessionService' })
          .catch(() => undefined);
      },
      this.lidMappingStore ? jid => this.lidMappingStore!.findPhoneForLid(jid) : undefined,
    );
  }

  /** Reaction apply, queued on the per-message mutation chain — see MessageMutationProjector. */
  applyReactionQueued(id: string, event: ReactionEvent): void {
    void this.changeInFlight(id, event.messageId, { kind: 'reaction', chatId: event.chatId }, (needsRow, entry) => {
      if (entry && !needsRow) (entry.reactions ??= {})[event.senderId] = event.reaction ?? '';
      this.mutationProjector.applyReactionQueued(id, event, needsRow);
    });
  }

  /** Edit apply, queued on the per-message mutation chain. */
  applyMessageEditQueued(id: string, message: EditedMessage): void {
    const source = { kind: 'edit', chatId: message.chatId, fromMe: message.fromMe, author: message.author } as const;
    void this.changeInFlight(id, message.messageId, source, (needsRow, entry) => {
      // Deleted before its row was written, for everyone or through a REST delete for this account only: the row will
      // be stored cleared, so the edit is neither held nor announced. Once the row exists, applyMessageEdit refuses a
      // revoked one itself.
      if (entry && !needsRow && entry.revoked) return;
      if (entry && !needsRow) this.holdEdit(entry, message.body);
      this.mutationProjector.applyMessageEditQueued(id, message, needsRow);
    });
  }

  /**
   * Keep changes in arrival order while a cross-form identity waits for a reported directory pairing.
   * This chain only prepares changes; it never waits for a row write or for the message's commit.
   * Exact identities retain their synchronous path until a preceding change needs that lookup.
   */
  private changeInFlight(
    id: string,
    messageId: string,
    source: MutationSource | undefined,
    ready: (needsRow: boolean, entry?: InFlightEntry) => void,
  ): void | Promise<void> {
    const key = `${id}:${messageId}`;
    const entry = this.inboundInFlight.get(key);
    const foreign = entry?.ref && source?.chatId ? mutationTargetsForeignRow(entry.ref, source) : null;
    if (!entry?.changes?.pending && (!foreign || !this.lidMappingStore)) {
      ready(foreign !== null, entry);
      return;
    }
    const changes = (entry!.changes ??= {});
    const ref = entry!.ref;
    const engine = this.engines.get(id);
    const pending = (changes.pending ?? Promise.resolve())
      .then(async () => {
        if (this.engines.get(id) !== engine) return;
        const current = this.inboundInFlight.get(key);
        if (current?.changes !== changes || current.ref !== ref) return;
        const reason =
          current.ref && source?.chatId
            ? await mutationTargetsForeignRowPersisted(
                current.ref,
                source,
                this.lidMappingStore ? jid => this.lidMappingStore!.findPhoneForLid(jid) : undefined,
              )
            : null;
        // A repeated delivery may replace the entry while the lookup awaits; only its shared identity
        // and change chain may inherit the result. A new engine must never inherit an old callback.
        const target = this.inboundInFlight.get(key);
        if (this.engines.get(id) !== engine || target?.changes !== changes || target.ref !== ref) return;
        ready(reason !== null, target);
      })
      .catch(err => {
        this.logger.warn('Unable to prepare a change for an arriving message', { error: String(err) });
      });
    changes.pending = pending;
    void pending.finally(() => {
      if (changes.pending === pending) delete changes.pending;
    });
    return pending;
  }

  /** Drain only identity checks already queued for this message, including changes arriving during a check. */
  private waitForInFlightChanges(id: string, messageId: string): Promise<void> | undefined {
    const key = `${id}:${messageId}`;
    if (!this.inboundInFlight.get(key)?.changes?.pending) return;
    return (async () => {
      let pending: Promise<void> | undefined;
      while ((pending = this.inboundInFlight.get(key)?.changes?.pending)) await pending;
    })();
  }

  /** Queue a message-scoped mutation. A failed operation is isolated so later events still run. */
  enqueueMessageMutation(id: string, messageId: string, work: () => Promise<void>): void {
    this.mutationProjector.enqueueMessageMutation(id, messageId, work);
  }

  /** Stored-row update for a REST outbound edit, on the same mutation chain — see MessageMutationProjector. */
  recordOutboundMessageEdit(
    sessionId: string,
    messageId: string,
    body: string,
    source?: MutationSource,
  ): Promise<void> {
    let stored: Promise<void> | undefined;
    const pending = this.changeInFlight(sessionId, messageId, source, (needsRow, entry) => {
      if (entry && !needsRow) {
        this.holdEdit(entry, body);
        entry.edited = true;
      }
      stored = this.mutationProjector.recordOutboundMessageEdit(sessionId, messageId, body, source);
    });
    return Promise.resolve(pending).then(() => stored);
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
