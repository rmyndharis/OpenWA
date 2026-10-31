import { KeyedMutationQueue } from '../../common/utils/keyed-mutation-queue';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WACallEvent, WAMessage, WAMessageKey, WASocket } from '@whiskeysockets/baileys';
import {
  Contact,
  EditedMessage,
  EngineEventCallbacks,
  EventResponseEvent,
  GroupEvent,
  IncomingCallEvent,
  InboundReceipt,
  InboundTicket,
  ParticipantPresence,
  PresenceState,
  CallOutcome,
  IncomingMessage,
  MessageReceiptEvent,
  MessageReceiptStatus,
  MessageType,
  ReactionEvent,
  RevokedMessage,
} from '../interfaces/whatsapp-engine.interface';
import {
  BAILEYS_NON_CONTENT_TYPES,
  baileysChatJid,
  buildIncomingMessageFromBaileys,
  extractBaileysBody,
  extractBaileysButtonReply,
  extractBaileysButtons,
  extractBaileysCommerce,
  extractBaileysPoll,
  extractBaileysContext,
  extractBaileysLocation,
  isBaileysCatalogShare,
  keyParticipant,
  mapBaileysEventResponseType,
  mapBaileysStatus,
  setBaileysText,
} from './baileys-message-mapper';
import { buildEditedMessage } from './message-mapper';
import { toUnixSeconds } from './baileys-history';
import { bytesOf, decryptSecretPayload, messageSecretOf, senderForms, withoutDevice } from './baileys-secret-payload';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import {
  admitInboundSafely,
  capInboundMedia,
  coerceDeclaredSize,
  inboundMediaMaxBytes,
  inboundMediaTimeoutMs,
  isMediaDownloadEnabled,
  runUnderGlobalMediaGate,
  withInboundDownloadTimeout,
} from './inbound-media-cap';
import type { Dispatcher } from 'undici';
import type { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { type createLogger } from '../../common/services/logger.service';
import { createSilentLogger } from './baileys-logger';
import { BAILEYS_QUERY_BUDGET_MS, withQueryDeadline } from './baileys-query-deadline';
import { chatKind, parseWaId, userPart, type ChatKind } from '../identity/wa-id';

/**
 * Inbound event handling extracted from BaileysAdapter: the socket event handlers
 * (messages/groups/calls), inbound message processing with media capping, and the live-call
 * cache behind rejectCall. The adapter rebinds `sock.ev.on(...)` to these handlers and keeps
 * `rejectCall` as a thin forwarder (it is a public IWhatsAppEngine method), injecting this
 * narrow host surface via closures so the delegate never touches lifecycle state directly.
 */
/**
 * The call statuses that mean something to a consumer. Everything else Baileys emits — `ringing`,
 * `preaccept`, `transport`, `relaylatency` — is transport chatter, and `terminate` is ambiguous
 * (see reportCallOutcome), so neither is mapped.
 */
const CALL_OUTCOMES: Readonly<Partial<Record<string, CallOutcome>>> = {
  accept: 'accepted',
  reject: 'rejected',
  timeout: 'missed',
};

/** The slice of Baileys' PresenceData this adapter reads. */
interface RawPresence {
  lastKnownPresence?: PresenceState;
  lastSeen?: number;
  groupOnlineCount?: number;
}

/**
 * The states Baileys can report. Checked rather than trusted: the value crosses a library boundary
 * and lands straight in a public webhook payload, so an unknown state added upstream must be dropped
 * here rather than published as if this gateway understood it.
 */
const PRESENCE_STATES: ReadonlySet<PresenceState> = new Set<PresenceState>([
  'available',
  'unavailable',
  'composing',
  'recording',
  'paused',
]);

/**
 * The chats a per-recipient receipt is reported for: the two Baileys raises message-receipt.update for, and the
 * only ones message.receipt is documented for. A 1:1 chat reports through messages.update instead.
 */
const RECEIPT_CHAT_KINDS: ReadonlySet<ChatKind> = new Set<ChatKind>(['group', 'status']);

/**
 * Top-level Message keys that carry no user content. A live message made only of these is dropped;
 * messageContextInfo rides along on real content too, so on its own it is not enough to drop.
 */
const PROTOCOL_NOISE_KEYS: ReadonlySet<string> = new Set([
  'senderKeyDistributionMessage',
  'fastRatchetKeySenderKeyDistributionMessage',
  'messageContextInfo',
  'messageHistoryNotice',
  'messageHistoryBundle',
]);

/**
 * Whether two ids provably name different chats or people. Each side is a jid plus the other-dialect
 * twin WhatsApp may send beside it (`remoteJidAlt`, `participantAlt`), compared neutralised, so a lid
 * the session can resolve matches its phone number. A lid it cannot resolve may still be the phone
 * number on the other side, so that pair is never called different, and neither is a side with no id:
 * a caller that drops on a mismatch fails open.
 */
export function differentWaIds(
  a: ReadonlyArray<string | null | undefined>,
  b: ReadonlyArray<string | null | undefined>,
  toNeutralJid: (jid: string) => string,
): boolean {
  const x = a.filter((j): j is string => !!j).map(toNeutralJid);
  const y = b.filter((j): j is string => !!j).map(toNeutralJid);
  if (!x.length || !y.length || x.some(j => y.includes(j))) return false;
  const lidGap = (p: string[], q: string[]): boolean =>
    p.some(j => j.endsWith('@lid')) && !q.some(j => j.endsWith('@lid')) && q.some(j => j.endsWith('@c.us'));
  return !lidGap(x, y) && !lidGap(y, x);
}

/**
 * Whether the media node Baileys' downloadMediaMessage would fetch is served from WhatsApp's media
 * hosts. Baileys builds the address from the message as the sender composed it (`url`, or
 * `https://<host of url>` + `directPath`) and fetches it with no host check of its own, so anything
 * outside https://*.whatsapp.net on the default port is refused here. The node and the address are
 * resolved exactly as rc14's downloadMediaMessage and downloadContentFromMessage resolve them.
 */
export function isWhatsAppMediaSource(
  b: Pick<typeof BaileysLib, 'extractMessageContent' | 'getContentType'>,
  message: WAMessage['message'],
): boolean {
  const content = b.extractMessageContent(message);
  const type = content ? b.getContentType(content) : undefined;
  const media: unknown = type ? content?.[type] : undefined;
  // Baileys refuses a node like this itself, before any fetch.
  if (!media || typeof media !== 'object') return true;
  const node = media as { url?: string | null; directPath?: string | null; thumbnailDirectPath?: string | null };
  const thumbnailOnly = 'thumbnailDirectPath' in media && !('url' in media);
  const url = thumbnailOnly ? undefined : node.url;
  const directPath = thumbnailOnly ? node.thumbnailDirectPath : node.directPath;
  let host = 'mmg.whatsapp.net';
  try {
    if (url) host = new URL(url).host;
  } catch {
    // Baileys falls back to its default host for an unparsable url.
  }
  const target = directPath ? `https://${host}${directPath}` : url;
  if (!target) return true;
  try {
    const parsed = new URL(target);
    return (
      parsed.protocol === 'https:' &&
      parsed.port === '' &&
      (parsed.hostname === 'whatsapp.net' || parsed.hostname.endsWith('.whatsapp.net'))
    );
  } catch {
    return false;
  }
}

const BAILEYS_MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'ptvMessage',
  'audioMessage',
  'documentMessage',
  'documentWithCaptionMessage',
  'stickerMessage',
]);

/** Whether a normalized content type carries a downloadable payload. */
function isBaileysMediaType(contentType: string | undefined): boolean {
  return contentType !== undefined && BAILEYS_MEDIA_TYPES.has(contentType);
}

/** The media sub-message of normalized content: its mimetype and declared size. */
function mediaSubMessage(normalized: NonNullable<WAMessage['message']>) {
  return (
    normalized.imageMessage ??
    normalized.videoMessage ??
    normalized.ptvMessage ??
    normalized.audioMessage ??
    normalized.documentMessage ??
    normalized.stickerMessage
  );
}

export interface BaileysEventsHost {
  /** Live socket handle for media re-upload requests (inbound media download). */
  getSocket(): WASocket;
  /** Raw socket handle, null before connect — rejectCall must tell "not connected" apart from a live socket. */
  getSocketOrNull(): WASocket | null;
  readonly logger: ReturnType<typeof createLogger>;
  toNeutralJid(jid: string): string;
  normalizedSelfJid(): string;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  loadLib(): Promise<typeof BaileysLib>;
  /** Session proxy dispatcher for the media download; undefined = direct. */
  getFetchDispatcher(): Dispatcher | undefined;
  /** The adapter's inbound media download gate (shared so the bound holds across all inbound paths). */
  readonly inboundLimiter: ConcurrencyLimiter;
  /** Learn any lid->pn pair a message key carries (also writes through to the persistent table). */
  recordKeyLidMappings(
    key: Pick<WAMessageKey, 'remoteJid' | 'remoteJidAlt' | 'participant' | 'participantAlt' | 'fromMe'>,
  ): void;
  /** Seed the chat's last-message preview + sort time from an inbound message. */
  recordMessage(msg: WAMessage, type?: MessageType, order?: number): void;
  /** Reserve a message's place in the observed order on arrival, ahead of any limiter, store or media wait. */
  nextMessageOrder?(): number;
  /** Apply a message edit to the chat preview, when `accept` (if given) accepts the key the preview holds. */
  recordMessageEdit(
    chatId: string,
    messageId: string,
    text: string,
    type?: MessageType,
    accept?: (key: WAMessageKey) => boolean,
  ): void;
  findPersistedLidPhone?(jid: string): Promise<string | null>;
  /** Persist an inbound message to the store; undefined when no store is configured. */
  putStoredMessage(msg: WAMessage): Promise<void> | undefined;
  /** Rewrite a stored message in place (see BaileysMessageStore.update); undefined without a store. */
  updateStoredMessage(messageId: string, change: (stored: WAMessage) => WAMessage | null): Promise<void> | undefined;
  /**
   * True exactly once for the id of a message this session sent through the API, whose library echo
   * is arriving; false for anything the session did not send (see OwnSendRegistry).
   */
  consumeOwnSend(id: string | null | undefined): boolean;
  /** Delete a stored message while `shouldRemove` accepts the copy held then; undefined without a store. */
  removeStoredMessage(messageId: string, shouldRemove: (stored: WAMessage) => boolean): Promise<void> | undefined;
  /** A message this session already delivered or sent, from the persistent store; undefined without a store. */
  getStoredMessage(messageId: string): Promise<WAMessage | null> | undefined;
  /** The currently-registered admitInbound callback, if any (assigned at initialize()). */
  getAdmitInbound?(): EngineEventCallbacks['admitInbound'];
  /** The Baileys module once loaded (it is, before any socket exists), without waiting for it. */
  getLoadedLib?(): typeof BaileysLib | undefined;
  /** The currently-registered onMessage callback, if any (assigned at initialize()). */
  getOnMessage(): EngineEventCallbacks['onMessage'];
  /** The currently-registered onMessageCreate callback, if any (assigned at initialize()). */
  getOnMessageCreate(): EngineEventCallbacks['onMessageCreate'];
  /** The currently-registered onMessageRevoked callback, if any (assigned at initialize()). */
  getOnMessageRevoked(): EngineEventCallbacks['onMessageRevoked'];
  /** The currently-registered onMessageEdited callback, if any (assigned at initialize()). */
  getOnMessageEdited(): EngineEventCallbacks['onMessageEdited'];
  /** The currently-registered onMessageReaction callback, if any (assigned at initialize()). */
  getOnMessageReaction(): EngineEventCallbacks['onMessageReaction'];
  /** The currently-registered onMessageAck callback, if any (assigned at initialize()). */
  getOnMessageAck(): EngineEventCallbacks['onMessageAck'];
  /** The currently-registered onMessageReceipt callback, if any (assigned at initialize()). */
  getOnMessageReceipt(): EngineEventCallbacks['onMessageReceipt'];
  /** The currently-registered onGroupEvent callback, if any (assigned at initialize()). */
  getOnGroupEvent(): EngineEventCallbacks['onGroupEvent'];
  /** The currently-registered onEventResponse callback, if any (assigned at initialize()). */
  getOnEventResponse(): EngineEventCallbacks['onEventResponse'];
  /** A contact from the session's own store, by any id dialect; no network read. */
  findContact(contactId: string): Contact | null;
  /** The currently-registered onCall callback, if any (assigned at initialize()). */
  getOnCall(): EngineEventCallbacks['onCall'];
  /** The currently-registered onPresenceUpdate callback, if any (assigned at initialize()). */
  getOnPresenceUpdate(): EngineEventCallbacks['onPresenceUpdate'];
  /** The currently-registered onCallOutcome callback, if any (assigned at initialize()). */
  getOnCallOutcome(): EngineEventCallbacks['onCallOutcome'];
}

/** The subset of a Baileys `messages.update` entry this adapter reads. */
interface BaileysMessageUpdate {
  key?: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null };
  update?: { status?: number | null; eventResponses?: BaileysEventResponse[] | null };
}

/** A decrypted RSVP as Baileys re-emits it under `update.eventResponses`. */
interface BaileysEventResponse {
  eventResponseMessageKey?: WAMessageKey | null;
  senderTimestampMs?: number | { toNumber(): number } | null;
  response?: {
    response?: number | null;
    timestampMs?: number | { toNumber(): number } | null;
    extraGuestCount?: number | null;
  } | null;
}

interface LiveCallHandle {
  callFrom: string;
  expiresAt: number;
  from: string;
  isVideo: boolean;
  isGroup: boolean;
}

/** Every teardown clears the live-call map; counting those clears lets a reject in flight tell that its
 *  connection was torn down meanwhile. */
class LiveCallMap<V> extends Map<string, V> {
  clears = 0;

  override clear(): void {
    this.clears++;
    super.clear();
  }
}

/** A rejection awaiting WhatsApp: the handle it took out of the live calls, and the teardowns seen when it began. */
interface CallRejection {
  entry: LiveCallHandle;
  clears: number;
  /** A `terminate` for the call arrived meanwhile: the call is over, whatever the attempt turns out to be. */
  ended: boolean;
}

export class BaileysEvents {
  /** How long a received call's handle stays rejectable. Calls ring for roughly a minute, so
   *  two minutes covers the ringing window with margin without pinning dead calls for long. */
  private static readonly LIVE_CALL_TTL_MS = 2 * 60_000;

  /** Live incoming calls by call id, holding the raw `from` JID sock.rejectCall() needs — the
   *  call event is long gone by the time a reject arrives, so it must be cached at event time.
   *  Readonly reference, owned here; the adapter's lifecycle clears it on teardown. */
  readonly liveCalls = new LiveCallMap<LiveCallHandle>();

  /**
   * Calls whose rejection is pending. The handle is out of liveCalls meanwhile, so it cannot be rejected
   * twice, yet a signal that ends the call still finds it here and publishes its outcome. A signal that
   * publishes an outcome of its own (accept, reject, timeout), a ring of another call under the id and a
   * teardown make the rejection stale. A `terminate`, or another tag of the same call, does not: WhatsApp may
   * send the terminate that follows our own rejection before it acknowledges it.
   */
  private readonly rejections = new Map<string, CallRejection>();

  /** How many ids the record of deletes for everyone keeps before it forgets the oldest. */
  static readonly DELETED_FOR_EVERYONE_LIMIT = 5_000;

  /**
   * Inbound messages still being processed, by id, with the key and content of the latest delivery, so
   * an edit or delete of one waits for its store write, a delete can be checked against its target
   * meanwhile, and an encrypted edit finds the secret of an original that is not stored yet.
   */
  private readonly inboundInFlight = new Map<
    string,
    { key: WAMessageKey; message: WAMessage['message']; done: Promise<void> }
  >();

  /**
   * Ids of messages deleted for everyone, oldest first. The stored copy is emptied too, but that can
   * land late: a delete can overtake the original while it downloads its media, and a repeat delivery
   * can be stored after the delete was applied. Whatever the store holds meanwhile, a message named
   * here is never quoted, forwarded or reacted to, nor stored with its content. Bounded, because the
   * windows it covers close once the original's processing settles, and the store has caught up then.
   */
  private readonly deletedForEveryone = new Set<string>();

  /**
   * The latest edit of a message still being processed, by id, with the key it was sent under. The
   * edit is announced first and finds no row or preview to change, and a repeat delivery can be stored
   * after the edit was applied, so the original is stored and announced with this text instead, and
   * a quote or forward meanwhile carries it too (see pendingEditOf). `afterOtherText` says an earlier
   * edit had another text, so one of them changed the text even if this one restores it. Dropped once
   * the message's processing settles, and bounded like deletedForEveryone, which wins over it.
   */
  private readonly editedWhileInFlight = new Map<
    string,
    { envelope: WAMessageKey; body: string; afterOtherText: boolean }
  >();

  /**
   * The deliveries of an id handed to onMessage that have no outcome yet, by id: how many, and a promise
   * that settles when the last of them has one (or is let go of after OUTCOME_HOLD_MS). The stored copy
   * of such an id may be a duplicate the session is about to call another message's (the real one lives
   * in its table only), so it cannot judge a change that reads as foreign to it yet: that change waits
   * on `ended` and is judged again (see targetsForeignMessage). A hold begins when the delivery is
   * handed on. A change that arrives while the delivery is still being processed (limiter wait, repeat
   * check, media download) waits for that processing to end first.
   */
  private readonly outcomesPending = new Map<string, { count: number; ended: Promise<void>; free: () => void }>();

  /**
   * Reactions, edits and deletes that reached a message still being processed where nothing is admitted before
   * the emit (SQLite), by its id, in the order they arrived, with the timer that lets them go if the message is
   * never handed on. The session holds no entry for such a message until it is emitted, so a reaction announced
   * earlier is stored nowhere and an edit leaves no marker: they are announced right after the emit instead (see
   * announceWhenHandedOn).
   */
  private readonly changesAwaitingEmit = new Map<
    string,
    { announce: Array<() => void>; timer: ReturnType<typeof setTimeout> }
  >();

  /** How many changes wait for a delivery or its outcome (see parkUntil); the rest are judged at once. */
  private changesParked = 0;

  /**
   * How many changes wait in changesAwaitingEmit; the rest are announced at once. Counted apart from the parks,
   * so changes waiting for their message cannot make a change that has to wait for an outcome be dropped.
   */
  private changesAwaiting = 0;

  /** Up to 64 preparations keep per-message order across directory reads; later arrivals wait for room. */
  private readonly messageChanges = new KeyedMutationQueue();
  private changesPreparing = 0;
  private preparationRoom?: { ready: Promise<void>; release: () => void };
  private retirePreparations!: () => void;
  private preparationsRetired = new Promise<void>(resolve => {
    this.retirePreparations = resolve;
  });

  private static readonly CHANGES_PARKED_LIMIT = 64;

  /**
   * How many conflicting copies of an id have been removed from the store, oldest id first and bounded
   * like deletedForEveryone. A read of the store that was out while one went may have returned that
   * copy, which is not what the store holds any more (see targetsForeignMessage). Counted per id: a
   * copy removed under another id says nothing of the one a change was judged against.
   */
  private readonly copyRemovals = new Map<string, number>();

  /** How long an id stays held for the session's outcome; a receipt not settled by then is let go. */
  private static readonly OUTCOME_HOLD_MS = 5 * 60_000;

  /**
   * Bumped by fenceStoredWrites when the account is unlinked. A message stores its copy only while the
   * generation it arrived under is current: one still processing when the store is wiped (a media
   * download outlives the socket, and the limiter queue is unbounded) must not recreate a row of the
   * unlinked account afterwards.
   */
  private storeGeneration = 0;

  constructor(private readonly host: BaileysEventsHost) {}

  getStoredWriteGeneration(): number {
    return this.storeGeneration;
  }

  /** Drop the store writes of every message that arrived before now; call before wiping the store. */
  fenceStoredWrites(): void {
    this.storeGeneration++;
    const retire = this.retirePreparations;
    this.preparationsRetired = new Promise<void>(resolve => {
      this.retirePreparations = resolve;
    });
    retire();
  }

  /** Whether a delete for everyone of this message was accepted (see deletedForEveryone). */
  wasDeletedForEveryone(messageId: string): boolean {
    return this.deletedForEveryone.has(messageId);
  }

  /**
   * The text of an edit announced while this message is still being processed, when that edit may
   * change `target`, the key of the copy about to be quoted or forwarded. The stored copy catches up
   * once the processing settles, but a repeat delivery can already be stored with the old text.
   */
  pendingEditOf(messageId: string, target: WAMessageKey): string | undefined {
    const edit = this.inboundInFlight.has(messageId) ? this.editedWhileInFlight.get(messageId) : undefined;
    return edit && this.mayChange(target, edit.envelope, false) ? edit.body : undefined;
  }

  /** Record an accepted delete for everyone of this message (see deletedForEveryone). */
  markDeletedForEveryone(messageId: string): void {
    this.deletedForEveryone.add(messageId);
    if (this.deletedForEveryone.size > BaileysEvents.DELETED_FOR_EVERYONE_LIMIT) {
      const [oldest] = this.deletedForEveryone;
      this.deletedForEveryone.delete(oldest);
    }
  }

  /** Apply a history delete to the raw cache without announcing a live message event. */
  async applyHistoryRevoke(target: WAMessageKey, envelope: WAMessageKey): Promise<WAMessageKey | undefined> {
    if (!target.id) return undefined;
    const generation = this.storeGeneration;
    const found = await this.readTarget(target.id, 'checking what a history revoke targets');
    if (generation !== this.storeGeneration) return undefined;
    const original = found?.key ?? target;
    const resolve = await this.reportedPhones(original, envelope);
    if (generation !== this.storeGeneration) return undefined;
    if (!this.mayChange(original, envelope, true, resolve)) return undefined;
    if (found) this.markDeletedForEveryone(target.id);
    this.changeStoredMessage(target.id, copy =>
      this.mayChange(copy.key, envelope, true, resolve) ? { ...copy, message: null } : null,
    );
    return original;
  }

  handleMessagesUpsert(event: { messages: WAMessage[]; type: string }): void {
    for (const msg of event.messages) {
      if (!msg.message || !msg.key?.remoteJid) {
        continue; // protocol/empty messages carry no neutral content
      }
      // A receipt that arrives while this message's own upsert is still in Baileys' event buffer is merged
      // into the upsert and raised as no message-receipt.update, which the echo skip below would then drop
      // with the rest of the echo.
      if (msg.userReceipt?.length) {
        this.handleMessageReceiptUpdate(msg.userReceipt.map(receipt => ({ key: msg.key, receipt })));
      }
      // The same buffer merges a 1:1 delivery or read ack, or a rejection by the server, into the upsert as
      // `status` and raises no messages.update. What a message carries before any ack (PENDING on an echo,
      // SERVER_ACK on one the phone typed) maps to pending or sent and is not one.
      const mergedAck = this.mergedAck(msg);
      // Baileys echoes every message this session sends through the API back through this same
      // path, tagged 'append', and sendContent() already emits onMessageCreate for those via
      // emitOwnSendEcho(). WhatsApp replays what the account typed on its phone while the gateway
      // was down through the same tag (`node.attrs.offline ? 'append' : 'notify'` in Baileys'
      // messages-recv), and those the session has never seen. Nothing on the batch tells the two
      // apart except the id, which the adapter recorded when it sent: skip only what we sent, so
      // the echo cannot fire onMessageCreate twice and the phone's outage-window sends still land
      // as outgoing messages. Real history never reaches this handler; it arrives on
      // messaging-history.set and is captured dispatch-free. A re-delivered message of either
      // direction the store already holds is dropped in processInboundMessage: the projector's insert
      // oracle dedupes the inbound fan-out but runs after the message:received plugin hook, and it
      // does not gate dispatch on the own-send path at all, which is also why the echo is caught here.
      //
      // Only ids this session SENT are consumed here. Claiming every inbound fromMe id instead, to
      // close the window where two deliveries of one id arrive before the first is stored, costs
      // more than it buys: a first delivery that reports nothing (a partial decrypt arrives as
      // protocol noise and is dropped below) would claim the id, and the decryption-retry delivery
      // that carries the real body would then be swallowed as a repeat and the message lost. A
      // repeat inside that narrow window is a duplicate, which the webhook idempotency key and the
      // insert oracle both absorb; a loss is not recoverable, because Baileys acks the node before
      // it emits the upsert.
      if (msg.key.fromMe === true && this.host.consumeOwnSend(msg.key.id)) {
        // The send returned about 100 ms ago (the buffer holds the upsert that long), so the message
        // already has its row, or its entry in the projector.
        if (mergedAck) this.handleMessagesUpdate([mergedAck]);
        this.host.logger.debug('Skipping the echo of a message this session sent', {
          msgId: msg.key.id ?? 'unknown',
          type: event.type,
        });
        continue;
      }
      // An id names one message of one chat and one sender. A delivery that reuses the id of a message
      // still being processed under another chat or sender is not a repeat of it: let through, it would
      // take the id first (the row, the stored copy, and the key a delete of the first is judged by).
      const firstKey = msg.key.id ? this.inboundInFlight.get(msg.key.id)?.key : undefined;
      if (firstKey && this.namesAnotherMessage(firstKey, msg.key)) {
        this.host.logger.warn('Dropping a message that reuses the id of one still being processed', {
          msgId: msg.key.id ?? 'unknown',
          remoteJid: msg.key.remoteJid,
        });
        continue;
      }
      // Throttle through the limiter so a burst of media messages can't run unbounded parallel
      // downloads (each a full decrypted buffer in heap). Ordering stays correct — the message store
      // keeps the newest by timestamp. The queue is unbounded, so a burst parks rather than shedding
      // and the message keeps its media either way. Nothing rejects here today: the limiter is never
      // closed, and processInboundMessage handles its own failures (a media download that fails emits
      // the omitted marker rather than throwing). The catch below is a net for the day something does,
      // a closed or bounded limiter, so the message is still emitted rather than lost to an unhandled
      // rejection.
      const generation = this.storeGeneration;
      const order = this.host.nextMessageOrder?.();
      // Where the session holds a message until its row is written (PostgreSQL), admit it now, in
      // arrival order: its chat's order, and a slot of the session's room when it downloads media.
      const ticket = this.admitInbound(msg);
      const processed = this.host.inboundLimiter
        .run(yieldSlot => this.processInboundMessage(msg, { generation, order, ticket, yieldSlot }))
        .catch((error: unknown) => {
          // Names the failure rather than calling it "saturated", which used to send operators to look
          // at concurrency settings for a problem that was never there. The retry below skips the
          // limiter and processInboundMessage handles its own errors, so it cannot reject.
          const closed = error instanceof Error && error.message.startsWith('ConcurrencyLimiter closed');
          this.host.logger.warn(
            closed
              ? 'Inbound media limiter closed during teardown; emitting message without media'
              : 'Inbound media download failed; emitting message without media',
            { msgId: msg.key?.id ?? 'unknown', ...(closed ? {} : { error: String(error) }) },
          );
          return this.processInboundMessage(msg, { generation, order, skipMedia: true, ticket });
        });
      // The room stays held until the processing settles too, and a message never emitted drops its turn.
      ticket?.holdUntil(processed);
      void processed.finally(() => ticket?.drop());
      // A message the phone typed is created by that processing, and an ack that reached the projector
      // first would find nothing to advance, so it waits until the message was handed on.
      if (mergedAck) void processed.then(() => this.handleMessagesUpdate([mergedAck]));
      const id = msg.key.id;
      if (id) {
        // A repeat delivery can arrive while the first is still downloading and finish before it, so
        // a change waits for every delivery in flight, not only the latest.
        const tracked = {
          key: msg.key,
          message: msg.message,
          done: Promise.all([this.inboundInFlight.get(id)?.done, processed]).then(() => undefined),
        };
        this.inboundInFlight.set(id, tracked);
        void tracked.done.finally(() => {
          if (this.inboundInFlight.get(id) !== tracked) return;
          this.inboundInFlight.delete(id);
          // The edit's store write was chained behind this, so the store carries it (or a newer one) now.
          this.editedWhileInFlight.delete(id);
          // A change that came in after the message was handed on, while it still counted as in flight.
          this.handOverChanges(id);
        });
      }
    }
  }

  /** The ack Baileys' event buffer merged into the upsert of a message the account sent, as an update. */
  private mergedAck(msg: WAMessage): BaileysMessageUpdate | undefined {
    if (msg.key.fromMe !== true) return undefined;
    const status = mapBaileysStatus(msg.status);
    // A delivery or read ack is a 1:1 event (groups and statuses report receipts instead); the server
    // rejecting a message is reported for every kind of chat.
    const reported =
      status === 'failed' ||
      ((status === 'delivered' || status === 'read') && chatKind(msg.key.remoteJid!) === 'individual');
    return reported ? { key: msg.key, update: { status: msg.status } } : undefined;
  }

  /**
   * Whether two keys of one id provably name different messages: another chat, another side of the
   * conversation, or (outside the account's own messages) another sender. Fails open, like
   * {@link differentWaIds}: ids that cannot be compared are the same message.
   */
  private namesAnotherMessage(first: WAMessageKey, key: WAMessageKey): boolean {
    const neutral = (jid: string): string => this.host.toNeutralJid(jid);
    return (
      (first.fromMe === true) !== (key.fromMe === true) ||
      differentWaIds([first.remoteJid, first.remoteJidAlt], [key.remoteJid, key.remoteJidAlt], neutral) ||
      (key.fromMe !== true &&
        differentWaIds([first.participant, first.participantAlt], [key.participant, key.participantAlt], neutral))
    );
  }

  /** Admit a live message (see EngineEventCallbacks.admitInbound); undefined where nothing is held. */
  private admitInbound(msg: WAMessage): InboundTicket | undefined {
    const admit = this.host.getAdmitInbound?.();
    if (!admit) return undefined;
    return admitInboundSafely(
      () => {
        // Learned before the chat id is canonicalized, as processInboundMessage does without a ticket.
        this.host.recordKeyLidMappings(msg.key);
        const remoteJid = msg.key.remoteJid!;
        const behindChat = (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) && msg.key.participant;
        return admit({
          id: msg.key.id ?? '',
          chatId: this.host.toNeutralJid(baileysChatJid(remoteJid, msg.key.participant, msg.key.fromMe === true)),
          status: remoteJid === 'status@broadcast',
          needsRoom: this.plannedMediaDownload(this.host.getLoadedLib?.(), msg),
          fromMe: msg.key.fromMe === true,
          // As the mapper sets it, so a change that arrives before the emit is held to the same rule.
          ...(behindChat ? { author: this.host.toNeutralJid(msg.key.participant!) } : {}),
        });
      },
      error =>
        this.host.logger.error(
          `Could not admit inbound message ${msg.key.id ?? 'unknown'}; processing it without room for media`,
          String(error),
        ),
    );
  }

  /**
   * Whether processing `msg` downloads its media: the gates of {@link resolveInboundMedia}, read before
   * the processing starts. True when the module is not loaded yet, which cannot happen once a socket
   * delivers messages, so a slot is never missing for a download.
   */
  plannedMediaDownload(b: typeof BaileysLib | undefined, msg: WAMessage): boolean {
    if (!b) return true;
    const ownStatusPost = msg.key.fromMe === true && msg.key.remoteJid === 'status@broadcast';
    const normalized = b.normalizeMessageContent(msg.message ?? undefined) ?? msg.message ?? undefined;
    return (
      isBaileysMediaType(b.getContentType(normalized)) &&
      !ownStatusPost &&
      isMediaDownloadEnabled() &&
      coerceDeclaredSize(mediaSubMessage(normalized ?? {})?.fileLength) <= inboundMediaMaxBytes()
    );
  }

  /** Diagnostic: log a contacts event's size + whether records carry names/lids (and a small sample). */
  logContactEvent(
    event: string,
    records: Array<{
      id?: string;
      name?: string;
      notify?: string;
      verifiedName?: string;
      lid?: string;
      jid?: string;
    }> = [],
  ): void {
    const list = records ?? [];
    this.host.logger.debug('Baileys contacts event', {
      action: 'baileys_contacts',
      event,
      count: list.length,
      withName: list.filter(r => r.name || r.notify || r.verifiedName).length,
      withLid: list.filter(r => r.lid).length,
      sample: list.slice(0, 3).map(r => ({ id: r.id, name: r.name, notify: r.notify, lid: r.lid, jid: r.jid })),
    });
  }

  private async recordPreviewChange(
    chatId: string,
    messageId: string,
    body: string,
    type: MessageType | undefined,
    generation: number,
    accept: (key: WAMessageKey) => boolean,
  ): Promise<void> {
    if (generation !== this.storeGeneration) return;
    this.host.recordMessageEdit(chatId, messageId, body, type, accept);
    if (parseWaId(chatId).kind === 'lid') {
      const phone = await this.host.findPersistedLidPhone?.(chatId).catch(() => null);
      if (generation !== this.storeGeneration) return;
      if (phone) this.host.recordMessageEdit(`${phone}@s.whatsapp.net`, messageId, body, type, accept);
    }
  }

  /**
   * Whether an edit or delete sent under `envelope` may change the chat preview of the message keyed
   * `key`. The preview is that chat's own, so only the author is judged: the account's message changes
   * only by the account, a group member's only by that member, and a group delete comes from anyone,
   * as an admin may delete. The change may name a message the store does not hold (a history-synced or
   * an evicted one), which targetsForeignMessage then lets through for the session to judge; the
   * preview is judged here instead. Ids that cannot be compared (a lid nothing resolves, against a
   * phone) are not called different, as in readsAsForeign.
   */
  private previewAuthor(
    envelope: WAMessageKey,
    isDelete: boolean,
    resolve: (jid: string) => string | null,
  ): (key: WAMessageKey) => boolean {
    const neutral = (jid: string): string => {
      const phone = parseWaId(jid).kind === 'lid' ? resolve(jid) : null;
      return phone ? `${phone}@c.us` : this.host.toNeutralJid(jid);
    };
    return key => {
      if (isDelete && parseWaId(key.remoteJid ?? '').kind === 'group') return true;
      if ((key.fromMe === true) !== (envelope.fromMe === true)) return false;
      return (
        key.fromMe === true ||
        !key.participant ||
        !differentWaIds([key.participant, key.participantAlt], [envelope.participant, envelope.participantAlt], neutral)
      );
    };
  }

  private async processInboundMessage(
    msg: WAMessage,
    opts: {
      generation: number;
      order?: number;
      skipMedia?: boolean;
      ticket?: InboundTicket;
      yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
    },
  ): Promise<void> {
    try {
      const b = await this.host.loadLib();
      if (opts.generation !== this.storeGeneration) return;
      const remoteJid = msg.key.remoteJid!;
      // The chat the events below report: a received broadcast-list message belongs to its sender's
      // chat. Store lookups and the foreign-message checks keep the raw key, which is what is stored.
      const chatJid = baileysChatJid(remoteJid, msg.key.participant, msg.key.fromMe === true);
      // Learn any lid->pn pair the key carries BEFORE canonicalizing ids below, so a fresh @lid
      // sender resolves to its phone in this message and for later contact lookups (#362). The pairs
      // also write through to the persistent lid->phone table via addLidMappings. Admission did it already.
      if (!opts.ticket) this.host.recordKeyLidMappings(msg.key);
      // A live disappearing message (also viewOnce / documentWithCaption / edited) arrives wrapped, so the
      // raw `getContentType` returns the OUTER wrapper key (e.g. 'ephemeralMessage') and downstream type/
      // body/media/location detection would miss the real inner content. Normalize ONCE so the true inner
      // type drives routing here AND mapMessage. The protocol and reaction branches below read the
      // normalized content too: a client wraps an edit in `editedMessage`, and `ephemeralMessage` can hold
      // a revoke or a reaction just as well, so the raw root does not always carry them.
      let normalizedRoot = b.normalizeMessageContent(msg.message ?? undefined) ?? msg.message ?? undefined;
      let contentType = b.getContentType(normalizedRoot);
      // A contact's edit, and a reaction in some chats, arrive encrypted under the secret of the message
      // they change. Read with the stored original's secret, they are handled below as the plain
      // protocol or reaction message they stand for; one that cannot be read stays dropped as non-content.
      if (contentType === 'secretEncryptedMessage' || contentType === 'encReactionMessage') {
        const revealed = await this.revealEncryptedModification(b, msg, normalizedRoot, contentType);
        if (revealed) {
          normalizedRoot = revealed.content;
          contentType = revealed.contentType;
        }
      }

      if (contentType === 'protocolMessage' || contentType === 'reactionMessage') {
        const targetId = normalizedRoot?.protocolMessage?.key?.id ?? normalizedRoot?.reactionMessage?.key?.id;
        await this.prepareMessageChange(targetId, opts, releasePreparation =>
          this.processMessageChange(b, msg, normalizedRoot, contentType, { ...opts, releasePreparation }),
        );
        return;
      }

      // --- a vote, a pin, an album header and the like: don't emit onMessage ---
      // They only point at another message, so mapped they would reach consumers, in either
      // direction, as a bodyless `unknown` message (see BAILEYS_NON_CONTENT_TYPES).
      if (contentType && BAILEYS_NON_CONTENT_TYPES.has(contentType)) {
        this.host.logger.debug('Dropping a message that carries no content of its own', {
          action: 'baileys_drop_non_content',
          msgId: msg.key.id,
          remoteJid,
          contentType,
        });
        return;
      }

      // --- contentless protocol traffic: don't emit onMessage ---
      // A sender-key distribution (Signal traffic every group participant emits on first write or key
      // rotation) or a history-sync notice carries no user content, yet reached consumers as a bodyless
      // `unknown` message.received (#1568). Drop only a message made entirely of those keys. Anything
      // else without a resolvable content type (a call log, a type newer than the bundled proto, which
      // decodes to a lone messageContextInfo) still flows on as `unknown`, as it always has.
      //
      // Known limit: a type newer than the bundled proto that arrives in the same stanza as its sender's
      // key distribution is dropped too. Baileys merges the stanza's decrypted parts into one message
      // and protobuf decoding discards unknown fields, so it reads { senderKeyDistributionMessage,
      // messageContextInfo }: nothing records which part the context info came from or that a field was
      // skipped, and a messageContextInfo field such as messageSecret is not proof of content either,
      // since the sending client decides what it carries. It stops once the proto knows the type.
      const keys = Object.keys(normalizedRoot ?? {});
      if (keys.every(k => PROTOCOL_NOISE_KEYS.has(k)) && keys.some(k => k !== 'messageContextInfo')) {
        this.host.logger.debug('Dropping contentless protocol message', {
          action: 'baileys_drop_protocol_noise',
          msgId: msg.key.id,
          remoteJid,
          keys,
        });
        return;
      }

      // --- Normal message: enrich + emit ---
      // A message the store already holds was delivered or sent before: WhatsApp re-delivers a node
      // whose ack was lost on a drop, so the second copy has to stop here. Downstream would not catch
      // it: the own-send path dispatches message.sent whatever its insert did, and the inbound path
      // runs the message:received plugin hook before its insert oracle dedupes. The store is written
      // by the inbound path below, just before dispatch, and by the send path, and it survives a
      // restart, which the registry consulted in handleMessagesUpsert does not. The read fails open
      // (see readStoredMessage).
      const storedId = msg.key.id ?? null;
      if (storedId !== null && (await this.readStoredMessage(storedId, 'checking for a repeat delivery'))) {
        this.host.logger.debug('Skipping a re-delivered message this session already recorded', {
          msgId: storedId,
        });
        return;
      }
      // The account's own status post reaches the projector and is dropped there: a story is not a
      // conversation, so no `message.sent` is emitted for it. Downloading its media first is work
      // nothing consumes, and a story is a full-size photo or video. Everything else about the path
      // is kept, so the message is still recorded and still guards against a repeat delivery.
      const ownStatusPost = msg.key.fromMe === true && remoteJid === 'status@broadcast';
      const incoming = await this.mapMessage(msg, contentType, {
        skipMediaDownload: opts.skipMedia || ownStatusPost,
        ticket: opts.ticket,
        yieldSlot: opts.yieldSlot,
      });
      // Stored before it is announced: whoever hears about this message may act on it at once (a quoted
      // reply, a reaction, a read receipt), and the store holds a read of an id until its write lands.
      // A message deleted for everyone or edited while it was being processed is stored as the change
      // leaves it, and a delete wins over an edit.
      const deleted = storedId !== null && this.deletedForEveryone.has(storedId);
      const edit = storedId !== null && !deleted ? this.editedWhileInFlight.get(storedId) : undefined;
      const editedBody = edit && this.mayChange(msg.key, edit.envelope, false) ? edit.body : undefined;
      let toStore = deleted ? { ...msg, message: null } : msg;
      if (editedBody !== undefined) {
        // A copy, so the edit reaches neither Baileys' object nor anyone else holding it.
        toStore = JSON.parse(JSON.stringify(msg, b.BufferJSON.replacer), b.BufferJSON.reviver) as WAMessage;
        const content = b.normalizeMessageContent(toStore.message ?? undefined);
        if (content) setBaileysText(content, editedBody);
        // The session is told of the edit too, with a ticket at once and without one right after the emit, and
        // compares it with the text the message arrived with. It is told even when the latest edit restored that
        // text after another one: the message was edited all the same, and edits announced before the emit, past
        // the changes that wait, left no mark.
        if (editedBody !== incoming.body || edit?.afterOtherText) incoming.originalBody = incoming.body;
        incoming.body = editedBody;
      }
      if (opts.generation === this.storeGeneration) {
        void this.host.putStoredMessage(toStore)?.catch(err =>
          this.host.logger.warn('Failed to persist message to store', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      // Its delete was announced first and found nothing to clear, so announcing the message now, or
      // leaving its text as the chat preview, would publish what the sender took back. An edit announced
      // first found nothing to change either, so the message carries it here and in the preview. Where
      // the projector recorded the delete on the message it holds, the message still goes there, as on
      // whatsapp-web.js: it stores the row cleared and announces nothing. A delete it never saw (a
      // status post, a history revoke) keeps the message from being emitted at all.
      if (!deleted || opts.ticket?.revoked) {
        const emit = msg.key.fromMe === true ? this.host.getOnMessageCreate() : this.host.getOnMessage();
        // The ticket goes along only where one was issued, so elsewhere the call is unchanged.
        const receipt = opts.ticket ? emit?.(incoming, opts.ticket) : emit?.(incoming);
        this.watchOutcome(msg.key, receipt);
      }
      this.host.recordMessage(msg, deleted ? 'revoked' : incoming.type, opts.order);
      if (deleted) {
        this.host.recordMessageEdit(chatJid, storedId, '', 'revoked');
      } else if (editedBody !== undefined && storedId !== null) {
        this.host.recordMessageEdit(chatJid, storedId, editedBody);
      }
    } catch (err) {
      this.host.logger.error(
        `Unhandled error processing inbound message (id=${msg.key?.id ?? 'unknown'}); dropping`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      // Emitted by now, or never to be: what waited for this message goes to the session in the same turn, so
      // it reaches the message before its row is written.
      this.handOverChanges(msg.key?.id);
    }
  }

  /** Preparation runs without a media permit; full-queue waiters provide backpressure without blocking its head. */
  private async prepareMessageChange(
    messageId: string | null | undefined,
    opts: { generation: number; ticket?: InboundTicket; yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R> },
    work: (releasePreparation: () => void) => Promise<void>,
  ): Promise<void> {
    if (opts.generation !== this.storeGeneration) return;
    const retired = this.preparationsRetired;
    if (!messageId) {
      if (opts.generation === this.storeGeneration) await work(() => undefined);
      return;
    }
    opts.ticket?.drop();
    while (this.changesPreparing >= BaileysEvents.CHANGES_PARKED_LIMIT) {
      if (!this.preparationRoom) {
        let release!: () => void;
        const ready = new Promise<void>(resolve => {
          release = resolve;
        });
        this.preparationRoom = { ready, release };
      }
      await Promise.race([this.preparationRoom.ready, retired]);
      if (opts.generation !== this.storeGeneration) return;
    }
    this.changesPreparing++;
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    let releasePreparation!: () => void;
    const released = new Promise<void>(resolve => {
      releasePreparation = resolve;
    });
    this.messageChanges.enqueue(messageId, async () => {
      const preparing = (async () => {
        if (opts.generation === this.storeGeneration) await work(releasePreparation);
      })().then(finish, fail);
      try {
        await Promise.race([preparing, released, retired]);
      } finally {
        this.changesPreparing--;
        const room = this.preparationRoom;
        this.preparationRoom = undefined;
        room?.release();
      }
    });
    const settled = Promise.race([done, retired]);
    await (opts.yieldSlot ? opts.yieldSlot(() => settled) : settled);
  }

  private async processMessageChange(
    b: typeof BaileysLib,
    msg: WAMessage,
    normalizedRoot: WAMessage['message'],
    contentType: string,
    opts: {
      generation: number;
      ticket?: InboundTicket;
      yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
      releasePreparation: () => void;
    },
  ): Promise<void> {
    const remoteJid = msg.key.remoteJid!;
    const protocolType = normalizedRoot?.protocolMessage?.type;
    const reaction = contentType === 'reactionMessage';
    const revoke = !reaction && protocolType === b.proto.Message.ProtocolMessage.Type.REVOKE;
    const edit = !reaction && protocolType === b.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
    const targetId = normalizedRoot?.protocolMessage?.key?.id ?? normalizedRoot?.reactionMessage?.key?.id;
    let parked = false;
    const inbound = {
      ...opts,
      releasePreparation: () => {
        parked = true;
        opts.releasePreparation();
      },
    };
    if (
      (reaction || revoke || edit) &&
      (await this.targetsForeignMessage(
        targetId,
        msg.key,
        edit || (revoke && !remoteJid.endsWith('@g.us')),
        reaction ? 'reaction' : undefined,
        inbound,
      ))
    )
      return;
    if (opts.generation !== this.storeGeneration) return;
    const apply = () => this.applyMessageChange(b, msg, normalizedRoot, contentType, opts);
    // Waiting for an original must not occupy the preparation queue. Once it answers, take a new
    // turn before the remaining directory reads, so mixed change kinds still reach callbacks in order.
    if (parked) await this.prepareMessageChange(targetId, { ...opts, ticket: undefined }, apply);
    else await apply();
  }

  private async applyMessageChange(
    b: typeof BaileysLib,
    msg: WAMessage,
    normalizedRoot: WAMessage['message'],
    contentType: string,
    opts: { generation: number; ticket?: InboundTicket; yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R> },
  ): Promise<void> {
    const remoteJid = msg.key.remoteJid!;
    const chatJid = baileysChatJid(remoteJid, msg.key.participant, msg.key.fromMe === true);
    // --- protocolMessage REVOKE: don't emit onMessage ---
    if (contentType === 'protocolMessage') {
      const pm = normalizedRoot?.protocolMessage;
      if (pm?.type === b.proto.Message.ProtocolMessage.Type.REVOKE) {
        const from = msg.key.fromMe === true ? this.host.normalizedSelfJid() : chatJid;
        const to = msg.key.fromMe === true ? chatJid : this.host.normalizedSelfJid();
        const revoked: RevokedMessage = {
          id: pm.key?.id ?? '',
          // The REVOKE protocolMessage's key points at the ORIGINAL deleted message,
          // so `id` already IS the original here. Mirror it into `revokedId` so that
          // field is the reliable cross-engine handle (wwebjs sets it separately).
          revokedId: pm.key?.id ?? undefined,
          chatId: this.host.toNeutralJid(chatJid),
          from: this.host.toNeutralJid(from),
          to: this.host.toNeutralJid(to),
          type: 'revoked',
          body: '',
          timestamp: toUnixSeconds(msg.messageTimestamp),
        };
        // While the target is still being processed, the store change waits for it and lands after
        // this delete is announced, and a repeat delivery may already hold the content in the store:
        // record the delete now, checked against the target's own key.
        const target = this.inboundInFlight.get(revoked.id);
        if (target && this.mayChange(target.key, msg.key, true)) {
          this.markDeletedForEveryone(revoked.id);
        }
        // The stored copy keeps its key, so a late re-delivery is still recognised and a delete
        // for me can still address it, but loses its content, so nothing can quote or resend it.
        const resolveStored = await this.reportedPhones(
          (await this.readTarget(revoked.id, 'reading a delete target'))?.key,
          msg.key,
        );
        if (opts.generation !== this.storeGeneration) return;
        await this.recordPreviewChange(
          chatJid,
          revoked.id,
          '',
          'revoked',
          opts.generation,
          this.previewAuthor(msg.key, true, resolveStored),
        );
        if (opts.generation !== this.storeGeneration) return;
        this.changeStoredMessage(pm.key?.id, stored =>
          this.mayChange(stored.key, msg.key, true, resolveStored) ? { ...stored, message: null } : null,
        );
        // Behind the reactions and edits of the message that wait for its emit, never for the message itself:
        // the delete keeps it from being emitted, and they were made before it.
        this.announceWhenHandedOn(
          revoked.id,
          opts.ticket,
          () => this.host.getOnMessageRevoked()?.(revoked, { fromMe: msg.key.fromMe === true }),
          true,
        );
        return;
      }
      if (pm?.type === b.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
        // MESSAGE_EDIT wraps the message's latest content. Normalize that INNER content separately
        // so captions, type, PTT, media presence and mentions describe the edited value rather than
        // the outer protocol envelope.
        const normalizedEdited = b.normalizeMessageContent(pm.editedMessage ?? undefined) ?? pm.editedMessage ?? {};
        const editedContentType = b.getContentType(normalizedEdited);
        const editedSubMessage =
          normalizedEdited.extendedTextMessage ??
          normalizedEdited.imageMessage ??
          normalizedEdited.videoMessage ??
          normalizedEdited.audioMessage ??
          normalizedEdited.documentMessage ??
          normalizedEdited.stickerMessage ??
          normalizedEdited.locationMessage;
        const contextInfo = editedSubMessage?.contextInfo;
        const base = buildIncomingMessageFromBaileys(
          {
            id: pm.key?.id ?? '',
            remoteJid,
            fromMe: msg.key.fromMe === true,
            participant: keyParticipant(msg.key),
            body: extractBaileysBody(normalizedEdited),
            contentType: editedContentType,
            isPtt: normalizedEdited.audioMessage?.ptt === true,
            timestamp: this.toEditUnixSeconds(pm.timestampMs, msg.messageTimestamp),
            selfJid: this.host.normalizedSelfJid(),
            mentionedJids: contextInfo?.mentionedJid ?? undefined,
          },
          jid => this.host.toNeutralJid(jid),
        );
        const hasMedia =
          editedContentType === 'imageMessage' ||
          editedContentType === 'videoMessage' ||
          editedContentType === 'audioMessage' ||
          editedContentType === 'documentMessage' ||
          editedContentType === 'documentWithCaptionMessage' ||
          editedContentType === 'stickerMessage';
        const edited: EditedMessage = buildEditedMessage(base, hasMedia);
        const target = this.inboundInFlight.get(edited.messageId);
        if (target && this.mayChange(target.key, msg.key, false)) {
          const earlier = this.editedWhileInFlight.get(edited.messageId);
          const afterOtherText = !!earlier && (earlier.afterOtherText || earlier.body !== edited.body);
          this.editedWhileInFlight.delete(edited.messageId); // re-inserted as the newest
          this.editedWhileInFlight.set(edited.messageId, { envelope: msg.key, body: edited.body, afterOtherText });
          if (this.editedWhileInFlight.size > BaileysEvents.DELETED_FOR_EVERYONE_LIMIT) {
            const [oldest] = this.editedWhileInFlight.keys();
            this.editedWhileInFlight.delete(oldest);
          }
        }
        const resolveStored = await this.reportedPhones(
          (await this.readTarget(edited.messageId, 'reading an edit target'))?.key,
          msg.key,
        );
        if (opts.generation !== this.storeGeneration) return;
        await this.recordPreviewChange(
          chatJid,
          edited.messageId,
          edited.body,
          undefined,
          opts.generation,
          this.previewAuthor(msg.key, false, resolveStored),
        );
        if (opts.generation !== this.storeGeneration) return;
        this.changeStoredMessage(edited.messageId, stored => {
          const content = this.mayChange(stored.key, msg.key, false, resolveStored)
            ? b.normalizeMessageContent(stored.message ?? undefined)
            : undefined;
          return content && setBaileysText(content, edited.body) ? stored : null;
        });
        this.announceWhenHandedOn(edited.messageId, opts.ticket, () => this.host.getOnMessageEdited()?.(edited));
        return;
      }
      // Other protocol messages (ephemeral, history sync, etc.) — skip silently.
      return;
    }

    // --- reactionMessage: don't emit onMessage ---
    if (contentType === 'reactionMessage') {
      const rm = normalizedRoot?.reactionMessage;
      if (opts.generation !== this.storeGeneration) return;
      const event: ReactionEvent = {
        messageId: rm?.key?.id ?? '',
        chatId: this.host.toNeutralJid(chatJid),
        reaction: rm?.text ?? '',
        // A 1:1 key names the chat partner, not the author: for a reaction the account made from
        // its phone (fromMe) the reactor is the account itself. Group and status keys carry the
        // author as `participant`, own reactions included, which the edit branch reads the same way.
        senderId: this.host.toNeutralJid(
          keyParticipant(msg.key) ?? (msg.key.fromMe === true ? this.host.normalizedSelfJid() : remoteJid),
        ),
      };
      this.announceWhenHandedOn(rm?.key?.id, opts.ticket, () => this.host.getOnMessageReaction()?.(event));
      return;
    }
  }

  /**
   * Announce a reaction, an edit or a delete of message `id`. With a ticket the session holds the message from
   * its arrival and keeps the change for its row, so it is announced at once. Without one the session knows
   * nothing of a message before its emit, so a change that reaches a message still being processed is announced
   * right after the emit instead, in the order the changes arrived, when the session holds the message. A delete
   * (`behindChangesOnly`) never waits for the message: it waits only behind the changes already waiting, so they
   * are announced in the order they arrived. A change waits at most the three media deadlines a change aimed at a
   * delivery in flight waits (see targetsForeignMessage), and no more than CHANGES_PARKED_LIMIT wait at once, the
   * limit of those changes.
   */
  private announceWhenHandedOn(
    messageId: string | null | undefined,
    ticket: InboundTicket | undefined,
    announce: () => void,
    behindChangesOnly = false,
  ): void {
    const waiting = messageId && !ticket ? this.changesAwaitingEmit.get(messageId) : undefined;
    const waits = !!waiting || (!behindChangesOnly && !ticket && !!messageId && this.inboundInFlight.has(messageId));
    if (!messageId || !waits || this.changesAwaiting >= BaileysEvents.CHANGES_PARKED_LIMIT) {
      announce();
      return;
    }
    this.changesAwaiting++;
    if (waiting) {
      waiting.announce.push(announce);
      return;
    }
    const timer = setTimeout(() => this.handOverChanges(messageId), 3 * inboundMediaTimeoutMs());
    timer.unref();
    this.changesAwaitingEmit.set(messageId, { announce: [announce], timer });
  }

  /** Announce, in order, what waited for message `id` to be handed on (see announceWhenHandedOn). */
  private handOverChanges(messageId: string | null | undefined): void {
    const waiting = messageId ? this.changesAwaitingEmit.get(messageId) : undefined;
    if (!messageId || !waiting) return;
    this.changesAwaitingEmit.delete(messageId);
    clearTimeout(waiting.timer);
    this.changesAwaiting -= waiting.announce.length;
    for (const announce of waiting.announce) {
      try {
        announce();
      } catch (err) {
        this.host.logger.warn('Failed to announce a change that waited for its message', {
          msgId: messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Act on what the session made of a message handed to onMessage, once it says. A delivery that
   * reuses the id of a different message the session holds was dropped there as a duplicate, yet its
   * copy was stored under that id before the emit, and would stand in for the real message when a
   * later edit, delete or reaction of it is judged. Detached: it never delays inbound handling, and
   * nothing it does can fail it, whatever the callback returns or rejects with.
   */
  private watchOutcome(key: WAMessageKey, receipt: void | InboundReceipt): void {
    const id = key.id;
    if (!id || !receipt?.settled) return;
    // The session holds no entry for a status post, so it judges no change aimed at one: only a message
    // it holds can stand in for the stored copy there.
    const release = key.remoteJid === 'status@broadcast' ? undefined : this.holdOutcome(id);
    void Promise.resolve(receipt.settled)
      .then(result => (result?.conflict === true ? this.dropConflictingCopy(key, id) : undefined))
      .catch((err: unknown) =>
        this.host.logger.warn('Could not act on what the session made of a message', {
          msgId: id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => release?.());
  }

  /**
   * Count a delivery of `id` as awaiting the session's outcome, until the returned function is called
   * or OUTCOME_HOLD_MS passes, whichever is first, so a receipt that never settles (a hook that never
   * returns) cannot keep the id held for the life of the adapter. Ending twice counts once. The changes
   * parked for the id wake once its last delivery's hold has ended.
   */
  private holdOutcome(id: string): () => void {
    let hold = this.outcomesPending.get(id);
    if (!hold) {
      let free!: () => void;
      const ended = new Promise<void>(resolve => (free = resolve));
      hold = { count: 0, ended, free };
      this.outcomesPending.set(id, hold);
    }
    const entry = hold;
    entry.count++;
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (--entry.count > 0) return;
      this.outcomesPending.delete(id);
      entry.free();
    };
    const timer = setTimeout(end, BaileysEvents.OUTCOME_HOLD_MS);
    timer.unref();
    return end;
  }

  /**
   * Remove the copy a conflicting delivery stored, so the real message's later changes are judged
   * against nothing wrong. Only a copy that still carries this delivery's own key goes: the store is
   * read when the delete runs, behind every write of the id queued before it. Settles once the delete
   * has run, so the id stays held until then; never rejects.
   */
  private async dropConflictingCopy(key: WAMessageKey, id: string): Promise<void> {
    this.host.logger.warn('Dropping the stored copy of a message that reuses the id of another message', {
      msgId: id,
      remoteJid: key.remoteJid,
    });
    try {
      await this.host.removeStoredMessage(
        id,
        stored =>
          stored.key?.remoteJid === key.remoteJid &&
          keyParticipant(stored.key ?? {}) === keyParticipant(key) &&
          (stored.key?.fromMe === true) === (key.fromMe === true),
      );
    } catch (err) {
      this.host.logger.warn('Failed to remove the stored copy of a conflicting message', {
        msgId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Counted even when the removal failed: the session said this delivery is not the message the id names.
    const removed = this.removalsOf(id) + 1;
    this.copyRemovals.delete(id); // re-inserted as the newest
    this.copyRemovals.set(id, removed);
    if (this.copyRemovals.size > BaileysEvents.DELETED_FOR_EVERYONE_LIMIT) {
      const [oldest] = this.copyRemovals.keys();
      this.copyRemovals.delete(oldest);
    }
  }

  /** How many conflicting copies of `id` have been removed (see copyRemovals). */
  private removalsOf(id: string): number {
    return this.copyRemovals.get(id) ?? 0;
  }

  /**
   * What an edit, revoke or reaction targets: the stored copy, or the one still being processed. The
   * in-flight copy is taken BEFORE the store is read, because an original that finishes while the read is
   * out has left the map and may have been written after the read began, which would find it in neither.
   * `processing` settles once that copy's processing has, and is set only when the copy is the in-flight one.
   */
  private async readTarget(
    messageId: string,
    purpose: string,
  ): Promise<{ key: WAMessageKey; message: WAMessage['message']; processing?: Promise<void> } | null> {
    const processing = this.inboundInFlight.get(messageId);
    const stored = await this.readStoredMessage(messageId, purpose);
    if (stored) return { key: stored.key, message: stored.message };
    const inFlight = processing ?? this.inboundInFlight.get(messageId);
    return inFlight ? { key: inFlight.key, message: inFlight.message, processing: inFlight.done } : null;
  }

  /**
   * The stored copy of a message id, or null when the store cannot answer.
   *
   * Deliberately fail-open: a locked database or a row whose JSON no longer parses must not be read
   * as "this was never sent". The caller's only other outcome is the catch above, which drops the
   * message outright, and Baileys acks the node before it emits the upsert, so WhatsApp does not
   * send it again. A repeat is absorbed where it matters: the webhook carries the same idempotency
   * key and the insert oracle holds the row to one. A WebSocket subscriber does see the frame twice,
   * which is the price paid here deliberately, because a message nobody ever hears about cannot be
   * recovered at all. The persist side of the same store is already written this way.
   */
  private async readStoredMessage(messageId: string, purpose: string): Promise<WAMessage | null> {
    try {
      return (await this.host.getStoredMessage(messageId)) ?? null;
    } catch (err) {
      this.host.logger.warn(`Could not read the message store while ${purpose}`, {
        msgId: messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Read an edit or a reaction WhatsApp sent encrypted under the secret of the message it changes (see
   * baileys-secret-payload.ts). The secret comes from the target's stored copy, or from the copy still
   * being processed, and the pair of ids it is keyed by from that target's author and this message's
   * sender, so a payload only authenticates when the sender really is who the key says. The result is
   * the plain message to route as if it had arrived that way, and every guard of that path applies to
   * it: its author and chat are checked against the stored target afterwards. Anything that cannot be
   * read (an event edit, no stored target, a payload that does not authenticate) answers undefined and
   * stays dropped. Never throws.
   */
  private async revealEncryptedModification(
    b: typeof BaileysLib,
    msg: WAMessage,
    content: WAMessage['message'],
    contentType: string,
  ): Promise<
    { content: NonNullable<WAMessage['message']>; contentType: 'protocolMessage' | 'reactionMessage' } | undefined
  > {
    try {
      const isEdit = contentType === 'secretEncryptedMessage';
      const encrypted = isEdit ? content?.secretEncryptedMessage : content?.encReactionMessage;
      const targetKey = encrypted?.targetMessageKey;
      const targetId = targetKey?.id;
      const payload = bytesOf(encrypted?.encPayload);
      const iv = bytesOf(encrypted?.encIv);
      if (!encrypted || !targetKey || !targetId || !payload || !iv) return undefined;
      if (isEdit) {
        // An edit of an event arrives the same way and is not read here. The enum is a number on a live
        // message and its name on one read back from the store.
        const type = (encrypted as { secretEncType?: unknown }).secretEncType;
        const editType = b.proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT;
        if (type !== editType && type !== 'MESSAGE_EDIT') return undefined;
      }
      const original = await this.readTarget(targetId, 'reading the message an encrypted edit or reaction targets');
      const secret = messageSecretOf(original?.message);
      if (!original || !secret) {
        this.host.logger.debug('Cannot read an encrypted edit or reaction: the message it targets is not stored', {
          action: 'baileys_encrypted_unreadable',
          msgId: msg.key.id ?? 'unknown',
          targetId,
        });
        return undefined;
      }
      const user = this.host.getSocketOrNull()?.user;
      const own = [user?.id, user?.lid].filter((jid): jid is string => !!jid).map(withoutDevice);
      // The account's own lid is also tried as its phone number: a message written under phone addressing can
      // be edited under lid addressing, and the key names each party the way its own client did. Only that lid
      // resolves here (host.toNeutralJid keeps a contact's lid as a lid); a contact's phone form is tried only
      // when the key carries it as remoteJidAlt or participantAlt (senderForms).
      const withPhone = (forms: string[]): string[] =>
        forms.flatMap(jid => {
          const neutral = jid.endsWith('@lid') ? this.host.toNeutralJid(jid) : '';
          return neutral.endsWith('@c.us') ? [jid, `${userPart(neutral)}@s.whatsapp.net`] : [jid];
        });
      const plaintext = decryptSecretPayload({
        kind: isEdit ? 'edit' : 'reaction',
        secret,
        iv,
        payload,
        targetId,
        targetAuthors: withPhone(senderForms(original.key, own)),
        modifiers: withPhone(senderForms(msg.key, own)),
      });
      if (!plaintext) {
        this.host.logger.debug('An encrypted edit or reaction did not authenticate against its target', {
          action: 'baileys_encrypted_unauthentic',
          msgId: msg.key.id ?? 'unknown',
          targetId,
        });
        return undefined;
      }
      if (isEdit) {
        const protocolMessage = b.proto.Message.decode(plaintext).protocolMessage;
        // The decrypted message must name the target the secret was taken from, and be an edit.
        if (
          protocolMessage?.type !== b.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT ||
          protocolMessage.key?.id !== targetId
        ) {
          return undefined;
        }
        return { content: { protocolMessage }, contentType: 'protocolMessage' };
      }
      const reaction = b.proto.Message.ReactionMessage.decode(plaintext);
      return {
        content: { reactionMessage: { key: targetKey, text: reaction.text ?? '' } },
        contentType: 'reactionMessage',
      };
    } catch (error) {
      this.host.logger.debug('Could not read an encrypted edit or reaction', {
        action: 'baileys_encrypted_failed',
        msgId: msg.key.id ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Whether an edit, revoke or reaction names a stored message it cannot touch: one in another chat,
   * or, with `checkAuthor`, one somebody else sent. WhatsApp clients ignore such a message, but Baileys
   * emits it as-is, so a contact who knows an id could rewrite or erase that message. The projector
   * judges the stored row it would change as well, by the same rule (see mutationTargetsForeignRow) and
   * also for messages older than the store read here; this check keeps the adapter's own handling of the
   * event off a message it proves foreign. A message still being processed is checked against the key it
   * arrived under. Fails open: with no original at all, or ids that cannot be compared (see
   * {@link differentWaIds}), the event goes through as it always has.
   *
   * The copy a change reads as foreign to may be a duplicate of a message the session holds under
   * another chat, which only the session can say once it has stored the message and answered. Such a
   * change is not handed on to be judged there, since the adapter acts on it before the session does
   * (the preview, the stored copy, the delete record): it waits for the delivery to be processed, and
   * then for the answer to its id (see parkUntil), and is judged again. A conflicting copy has been
   * removed by then, so the real author's change finds nothing to contradict it, and a copy that stays
   * is the message the change is foreign to. One still held when the wait ends is dropped.
   *
   * A reaction to a message the account sent to a broadcast list is exempt: Baileys files the
   * own-device copy under the list jid (`<id>@broadcast`), while each recipient reacts from their 1:1
   * chat, so no chat can ever match it. A list message the account received is filed under the list
   * jid too, but Baileys shows it in the 1:1 chat with its sender (getChatId in process-message.js), so
   * a reaction to it may also come from that sender's chat, whose other-dialect id Baileys puts in
   * remoteJidAlt. Edits and revokes stay strict.
   */
  private async targetsForeignMessage(
    targetId: string | null | undefined,
    key: WAMessageKey,
    checkAuthor: boolean,
    kind?: 'reaction',
    inbound?: {
      ticket?: InboundTicket;
      yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
      releasePreparation?: () => void;
    },
  ): Promise<boolean> {
    if (!targetId) return false;
    // The key a wait was for (the delivery in flight, or the copy the change read as foreign to), and the
    // removals of this id counted when it began.
    let waitedFor: { key: WAMessageKey; removals: number } | undefined;
    // When the wait for the id's hold runs out, however many deliveries hold it in turn.
    let heldUntil: number | undefined;
    let reread = false;
    for (;;) {
      const removals = this.removalsOf(targetId);
      // A message still being processed has no stored copy yet, but the projector may already hold it
      // (PostgreSQL), so its own key is checked instead.
      const found = await this.readTarget(targetId, 'checking what an edit, revoke or reaction targets');
      // Without a stored copy the key the wait was for stands (a delivery that may never have been stored: no
      // store, a failed write; or a copy gone since), unless a conflicting copy went since the wait for it
      // began: then that delivery was not the message the id names, and nothing says which one is.
      const removedSince = waitedFor !== undefined && this.removalsOf(targetId) !== waitedFor.removals;
      const original =
        found && !found.processing ? found.key : removedSince ? undefined : (found?.key ?? waitedFor?.key);
      if (!original || !this.readsAsForeign(original, key, checkAuthor, kind)) return false;
      const processing = found?.processing;
      const hold = this.outcomesPending.get(targetId);
      if (hold) {
        // The session has not said yet whether the delivery that stored this copy is the message it holds
        // under the id or a duplicate of another one, so the copy cannot judge the change. Parked until it
        // has, when a conflicting copy is gone and the real author's change is judged by what remains. The
        // key it was judged by is remembered either way: a copy that is gone by then, wiped or unreadable
        // and not removed as a conflict, leaves that key to stand.
        waitedFor ??= { key: original, removals };
        heldUntil ??= Date.now() + BaileysEvents.OUTCOME_HOLD_MS;
        const left = heldUntil - Date.now();
        if (left > 0 && (await this.parkUntil(hold.ended, left, inbound))) continue;
      } else if (!waitedFor && processing && original.remoteJid !== 'status@broadcast' && original.fromMe !== true) {
        // No copy is stored yet, only the key of the delivery being processed, and the real message may be
        // one the store never held (the session has it by row), so this key cannot say which of the two the
        // change names. Judged again once the delivery has been stored and handed on, which is when the
        // hold and the removal of a conflicting copy answer it. Only a delivery the session reports on
        // counts: a status post is held by no entry there, and an own send gets no receipt.
        waitedFor = { key: original, removals };
        if (await this.parkUntil(processing, 3 * inboundMediaTimeoutMs(), inbound)) continue;
      }
      // A conflicting copy went while the store was read, and the read may have returned it: it ends the
      // hold only once removed, so the read is the one that can no longer be told from the real copy. Read
      // again, with the copy gone, rather than drop the real author's change against it.
      if (!reread && this.removalsOf(targetId) !== removals) {
        reread = true;
        continue;
      }
      this.host.logger.warn('Dropping an edit, revoke or reaction aimed at a message from another chat or author', {
        msgId: key.id ?? 'unknown',
        targetId,
        remoteJid: key.remoteJid,
      });
      return true;
    }
  }

  /**
   * Park a change until `until` settles or `limitMs` passes, whichever is first: a delivery's processing
   * (at most three media download deadlines: a wait for room in the session, then the download) or the
   * hold on an id's outcome. Never more than CHANGES_PARKED_LIMIT changes at once. Resolves true once it
   * did wait, false when it was not parked.
   * A parked change holds nothing the delivery needs. It gives up its inbound slot, which the delivery
   * may have to take back after waiting for room, and its place in its chat's order, which a change
   * never uses (it is not announced as a message), so it neither starves the delivery nor holds back the
   * messages that follow it in the chat.
   */
  private async parkUntil(
    until: Promise<void>,
    limitMs: number,
    inbound?: {
      ticket?: InboundTicket;
      yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
      releasePreparation?: () => void;
    },
  ): Promise<boolean> {
    if (this.changesParked >= BaileysEvents.CHANGES_PARKED_LIMIT) return false;
    this.changesParked++;
    try {
      inbound?.releasePreparation?.();
      if (!inbound?.releasePreparation) inbound?.ticket?.drop();
      const wait = (): Promise<void> =>
        new Promise<void>(resolve => {
          let wake: (() => void) | null = resolve;
          // Whichever comes first; the reaction left on a promise that never settles holds nothing.
          const end = (): void => {
            clearTimeout(timer);
            wake?.();
            wake = null;
          };
          const timer = setTimeout(end, limitMs);
          timer.unref();
          until.then(end, end);
        });
      await (inbound?.yieldSlot ? inbound.yieldSlot(wait) : wait());
      return true;
    } finally {
      this.changesParked--;
    }
  }

  /** Whether a change arriving under `key` names a message other than the one `original` is. */
  private readsAsForeign(original: WAMessageKey, key: WAMessageKey, checkAuthor: boolean, kind?: 'reaction'): boolean {
    const broadcast = kind === 'reaction' && !!original.remoteJid?.endsWith('@broadcast');
    if (broadcast && original.fromMe === true) return false;
    const originalChats = [original.remoteJid, original.remoteJidAlt];
    if (broadcast && original.remoteJid !== 'status@broadcast') originalChats.push(original.participant);
    const neutral = (jid: string): string => this.host.toNeutralJid(jid);
    return (
      differentWaIds(originalChats, [key.remoteJid, key.remoteJidAlt], neutral) ||
      (checkAuthor &&
        ((original.fromMe === true) !== (key.fromMe === true) ||
          (key.fromMe !== true &&
            differentWaIds(
              [original.participant, original.participantAlt],
              [key.participant, key.participantAlt],
              neutral,
            ))))
    );
  }

  /**
   * Apply an edit or a delete for everyone to the stored copy of the message it targets, which is
   * what a later quote or forward reads and what a retry resend falls back to. WhatsApp delivers the
   * change after the message, but the message can still be downloading its media, or waiting for a
   * limiter slot, when the change is processed, and a change written first would be overwritten by
   * the original. So the write waits for the original's own processing, which has called put() by
   * the time it settles, and the store queues the change behind that put. With nothing in flight the
   * change reaches the store at once: this is called before the change is announced, so a read by
   * whoever hears of it waits for the write, as a read of a just-announced message waits for its put.
   * Detached and best-effort, like the put.
   */
  private changeStoredMessage(
    messageId: string | null | undefined,
    change: (stored: WAMessage) => WAMessage | null,
  ): void {
    if (!messageId) return;
    const generation = this.storeGeneration;
    const apply = async (): Promise<void> => {
      if (generation !== this.storeGeneration) return;
      await this.host.updateStoredMessage(messageId, stored =>
        generation === this.storeGeneration ? change(stored) : null,
      );
    };
    const inFlight = this.inboundInFlight.get(messageId)?.done;
    void (inFlight ? inFlight.then(apply) : apply()).catch(err =>
      this.host.logger.warn('Failed to apply an edit or delete to the message store', {
        msgId: messageId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /**
   * Whether an edit or delete sent under `envelope` may change the stored message `target`. Baileys
   * checks neither the chat nor the sender of either (Utils/process-message.js), so the stored copy
   * changes only for one from the same chat and from the message's author. A group admin may delete
   * anyone's message, which nothing here can verify, so a group delete skips the author check.
   * Compare raw identities and incoming alt pairs. A stored LID/phone pair matches only through a
   * reported directory lookup; own-message senderAlt is not proof of the recipient's phone.
   */
  private async reportedPhones(...keys: Array<WAMessageKey | undefined>): Promise<(jid: string) => string | null> {
    const lids = new Set(
      keys
        .flatMap(key => [key?.remoteJid, key?.participant])
        .filter((jid): jid is string => !!jid && parseWaId(jid).kind === 'lid'),
    );
    const pairs = new Map<string, string>();
    await Promise.all(
      [...lids].map(async lid => {
        const phone = await this.host.findPersistedLidPhone?.(lid).catch(() => null);
        if (phone) pairs.set(userPart(lid), phone);
      }),
    );
    return jid => pairs.get(userPart(jid)) ?? null;
  }

  private mayChange(
    target: WAMessageKey,
    envelope: WAMessageKey,
    isDelete: boolean,
    resolve?: (jid: string) => string | null,
  ): boolean {
    const neutral = (jids: Array<string | null | undefined>): string[] =>
      jids.filter((jid): jid is string => !!jid).map(jid => this.host.toNeutralJid(jid));
    const chat = (key: WAMessageKey): string[] => neutral([key.remoteJid, key.fromMe ? undefined : key.remoteJidAlt]);
    const author = (key: WAMessageKey): string[] =>
      key.fromMe === true ? ['fromMe'] : key.participant ? neutral([key.participant, key.participantAlt]) : chat(key);
    const overlap = (a: string[], b: string[]): boolean => {
      if (parseWaId(a[0] ?? '').kind === 'lid' && parseWaId(b[0] ?? '').kind === 'lid' && a[0] !== b[0]) return false;
      return a.some(left =>
        b.some(right => {
          if (left === right) return true;
          const l = parseWaId(left).kind;
          const r = parseWaId(right).kind;
          return (
            (l === 'lid' && r === 'user' && resolve?.(left) === userPart(right)) ||
            (r === 'lid' && l === 'user' && resolve?.(right) === userPart(left))
          );
        }),
      );
    };
    if (!overlap(chat(target), chat(envelope))) return false;
    const inGroup = chat(target).some(jid => parseWaId(jid).kind === 'group');
    return (isDelete && inGroup) || overlap(author(target), author(envelope));
  }

  handleMessagesUpdate(updates: BaileysMessageUpdate[]): void {
    for (const u of updates) {
      const status = mapBaileysStatus(u.update?.status);
      // An ack is a receipt of a message the account sent. Baileys also raises a status update, keyed
      // fromMe: false, when another device of the account reads a message it received (read-self).
      if (status && u.key?.id && u.key.fromMe !== false) {
        // Canonicalize the update's chat exactly as the inbound mapper does, so an ack's chatId
        // matches the chatId of the message events it accompanies.
        const chatId = u.key.remoteJid ? this.host.toNeutralJid(u.key.remoteJid) : undefined;
        this.host.getOnMessageAck()?.(u.key.id, status, chatId);
      }
      for (const rsvp of u.update?.eventResponses ?? []) {
        void this.emitEventResponse(u.key, rsvp).catch(err =>
          this.host.logger.warn('Failed to report an event response', {
            msgId: u.key?.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  /**
   * Baileys `message-receipt.update`: per-participant receipts, which Baileys raises only for group
   * and status messages (1:1 receipts arrive as `messages.update` instead). Only receipts for
   * messages this account sent are reported, and only for those two chat kinds whichever way the list
   * reached this handler; receipts from the account's own linked devices are dropped. The event
   * buffer can merge several receipts of one participant into one entry, so each timestamp the entry
   * carries becomes its own event. rc14 files a `played` receipt under `readTimestamp`, so on that
   * version a voice note that was played reports `read`.
   */
  handleMessageReceiptUpdate(
    updates: Array<{
      key?: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null };
      receipt?: {
        userJid?: string | null;
        receiptTimestamp?: number | { toNumber(): number } | null;
        readTimestamp?: number | { toNumber(): number } | null;
        playedTimestamp?: number | { toNumber(): number } | null;
      };
    }>,
  ): void {
    const onReceipt = this.host.getOnMessageReceipt();
    if (!onReceipt) {
      return;
    }
    const isSelf = this.selfMatcher();
    for (const { key, receipt } of Array.isArray(updates) ? updates : []) {
      if (
        !key?.id ||
        !key.remoteJid ||
        key.fromMe !== true ||
        !RECEIPT_CHAT_KINDS.has(chatKind(key.remoteJid)) ||
        !receipt?.userJid ||
        isSelf(receipt.userJid)
      ) {
        continue;
      }
      const stamps: Array<[MessageReceiptStatus, typeof receipt.receiptTimestamp]> = [
        ['delivered', receipt.receiptTimestamp],
        ['read', receipt.readTimestamp],
        ['played', receipt.playedTimestamp],
      ];
      for (const [status, ts] of stamps) {
        if (ts == null) continue;
        const event: MessageReceiptEvent = {
          messageId: key.id,
          chatId: this.host.toNeutralJid(key.remoteJid),
          participant: this.host.toNeutralJid(receipt.userJid),
          status,
          timestamp: toUnixSeconds(ts),
        };
        onReceipt(event);
      }
    }
  }

  /**
   * Matches any jid of this account, in either dialect and from any of its devices (user parts are
   * compared). Answers false for everything while the account's own id is unknown.
   */
  private selfMatcher(): (jid: string | null | undefined) => boolean {
    const selfJid = this.host.normalizedSelfJid();
    if (!selfJid) {
      return () => false;
    }
    const phone = userPart(selfJid);
    const lid = this.host.getSocketOrNull()?.user?.lid;
    const lidUser = lid ? userPart(lid) : undefined;
    return (jid: string | null | undefined): boolean => {
      if (!jid) return false;
      const { kind, userPart: user } = parseWaId(jid);
      if (kind === 'user') return user === phone;
      if (kind !== 'lid') return false;
      if (lidUser !== undefined) return user === lidUser;
      // Creds carrying no `user.lid` leave nothing to compare a lid-addressed jid against, and every
      // such comparison would answer false. Fall back to the session's own lid to phone mapping,
      // which the store learns from the same traffic.
      return userPart(this.host.toNeutralJid(jid)) === phone;
    };
  }

  /**
   * An RSVP to a WhatsApp event. Baileys decrypts it itself while processing the inbound
   * `encEventResponseMessage` (whose upsert the live path drops as non-content): it reads the event
   * creation message's `messageSecret` through the socket's getMessage, which this adapter backs
   * with the message store, and re-emits the plaintext as a `messages.update` of the CREATION
   * message's key. An RSVP to an event the store does not hold cannot be decrypted and never
   * arrives here. Decryption authenticates the responder, since the key is derived from their jid.
   */
  private async emitEventResponse(eventKey: BaileysMessageUpdate['key'], rsvp: BaileysEventResponse): Promise<void> {
    const callback = this.host.getOnEventResponse();
    const envelope = rsvp.eventResponseMessageKey;
    if (!callback || !eventKey?.id || !eventKey.remoteJid || !envelope?.id) return;
    // Learned before any id below is canonicalized, as an inbound message does, so a guest answering
    // for the first time is not reported by lid once and by phone number afterwards.
    this.host.recordKeyLidMappings(envelope);
    // Baileys decrypts an RSVP against whichever stored event its creation key names and compares no
    // chats, so a member of two groups can answer in one an event posted in the other. The answer is
    // reported for the chat it arrived in, so one sent outside its event's chat is dropped, as an edit,
    // revoke or reaction aimed at a message of another chat is. Fails open like those: a store that
    // cannot be read, or ids that cannot be compared, report the RSVP as before.
    const stored = await this.readStoredMessage(eventKey.id, 'reading the event an RSVP answers');
    if (
      stored &&
      differentWaIds(
        [stored.key.remoteJid, stored.key.remoteJidAlt],
        [envelope.remoteJid, envelope.remoteJidAlt],
        jid => this.host.toNeutralJid(jid),
      )
    ) {
      this.host.logger.warn('Dropping an event response sent in a chat other than its event', {
        msgId: eventKey.id,
        responseMessageId: envelope.id,
        remoteJid: envelope.remoteJid,
      });
      return;
    }
    const fromMe = envelope.fromMe === true;
    // The creation key is the guest's view of the event (in a 1:1 chat its remoteJid is this
    // account), so the chat comes from the RSVP's own key, which Baileys has put on our side.
    const chatJid = envelope.remoteJid ?? eventKey.remoteJid;
    // Same rule as a reaction: a 1:1 key names the chat partner, so the account's own answer is
    // attributed to the account; group keys carry the responder as `participant`.
    const responder = keyParticipant(envelope) ?? (fromMe ? this.host.normalizedSelfJid() : chatJid);
    if (!responder) return;
    const event: EventResponseEvent = {
      eventMessageId: eventKey.id,
      chatId: this.host.toNeutralJid(chatJid),
      responderId: this.host.toNeutralJid(responder),
      fromMe,
      response: mapBaileysEventResponseType(rsvp.response?.response),
      responseMessageId: envelope.id,
      timestamp: this.toEditUnixSeconds(
        rsvp.senderTimestampMs ?? rsvp.response?.timestampMs,
        Math.floor(Date.now() / 1000),
      ),
    };
    const guests = rsvp.response?.extraGuestCount;
    if (typeof guests === 'number' && Number.isFinite(guests)) event.extraGuestCount = guests;
    // Named from the session's own contact store, like the sender of message.received, so an
    // attendance list can be built from the RSVPs alone without a network read per answer.
    const known = this.host.findContact(responder);
    if (known?.name || known?.pushName) {
      event.contact = {
        ...(known.name ? { name: known.name } : {}),
        ...(known.pushName ? { pushName: known.pushName } : {}),
      };
    }
    if (stored?.message) {
      const b = await this.host.loadLib();
      const name = b.normalizeMessageContent(stored.message)?.eventMessage?.name;
      if (name) event.eventName = name;
    }
    callback(event);
  }

  /**
   * Baileys `group-participants.update`: a membership change. Only add/remove map to the neutral
   * join/leave kinds — promote/demote (and 'modify', a phone-number-change rewrite) change no
   * membership and are skipped. The event carries no timestamp, so it is stamped at receipt.
   */
  handleGroupParticipantsUpdate(event: {
    id?: string;
    author?: string;
    authorPn?: string;
    participants?: unknown[];
    action?: string;
  }): void {
    const kind = event.action === 'add' ? 'join' : event.action === 'remove' ? 'leave' : undefined;
    if (!kind || !event.id) {
      return;
    }
    const participantIds = (Array.isArray(event.participants) ? event.participants : [])
      .map(entry => this.toNeutralGroupParticipantId(entry))
      .filter((jid): jid is string => jid !== null);
    const payload: GroupEvent = {
      kind,
      groupId: this.host.toNeutralJid(event.id),
      participantIds,
      timestamp: Math.floor(Date.now() / 1000),
    };
    // authorPn is the phone-dialect twin of a lid author: prefer it so the neutral actor id does
    // not depend on whether the lid->pn mapping happens to be learned yet.
    const actor = event.authorPn ?? event.author;
    if (actor) {
      payload.actorId = this.host.toNeutralJid(actor);
    }
    this.host.getOnGroupEvent()?.(payload);
  }

  /**
   * Baileys `groups.upsert`: this session was added to or joined a group. Baileys turns the w:gp2
   * `create` notification into this event and a content-less GROUP_CREATE stub, never into
   * `group-participants.update`. It drops the notification's type and reason, so a new group, an add
   * to an existing group and an invite-link join all arrive alike. Each entry is reported as a join of
   * this session's own id through the participants path, which owns the id guard, the authorPn
   * preference and the receipt timestamp. The entry lists the whole group, so members added with the
   * session are not reported.
   */
  handleGroupsUpsert(
    groups: Array<{ id?: string; author?: string; authorPn?: string; owner?: string; ownerPn?: string }>,
  ): void {
    const selfJid = this.host.normalizedSelfJid();
    if (!selfJid) {
      return; // no own id to report as the joining participant
    }
    // Without the lid fallback inside selfMatcher, a group this session created by a lid-addressed
    // actor would be reported as a join of itself.
    const isSelf = this.selfMatcher();
    for (const group of Array.isArray(groups) ? groups : []) {
      // Live, whatsapp-web.js emits no group.join when the session created the group, so that entry is
      // skipped. The acting participant alone does not identify it: an invite-link join may name the
      // joining session there, so the session must also be the group's owner.
      if (
        !group ||
        ((isSelf(group.authorPn) || isSelf(group.author)) && (isSelf(group.ownerPn) || isSelf(group.owner)))
      ) {
        continue;
      }
      this.handleGroupParticipantsUpdate({
        id: group.id,
        author: group.author,
        authorPn: group.authorPn,
        action: 'add',
        participants: [selfJid],
      });
    }
  }

  /**
   * Baileys `group.join-request`: someone asked to join a group the account admins (join-approval
   * on). Only action 'created' maps to the neutral join_request kind — the wwebjs event has no
   * revoke/reject counterpart, so only the shared signal is surfaced. Upstream scope caveat: rc14
   * emits this event only from the NON_ADMIN_ADD stub (172); the direct self-request stub (144) is
   * unhandled with an upstream TODO (Utils/process-message.js:569), so an invite-link self-request
   * may produce no event on this engine — the REST list endpoint still sees it. The pn twins are
   * preferred over lids for the same reason as everywhere else. The event carries no timestamp, so
   * it is stamped at receipt.
   */
  handleGroupJoinRequest(event: {
    id?: string;
    author?: string;
    authorPn?: string;
    participant?: string;
    participantPn?: string;
    action?: string;
    method?: string;
  }): void {
    if (event.action !== 'created' || !event.id) {
      return;
    }
    const participant = event.participantPn ?? event.participant;
    if (!participant) {
      return; // nothing addressable to report
    }
    const payload: GroupEvent = {
      kind: 'join_request',
      groupId: this.host.toNeutralJid(event.id),
      participantIds: [this.host.toNeutralJid(participant)],
      timestamp: Math.floor(Date.now() / 1000),
    };
    const actor = event.authorPn ?? event.author;
    if (actor) {
      payload.actorId = this.host.toNeutralJid(actor);
    }
    this.host.getOnGroupEvent()?.(payload);
  }

  /**
   * Baileys `groups.update`: partial group metadata. Each entry becomes one neutral 'update'
   * GroupEvent with `changes` filled from whichever of subject/desc/announce/restrict it carries
   * (desc → description, restrict → locked). Entries about fields the neutral shape does not model
   * (inviteCode, memberAddMode, joinApprovalMode, ...) still emit with empty changes — parity with
   * the wwebjs adapter, which emits uninterpretable updates the same way rather than dropping them.
   *
   * The same event also carries FULL metadata snapshots: groupFetchAllParticipating() emits its
   * entire result set through it (Socket/groups.js:56 `sock.ev.emit('groups.update', ...)`), and
   * this adapter calls that on every connect (hydrateNames) and every REST getGroups(). Real deltas
   * (Utils/process-message.js emitGroupUpdate) carry only `{id, ...oneChangedField, author?}`;
   * snapshots are recognized by their full-metadata markers (participants/creation/subjectTime/
   * owner/size) and skipped — otherwise every reconnect / GET /groups would flood consumers with
   * bogus group.update webhooks whose `changes` were fabricated from the snapshot.
   */
  handleGroupsUpdate(
    updates: Array<{
      id?: string;
      subject?: string;
      desc?: string;
      announce?: boolean;
      restrict?: boolean;
      author?: string;
      authorPn?: string;
      // Full-snapshot markers (extractGroupMetadata); the values are unused — presence is the signal.
      participants?: unknown;
      creation?: unknown;
      subjectTime?: unknown;
      owner?: unknown;
      size?: unknown;
    }>,
  ): void {
    for (const update of Array.isArray(updates) ? updates : []) {
      if (!update?.id) {
        continue;
      }
      // Skip full-metadata snapshots (see the docblock): only real deltas become GroupEvents.
      if ('participants' in update || 'creation' in update || 'subjectTime' in update || 'owner' in update) {
        continue;
      }
      const changes: NonNullable<GroupEvent['changes']> = {};
      if (typeof update.subject === 'string') changes.subject = update.subject;
      if (typeof update.desc === 'string') changes.description = update.desc;
      if (typeof update.announce === 'boolean') changes.announce = update.announce;
      if (typeof update.restrict === 'boolean') changes.locked = update.restrict;
      const payload: GroupEvent = {
        kind: 'update',
        groupId: this.host.toNeutralJid(update.id),
        participantIds: [],
        changes,
        timestamp: Math.floor(Date.now() / 1000),
      };
      const actor = update.authorPn ?? update.author;
      if (actor) {
        payload.actorId = this.host.toNeutralJid(actor);
      }
      this.host.getOnGroupEvent()?.(payload);
    }
  }

  /**
   * Baileys `call` events carry the whole call lifecycle; only the `offer` status is a NEW incoming
   * call (ringing/preaccept/timeout/reject/accept/terminate are progress and hang-up updates and
   * are skipped). Offline-replayed offers (missed-while-disconnected) and the account's own
   * outgoing calls are skipped too. The raw `from` JID is cached keyed by call id —
   * sock.rejectCall() needs it verbatim later, when the event itself is long gone.
   */
  handleCallEvents(calls: WACallEvent[]): void {
    for (const call of Array.isArray(calls) ? calls : []) {
      if (!call || !call.id || !call.from) {
        continue;
      }
      // An ended call takes its own path and returns. It must never fall through to the offer
      // handling below: a declined call arriving there would be published as a fresh incoming call
      // and, with auto-reject enabled, answered as one.
      if (call.status !== 'offer') {
        this.reportCallOutcome(call);
        continue;
      }
      // Baileys replays offers for calls missed while disconnected with offline: true
      // (Socket/messages-recv.js:1458 `offline: !!attrs.offline`; WACallEvent.offline is
      // non-optional). Those calls are long dead — emitting call.received (and, with
      // autoRejectCalls, rejecting a stale call) would be wrong, so drop them before caching.
      if (call.offline) {
        continue;
      }
      // WACallEvent has no fromMe flag, but WhatsApp can relay the account's own outgoing-call
      // signaling — skip a call whose from/chatId is ourselves (the wwjs adapter's call.fromMe
      // guard). Null-safe: with no socket user there is no own id to compare, so nothing is skipped.
      const selfJid = this.host.normalizedSelfJid();
      if (selfJid) {
        const self = this.host.toNeutralJid(selfJid);
        if (this.host.toNeutralJid(call.from) === self || this.host.toNeutralJid(call.chatId) === self) {
          continue;
        }
      }
      // Baileys maps both the `offer` and `offer_notice` wire tags onto status 'offer' carrying the
      // same call-id, so a single call can reach this loop more than once. Cache first and emit
      // only for an id not already live, otherwise one call surfaces as several `call.received`
      // events.
      const published = {
        from: this.host.toNeutralJid(call.callerPn ?? call.from),
        isVideo: call.isVideo === true,
        isGroup: call.isGroup === true,
      };
      // Offer and offer_notice carry one call id, so another tag of the call being rejected is neither a new
      // ring nor another call: it must not put the handle back or announce the call a second time. Its caller
      // may be spelled as a lid on one tag and as a phone number on the next, so the published identity counts too.
      const rejection = this.rejections.get(call.id);
      if (
        this.isPending(call.id, rejection) &&
        (rejection?.entry.callFrom === call.from || rejection?.entry.from === published.from)
      ) {
        continue;
      }
      if (!this.cacheLiveCall(call.id, call.from, published)) {
        continue;
      }
      const payload: IncomingCallEvent = {
        callId: call.id,
        // callerPn is the phone-dialect twin of a lid caller: prefer it so the neutral caller id
        // does not depend on whether the lid->pn mapping happens to be learned yet (same rule as
        // the group actor ids above).
        from: this.host.toNeutralJid(call.callerPn ?? call.from),
        isVideo: call.isVideo === true,
        isGroup: call.isGroup === true,
        // The event carries a real Date; fall back to receipt time when absent/unparseable.
        timestamp:
          call.date instanceof Date && !Number.isNaN(call.date.getTime())
            ? Math.floor(call.date.getTime() / 1000)
            : Math.floor(Date.now() / 1000),
      };
      this.host.getOnCall()?.(payload);
    }
  }

  /**
   * Publish the end of a ringing call.
   *
   * Only the three statuses that mean something to a consumer are mapped. WhatsApp also sends
   * `ringing`, `preaccept`, `transport` and `relaylatency` — transport-level chatter with no
   * user-visible meaning — and `terminate`, which covers both a caller hanging up before the call
   * was answered and either side ending an answered one, with nothing in the event to tell them
   * apart. Publishing `terminate` as an outcome would therefore be wrong roughly half the time.
   *
   * The cached live-call handle is dropped here rather than left to expire: the call is over, and a
   * `rejectCall` arriving afterwards should report not-found instead of acting on a dead call.
   */
  private reportCallOutcome(call: WACallEvent): void {
    // `terminate` publishes no outcome (see above) but DOES end the call — drop the handle so a
    // rejectCall arriving afterwards reports not-found instead of acting on a dead call. A rejection
    // already pending keeps its right to report its own success (see rejectCall). The other
    // unmapped statuses (ringing/preaccept/transport/relaylatency) are chatter on a call that is
    // still live and must stay rejectable.
    if (call.status === 'terminate') {
      const rejection = this.rejections.get(call.id);
      if (rejection) rejection.ended = true;
      this.liveCalls.delete(call.id);
      return;
    }
    const outcome = CALL_OUTCOMES[call.status];
    if (!outcome) return;

    const rejection = this.rejections.get(call.id);
    const live = this.liveCalls.get(call.id) ?? (this.isPending(call.id, rejection) ? rejection?.entry : undefined);
    this.rejections.delete(call.id);
    this.liveCalls.delete(call.id);

    // Offline replay is the same hazard as on the offer path: WhatsApp resends the signalling for
    // calls that ended while this session was disconnected, and announcing those as fresh outcomes
    // would report last week's declined call as if it just happened.
    if (call.offline) return;

    // An outcome for a call this session never saw ring is not actionable — it belongs to another
    // device's conversation, or predates the connection — and would arrive with no caller identity
    // beyond the raw jid. Dropping it keeps the event stream to calls the consumer already knows.
    if (!live) return;

    this.host.getOnCallOutcome()?.({
      callId: call.id,
      from: this.host.toNeutralJid(call.callerPn ?? call.from),
      outcome,
      isVideo: call.isVideo === true,
      isGroup: call.isGroup === true,
      timestamp:
        call.date instanceof Date && !Number.isNaN(call.date.getTime())
          ? Math.floor(call.date.getTime() / 1000)
          : Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Map Baileys' `presence.update` onto the neutral event.
   *
   * The payload is a per-participant map even for a 1:1 chat, where it holds the one contact — so
   * the shape is preserved rather than flattened, and a group reports everyone WhatsApp mentioned.
   * Ids are neutralized on both the chat and each participant, so a consumer never sees a raw
   * `@s.whatsapp.net` or a lid that the phone-dialect side of the API would not accept back.
   *
   * `lastSeen` is absent far more often than not: WhatsApp withholds it whenever the contact's
   * privacy settings do, which is the default for most accounts. That is not an error and is not
   * substituted with a guess.
   */
  handlePresenceUpdate(update: { id?: string; presences?: Record<string, RawPresence> }): void {
    const report = this.host.getOnPresenceUpdate();
    if (!report || !update?.id || !update.presences) return;

    const participants: ParticipantPresence[] = [];
    for (const [participant, data] of Object.entries(update.presences)) {
      const state = data?.lastKnownPresence;
      // An entry with no state says nothing; forwarding it as a guessed 'unavailable' would report
      // a contact offline on the strength of a malformed payload.
      if (!state || !PRESENCE_STATES.has(state)) continue;
      participants.push({
        id: this.host.toNeutralJid(participant),
        state,
        ...(typeof data.lastSeen === 'number' && Number.isFinite(data.lastSeen) ? { lastSeen: data.lastSeen } : {}),
      });
    }
    if (participants.length === 0) return;

    const groupOnlineCount = Object.values(update.presences).find(
      p => typeof p?.groupOnlineCount === 'number',
    )?.groupOnlineCount;
    this.host.getOnPresenceUpdate()?.({
      chatId: this.host.toNeutralJid(update.id),
      participants,
      ...(typeof groupOnlineCount === 'number' ? { groupOnlineCount } : {}),
    });
  }

  /**
   * Cache a ringing call's raw caller JID for a later rejectCall(). Lazy expiry: inserting a new
   * call drops already-expired entries, so a session that receives calls but never rejects them
   * can't grow the map without bound; an entry that never sees another call is tiny and is dropped
   * on teardown (disconnect/logout/destroy) or at the next call. No per-entry timer to clean up.
   *
   * Returns true when `callId` was not already ringing, which is what makes `call.received` fire
   * once per call rather than once per upstream offer tag. A repeat offer still refreshes the
   * entry, so a long-ringing call stays rejectable for a full TTL from the most recent signal.
   */
  private cacheLiveCall(
    callId: string,
    callFrom: string,
    published: { from: string; isVideo: boolean; isGroup: boolean },
  ): boolean {
    const now = Date.now();
    for (const [id, entry] of this.liveCalls) {
      if (entry.expiresAt <= now) {
        this.liveCalls.delete(id);
      }
    }
    const isNewCall = !this.liveCalls.has(callId);
    this.rejections.delete(callId);
    // The published identity is cached alongside the raw JID so a rejection issued through the API
    // can report the same shape the engine-observed outcomes do — the call event itself is long
    // gone by then.
    this.liveCalls.set(callId, { callFrom, expiresAt: now + BaileysEvents.LIVE_CALL_TTL_MS, ...published });
    return isNewCall;
  }

  /** Whether `rejection` is still the pending one for the call: nothing has ended the call since it began. */
  private isPending(callId: string, rejection: CallRejection | undefined): boolean {
    return (
      rejection !== undefined && this.rejections.get(callId) === rejection && this.liveCalls.clears === rejection.clears
    );
  }

  /**
   * Reject a currently-ringing call. The entry is evicted before the attempt, so a rejected call does not
   * become rejectable again. A signal that publishes its own outcome meanwhile makes this attempt stale; a
   * stale attempt publishes nothing. Otherwise a success publishes `rejected`, a `terminate` that arrived
   * first included. A failed attempt leaves the call ringing, so its entry is put back for a retry, unless
   * something ended the call meanwhile (any signal, a `terminate`, another call under the id, a teardown).
   * An unknown id or an expired entry maps to CallNotFoundError (HTTP 404).
   * A failure of the library's rejectCall() itself propagates as-is.
   */
  async rejectCall(callId: string): Promise<void> {
    const entry = this.liveCalls.get(callId);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.liveCalls.delete(callId);
      throw new CallNotFoundError(callId);
    }
    const sock = this.host.getSocketOrNull();
    if (!sock) {
      throw new EngineNotReadyError('Cannot reject a call before the engine is initialized.');
    }
    this.liveCalls.delete(callId);
    const rejection: CallRejection = { entry, clears: this.liveCalls.clears, ended: false };
    this.rejections.set(callId, rejection);
    let current: boolean;
    try {
      await withQueryDeadline(
        sock.rejectCall(callId, entry.callFrom),
        BAILEYS_QUERY_BUDGET_MS,
        'WhatsApp did not confirm the call rejection in time',
      );
      current = this.isPending(callId, rejection);
    } catch (err) {
      if (
        !rejection.ended &&
        this.isPending(callId, rejection) &&
        !this.liveCalls.has(callId) &&
        entry.expiresAt > Date.now()
      ) {
        this.liveCalls.set(callId, entry);
      }
      throw err;
    } finally {
      if (this.rejections.get(callId) === rejection) this.rejections.delete(callId);
    }
    if (!current) return;
    // A rejection made HERE produces no inbound `reject` signal to observe, so without this the
    // one outcome the caller definitely knows about — the one they asked for — was the only one
    // never published. Emitted only after the socket accepted it, and the entry is already evicted,
    // so a server echo arriving later cannot publish a second time.
    this.host.getOnCallOutcome()?.({
      callId,
      from: entry.from,
      outcome: 'rejected',
      isVideo: entry.isVideo,
      isGroup: entry.isGroup,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Coerce one `group-participants.update` entry to a neutral user id. Since Baileys v7 the entries
   * are parsed JSON objects (`{ id, phoneNumber?, lid?, ... }`, see Socket/messages-recv.js), not
   * plain JID strings: prefer the phone JID when present (a lid `id` with a known phone resolves to
   * the same neutral @c.us via the mapping, but the inline phoneNumber needs no lookup), then the
   * bare id, then the lid. Plain-string entries (the pre-v7 shape) pass through the same normalizer.
   */
  private toNeutralGroupParticipantId(entry: unknown): string | null {
    if (typeof entry === 'string') {
      return entry ? this.host.toNeutralJid(entry) : null;
    }
    if (entry && typeof entry === 'object') {
      const e = entry as { phoneNumber?: unknown; id?: unknown; lid?: unknown };
      const jid = [e.phoneNumber, e.id, e.lid].find((v): v is string => typeof v === 'string' && v.length > 0);
      return jid ? this.host.toNeutralJid(jid) : null;
    }
    return null;
  }

  /**
   * Download inbound media via a stream, accumulating chunks but ABORTING (destroy + discard) once the
   * running total exceeds `maxBytes`. On that abort it resolves `{ overflowBytes }`, the bytes received
   * when the cap tripped; past the wall-clock deadline it resolves null. Uses
   * `downloadMediaMessage(..., 'stream')` (not the raw `downloadContentFromMessage`) so the library's
   * expired-media re-upload retry is kept; for under-cap media the concatenated buffer is byte-identical
   * to the 'buffer' mode it replaces.
   */
  private async downloadInboundMediaCapped(
    msg: WAMessage,
    maxBytes: number,
  ): Promise<Buffer | { overflowBytes: number } | null> {
    // Hold the stream handle in the outer scope so the timeout can destroy it. A genuine
    // download/read error still rejects (propagating to the caller's catch as before).
    let stream: (AsyncIterable<Buffer> & { destroy?: () => void }) | undefined;
    // The timeout can fire before the stream exists (an expired-media re-upload wait, a slow response):
    // the abandoned download must then stop on its own instead of buffering outside the limiter.
    let timedOut = false;
    // Settles the gate task at the deadline. Without it the process-wide slot is held until the body
    // settles, and a fetch stuck before the stream exists (an expired-media re-upload the phone never
    // answers waits with no timeout until the socket closes) would keep that slot for hours, starving
    // every other session's media. Freeing it early is safe: nothing is buffered before the stream
    // exists, and a stream that turns up late is destroyed by the `timedOut` check below.
    let releaseSlot: () => void = () => undefined;
    const deadlinePassed = new Promise<Buffer>(resolve => {
      releaseSlot = () => resolve(Buffer.alloc(0));
    });
    const body = async (): Promise<Buffer | { overflowBytes: number }> => {
      if (timedOut) {
        return Buffer.alloc(0);
      }
      const b = await this.host.loadLib();
      // The address comes from the sender, and so does a re-upload answer (encrypted with the
      // sender's own media key): both are checked before Baileys fetches them.
      const assertWhatsAppSource = (m: WAMessage): WAMessage => {
        if (!isWhatsAppMediaSource(b, m.message)) {
          throw new Error('Inbound media address is not a WhatsApp media host; not fetched');
        }
        return m;
      };
      assertWhatsAppSource(msg);
      const sock = this.host.getSocket();
      // A proxied session must not fetch media around its proxy (#859). Baileys reads the dispatcher
      // from the nested `options`; a top-level one is ignored. Read after the socket: once the session
      // is torn down getSocket() throws, and a dispatcher built then would never be closed.
      const dispatcher = this.host.getFetchDispatcher();
      stream = (await b.downloadMediaMessage(
        msg,
        'stream',
        dispatcher ? { options: { dispatcher } as RequestInit } : {},
        {
          logger: createSilentLogger(),
          reuploadRequest: async m => assertWhatsAppSource(await sock.updateMediaMessage(m)),
        },
      )) as AsyncIterable<Buffer> & { destroy?: () => void };
      if (timedOut) {
        stream.destroy?.();
        return Buffer.alloc(0);
      }

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        if (timedOut) {
          break;
        }
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy?.();
          return { overflowBytes: total };
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };
    // The wait for the process-wide gate sits inside the deadline below, so a contended gate cannot
    // hold this session's inbound handler longer than MEDIA_DOWNLOAD_TIMEOUT_MS.
    const download = runUnderGlobalMediaGate(() => {
      const run = body();
      // The abandoned body can still reject later (the socket closing under a re-upload wait).
      run.catch(() => undefined);
      return Promise.race([run, deadlinePassed]);
    });

    // A slow/trickling sender never trips the byte cap, so without a deadline it pins a concurrency
    // slot (and, on Baileys, the whole inbound handler) indefinitely. On timeout, destroy the stream
    // and treat it as no usable media.
    return withInboundDownloadTimeout(download, inboundMediaTimeoutMs(), () => {
      timedOut = true;
      stream?.destroy?.();
      releaseSlot();
    });
  }

  /**
   * Resolve the media payload of an inbound message: the omitted marker when the download is skipped
   * or disabled, the same marker when the declared size trips the pre-download gate, otherwise the
   * capped stream-download. Impure by nature — it downloads, logs and reads env — so it stays beside
   * {@link downloadInboundMediaCapped} rather than moving to the pure mapper module.
   *
   * `skipMediaDownload` is a plain boolean so the `||` keeps its short-circuit order:
   * `isMediaDownloadEnabled()` reads `process.env` at call time and must not run when skip is set.
   */
  private async resolveInboundMedia(
    msg: WAMessage,
    contentType: string | undefined,
    content: NonNullable<WAMessage['message']>,
    b: typeof BaileysLib,
    skipMediaDownload: boolean,
    room?: { ticket?: InboundTicket; yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R> },
  ): Promise<IncomingMessage['media']> {
    if (!isBaileysMediaType(contentType)) {
      return undefined;
    }

    // The outbound "sent" echo passes skipMediaDownload: the API caller already holds the media and
    // the REST send path persists it, so re-downloading it here would buy nothing. This is where
    // Baileys deliberately diverges from wwjs, whose echo does download the payload
    // (wwebjs-message-events.ts) because a phone-composed send has no other source for it.
    if (skipMediaDownload || !isMediaDownloadEnabled()) {
      // Emit the omitted marker so the media field is present (webhook/n8n/dashboard contract).
      // mimetype is available pre-download from the message content.
      const normalizedContent = b.normalizeMessageContent(content) ?? content;
      const subMessage = mediaSubMessage(normalizedContent);
      return {
        mimetype: subMessage?.mimetype ?? '',
        filename: normalizedContent.documentMessage?.fileName ?? undefined,
        omitted: true,
        sizeBytes: coerceDeclaredSize(subMessage?.fileLength),
      };
    }

    // normalizeMessageContent unwraps documentWithCaptionMessage / viewOnceMessage / ephemeralMessage
    // so we reach the inner media sub-message — needed BEFORE download for the declared-size pre-gate.
    const normalizedContent = b.normalizeMessageContent(content) ?? content;
    const subMessage = mediaSubMessage(normalizedContent);
    const mimetype = subMessage?.mimetype ?? '';
    const filename = normalizedContent.documentMessage?.fileName ?? undefined;
    const maxBytes = inboundMediaMaxBytes();
    const declared = coerceDeclaredSize(subMessage?.fileLength);

    if (declared > maxBytes) {
      // Pre-download gate: an honest over-cap sender's media is never decrypted into heap at all.
      // Baileys does not check the decrypted bytes against the declared size, so a sender can
      // understate it; the streaming abort below is the bound for that case.
      this.host.logger.warn('Inbound media declared size exceeds MEDIA_DOWNLOAD_MAX_BYTES; skipped download', {
        msgId: msg.key.id,
        sizeBytes: declared,
      });
      return { mimetype, filename, omitted: true, sizeBytes: declared };
    }

    try {
      // Where payloads wait for their rows (PostgreSQL), download only into a slot of the session's
      // room, held until the row is written. The inbound limiter slot is given up while waiting, so
      // other chats' messages keep flowing. No room in time: the marker, and nothing downloaded.
      const ticket = room?.ticket;
      if (ticket) {
        const granted = ticket.reserve();
        const yieldSlot = room?.yieldSlot ?? (<R>(fn: () => Promise<R>) => fn());
        if (!(granted === true || (granted !== false && (await yieldSlot(() => granted))))) {
          this.host.logger.warn('No room for inbound media within the wait; emitting the omitted marker', {
            msgId: msg.key.id,
            sizeBytes: declared,
          });
          return { mimetype, filename, omitted: true, sizeBytes: declared };
        }
      }
      // Stream-download with a running-total abort so a sender who understates fileLength still
      // can't materialise an over-cap blob. For under-cap media this yields the identical buffer.
      const buf = await this.downloadInboundMediaCapped(msg, maxBytes);
      if (buf === null) {
        // Nothing proves the real size, so report the declared one, as the failure branch below does.
        this.host.logger.warn('Inbound media download passed MEDIA_DOWNLOAD_TIMEOUT_MS; emitting omitted marker', {
          msgId: msg.key.id,
          sizeBytes: declared,
        });
        return { mimetype, filename, omitted: true, sizeBytes: declared };
      }
      if (!Buffer.isBuffer(buf)) {
        // The bytes received are a lower bound above the cap; the declared size passed the pre-gate, so
        // it is smaller and says nothing here.
        const sizeBytes = buf.overflowBytes;
        this.host.logger.warn('Inbound media download exceeded MEDIA_DOWNLOAD_MAX_BYTES; emitting omitted marker', {
          msgId: msg.key.id,
          sizeBytes,
        });
        return { mimetype, filename, omitted: true, sizeBytes };
      }
      // capInboundMedia is the last line (lazy base64, never persist/webhook/broadcast an over-cap
      // blob); the real heap bound is the pre-gate + streaming abort + concurrency limiter.
      return capInboundMedia({
        mimetype,
        filename,
        sizeBytes: buf.byteLength,
        toBase64: () => buf.toString('base64'),
      });
    } catch (err) {
      // A download failure yields the omitted marker, never a propagated throw: the media field stays
      // present, matching the skip/pre-gate/abort exits above. The declared size is the honest number
      // here: the download never completed, so no measured size exists.
      this.host.logger.warn('Inbound media download failed; emitting the omitted marker', {
        error: err instanceof Error ? err.message : String(err),
        msgId: msg.key.id,
      });
      return { mimetype, filename, omitted: true, sizeBytes: declared };
    }
  }

  async mapMessage(
    msg: WAMessage,
    contentType: string | undefined,
    opts?: {
      skipMediaDownload?: boolean;
      ticket?: InboundTicket;
      yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
    },
  ): Promise<IncomingMessage> {
    const b = await this.host.loadLib();
    const content = msg.message ?? {};
    // Read body/location/media/context off the NORMALIZED content: a disappearing message
    // (ephemeralMessage), a captioned document (documentWithCaptionMessage) and viewOnce/edited wrappers
    // nest the real payload under an inner message, so the raw wrapper exposes none at top level.
    // Identity no-op when unwrapped.
    const normalized = b.normalizeMessageContent(content) ?? content;

    // Body: text first, then media caption, then WhatsApp Business interactive shapes (#562).
    const body = extractBaileysBody(normalized);
    const location = extractBaileysLocation(normalized, contentType);
    const media = await this.resolveInboundMedia(msg, contentType, content, b, opts?.skipMediaDownload === true, opts);
    // The quote, the disappearing-messages timer, the mentions and the status styling all come from
    // one region of the content — see BaileysMessageContext.
    const context = extractBaileysContext(normalized);
    // Commerce ids (order token, product id): the generic path sees an empty body and drops them,
    // and they are the only handle a caller has on the order or the product.
    const commerce = extractBaileysCommerce(normalized, contentType);
    // Button / list / native-flow reply ids: body carries the visible label; this is the stable id.
    const button = extractBaileysButtonReply(normalized, contentType);
    // Prompt choices (Sim/Não, list rows, …) offered by a business interactive message.
    const buttons = extractBaileysButtons(normalized, contentType);

    return buildIncomingMessageFromBaileys(
      {
        id: msg.key.id ?? '',
        remoteJid: msg.key.remoteJid!,
        fromMe: msg.key.fromMe === true,
        participant: keyParticipant(msg.key),
        body,
        contentType,
        isPtt: normalized.audioMessage?.ptt === true,
        timestamp: toUnixSeconds(msg.messageTimestamp),
        pushName: msg.pushName ?? undefined,
        selfJid: this.host.normalizedSelfJid(),
        media,
        location,
        quotedMessage: context.quotedMessage,
        order: commerce.order,
        product: commerce.product,
        poll: extractBaileysPoll(normalized),
        button,
        buttons,
        isCatalogShare: isBaileysCatalogShare(normalized),
        ephemeralDuration: context.ephemeralDuration,
        mentionedJids: context.mentionedJids,
        backgroundArgb: context.backgroundArgb,
        font: context.font,
      },
      jid => this.host.toNeutralJid(jid),
    );
  }

  /** Protocol-message edit timestamps are milliseconds; the enclosing message timestamp is seconds. */
  private toEditUnixSeconds(
    timestampMs: number | { toNumber(): number } | null | undefined,
    fallback: number | { toNumber(): number } | null | undefined,
  ): number {
    if (timestampMs == null) return toUnixSeconds(fallback);
    const milliseconds = typeof timestampMs === 'number' ? timestampMs : timestampMs.toNumber();
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : toUnixSeconds(fallback);
  }
}
