import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WACallEvent, WAMessage, WAMessageKey, WASocket } from '@whiskeysockets/baileys';
import {
  EditedMessage,
  EngineEventCallbacks,
  GroupEvent,
  IncomingCallEvent,
  InboundTicket,
  ParticipantPresence,
  PresenceState,
  CallOutcome,
  IncomingMessage,
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
  mapBaileysStatus,
  setBaileysText,
} from './baileys-message-mapper';
import { buildEditedMessage } from './message-mapper';
import { toUnixSeconds } from './baileys-history';
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
import { parseWaId, userPart } from '../identity/wa-id';

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
  recordKeyLidMappings(key: Pick<WAMessageKey, 'remoteJid' | 'remoteJidAlt' | 'participant' | 'participantAlt'>): void;
  /** Seed the chat's last-message preview + sort time from an inbound message. */
  recordMessage(msg: WAMessage, type?: MessageType): void;
  /** Apply a message edit to the stored body. */
  recordMessageEdit(chatId: string, messageId: string, text: string, type?: MessageType): void;
  /** Persist an inbound message to the store; undefined when no store is configured. */
  putStoredMessage(msg: WAMessage): Promise<void> | undefined;
  /** Rewrite a stored message in place (see BaileysMessageStore.update); undefined without a store. */
  updateStoredMessage(messageId: string, change: (stored: WAMessage) => WAMessage | null): Promise<void> | undefined;
  /**
   * True exactly once for the id of a message this session sent through the API, whose library echo
   * is arriving; false for anything the session did not send (see OwnSendRegistry).
   */
  consumeOwnSend(id: string | null | undefined): boolean;
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
  /** The currently-registered onGroupEvent callback, if any (assigned at initialize()). */
  getOnGroupEvent(): EngineEventCallbacks['onGroupEvent'];
  /** The currently-registered onCall callback, if any (assigned at initialize()). */
  getOnCall(): EngineEventCallbacks['onCall'];
  /** The currently-registered onPresenceUpdate callback, if any (assigned at initialize()). */
  getOnPresenceUpdate(): EngineEventCallbacks['onPresenceUpdate'];
  /** The currently-registered onCallOutcome callback, if any (assigned at initialize()). */
  getOnCallOutcome(): EngineEventCallbacks['onCallOutcome'];
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

export class BaileysEvents {
  /** How long a received call's handle stays rejectable. Calls ring for roughly a minute, so
   *  two minutes covers the ringing window with margin without pinning dead calls for long. */
  private static readonly LIVE_CALL_TTL_MS = 2 * 60_000;

  /** Live incoming calls by call id, holding the raw `from` JID sock.rejectCall() needs — the
   *  call event is long gone by the time a reject arrives, so it must be cached at event time.
   *  Readonly reference, owned here; the adapter's lifecycle clears it on teardown. */
  readonly liveCalls = new LiveCallMap<{
    callFrom: string;
    expiresAt: number;
    from: string;
    isVideo: boolean;
    isGroup: boolean;
  }>();

  /** How many ids the record of deletes for everyone keeps before it forgets the oldest. */
  static readonly DELETED_FOR_EVERYONE_LIMIT = 5_000;

  /**
   * Inbound messages still being processed, by id, with the key of the latest delivery, so an edit or
   * delete of one waits for its store write and a delete can be checked against its target meanwhile.
   */
  private readonly inboundInFlight = new Map<string, { key: WAMessageKey; done: Promise<void> }>();

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
   * a quote or forward meanwhile carries it too (see pendingEditOf). Dropped once the message's
   * processing settles, and bounded like deletedForEveryone, which wins over it.
   */
  private readonly editedWhileInFlight = new Map<string, { envelope: WAMessageKey; body: string }>();

  /**
   * Bumped by fenceStoredWrites when the account is unlinked. A message stores its copy only while the
   * generation it arrived under is current: one still processing when the store is wiped (a media
   * download outlives the socket, and the limiter queue is unbounded) must not recreate a row of the
   * unlinked account afterwards.
   */
  private storeGeneration = 0;

  constructor(private readonly host: BaileysEventsHost) {}

  /** Drop the store writes of every message that arrived before now; call before wiping the store. */
  fenceStoredWrites(): void {
    this.storeGeneration++;
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
    const stored = await this.readStoredMessage(target.id, 'checking what a history revoke targets');
    if (generation !== this.storeGeneration) return undefined;
    const original = stored?.key ?? this.inboundInFlight.get(target.id)?.key ?? target;
    if (!this.mayChange(original, envelope, true)) return undefined;
    if (stored || this.inboundInFlight.has(target.id)) this.markDeletedForEveryone(target.id);
    this.changeStoredMessage(target.id, copy =>
      this.mayChange(copy.key, envelope, true) ? { ...copy, message: null } : null,
    );
    return original;
  }

  handleMessagesUpsert(event: { messages: WAMessage[]; type: string }): void {
    for (const msg of event.messages) {
      if (!msg.message || !msg.key?.remoteJid) {
        continue; // protocol/empty messages carry no neutral content
      }
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
        this.host.logger.debug('Skipping the echo of a message this session sent', {
          msgId: msg.key.id ?? 'unknown',
          type: event.type,
        });
        continue;
      }
      // Throttle through the limiter so a burst of media messages can't run unbounded parallel
      // downloads (each a full decrypted buffer in heap). Ordering stays correct — the message store
      // keeps the newest by timestamp. The queue is unbounded, so a burst parks rather than shedding
      // and the message keeps its media either way. The catch below is the teardown path: the
      // limiter rejects only when it has been closed, since processInboundMessage handles its own
      // failures (a media download that fails emits the omitted marker rather than throwing).
      const generation = this.storeGeneration;
      // Where the session holds a message until its row is written (PostgreSQL), admit it now, in
      // arrival order: its chat's order, and a slot of the session's room when it downloads media.
      const ticket = this.admitInbound(msg);
      const processed = this.host.inboundLimiter
        .run(yieldSlot => this.processInboundMessage(msg, { generation, ticket, yieldSlot }))
        .catch((error: unknown) => {
          // Only one failure can actually land here today: the limiter closing, an orderly teardown.
          // Its queue is unbounded so it never sheds, and processInboundMessage swallows its own
          // errors, so nothing else rejects. The other arm is defence in depth against a rejection
          // shape that does not exist yet, and it names the error rather than calling it
          // "saturated", which used to send operators to look at concurrency settings for a problem
          // that was never there. The retry below cannot reject either, for the same reason.
          const closed = error instanceof Error && error.message.startsWith('ConcurrencyLimiter closed');
          this.host.logger.warn(
            closed
              ? 'Inbound media limiter closed during teardown; emitting message without media'
              : 'Inbound media download failed; emitting message without media',
            { msgId: msg.key?.id ?? 'unknown', ...(closed ? {} : { error: String(error) }) },
          );
          return this.processInboundMessage(msg, { generation, skipMedia: true, ticket });
        });
      // The room stays held until the processing settles too, and a message never emitted drops its turn.
      ticket?.holdUntil(processed);
      void processed.finally(() => ticket?.drop());
      const id = msg.key.id;
      if (id) {
        // A repeat delivery can arrive while the first is still downloading and finish before it, so
        // a change waits for every delivery in flight, not only the latest.
        const tracked = {
          key: msg.key,
          done: Promise.all([this.inboundInFlight.get(id)?.done, processed]).then(() => undefined),
        };
        this.inboundInFlight.set(id, tracked);
        void tracked.done.finally(() => {
          if (this.inboundInFlight.get(id) !== tracked) return;
          this.inboundInFlight.delete(id);
          // The edit's store write was chained behind this, so the store carries it (or a newer one) now.
          this.editedWhileInFlight.delete(id);
        });
      }
    }
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
        return admit({
          id: msg.key.id ?? '',
          chatId: this.host.toNeutralJid(baileysChatJid(remoteJid, msg.key.participant, msg.key.fromMe === true)),
          status: remoteJid === 'status@broadcast',
          needsRoom: this.plannedMediaDownload(this.host.getLoadedLib?.(), msg),
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

  private async processInboundMessage(
    msg: WAMessage,
    opts: {
      generation: number;
      skipMedia?: boolean;
      ticket?: InboundTicket;
      yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
    },
  ): Promise<void> {
    try {
      const b = await this.host.loadLib();
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
      const normalizedRoot = b.normalizeMessageContent(msg.message ?? undefined) ?? msg.message ?? undefined;
      const contentType = b.getContentType(normalizedRoot);

      // --- protocolMessage REVOKE: don't emit onMessage ---
      if (contentType === 'protocolMessage') {
        const pm = normalizedRoot?.protocolMessage;
        if (pm?.type === b.proto.Message.ProtocolMessage.Type.REVOKE) {
          // A group admin may revoke anyone's message, so only the chat is checked there.
          if (await this.targetsForeignMessage(pm.key?.id, msg.key, !remoteJid.endsWith('@g.us'))) return;
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
          this.host.recordMessageEdit(chatJid, revoked.id, '', 'revoked');
          // While the target is still being processed, the store change waits for it and lands after
          // this delete is announced, and a repeat delivery may already hold the content in the store:
          // record the delete now, checked against the target's own key.
          const target = this.inboundInFlight.get(revoked.id);
          if (target && this.mayChange(target.key, msg.key, true)) {
            this.markDeletedForEveryone(revoked.id);
          }
          // The stored copy keeps its key, so a late re-delivery is still recognised and a delete
          // for me can still address it, but loses its content, so nothing can quote or resend it.
          this.changeStoredMessage(pm.key?.id, stored =>
            this.mayChange(stored.key, msg.key, true) ? { ...stored, message: null } : null,
          );
          this.host.getOnMessageRevoked()?.(revoked);
          return;
        }
        if (pm?.type === b.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
          if (await this.targetsForeignMessage(pm.key?.id, msg.key, true)) return;
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
              participant: msg.key.participant ?? undefined,
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
          this.host.recordMessageEdit(chatJid, edited.messageId, edited.body);
          const target = this.inboundInFlight.get(edited.messageId);
          if (target && this.mayChange(target.key, msg.key, false)) {
            this.editedWhileInFlight.delete(edited.messageId); // re-inserted as the newest
            this.editedWhileInFlight.set(edited.messageId, { envelope: msg.key, body: edited.body });
            if (this.editedWhileInFlight.size > BaileysEvents.DELETED_FOR_EVERYONE_LIMIT) {
              const [oldest] = this.editedWhileInFlight.keys();
              this.editedWhileInFlight.delete(oldest);
            }
          }
          this.changeStoredMessage(edited.messageId, stored => {
            const content = this.mayChange(stored.key, msg.key, false)
              ? b.normalizeMessageContent(stored.message ?? undefined)
              : undefined;
            return content && setBaileysText(content, edited.body) ? stored : null;
          });
          this.host.getOnMessageEdited()?.(edited);
          return;
        }
        // Other protocol messages (ephemeral, history sync, etc.) — skip silently.
        return;
      }

      // --- reactionMessage: don't emit onMessage ---
      if (contentType === 'reactionMessage') {
        const rm = normalizedRoot?.reactionMessage;
        if (await this.targetsForeignMessage(rm?.key?.id, msg.key, false, 'reaction')) return;
        const event: ReactionEvent = {
          messageId: rm?.key?.id ?? '',
          chatId: this.host.toNeutralJid(chatJid),
          reaction: rm?.text ?? '',
          // A 1:1 key names the chat partner, not the author: for a reaction the account made from
          // its phone (fromMe) the reactor is the account itself. Group and status keys carry the
          // author as `participant`, own reactions included, which the edit branch reads the same way.
          senderId: this.host.toNeutralJid(
            msg.key.participant ?? (msg.key.fromMe === true ? this.host.normalizedSelfJid() : remoteJid),
          ),
        };
        this.host.getOnMessageReaction()?.(event);
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
        if (opts.ticket) emit?.(incoming, opts.ticket);
        else emit?.(incoming);
      }
      this.host.recordMessage(msg, incoming.type);
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
    }
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
   * Whether an edit, revoke or reaction names a stored message it cannot touch: one in another chat,
   * or, with `checkAuthor`, one somebody else sent. WhatsApp clients ignore such a message, but Baileys
   * emits it as-is and the projector updates the stored row by id alone, so a contact who knows an id
   * could rewrite or erase that message. A message still being processed is checked against the key
   * it arrived under. Fails open: with no original at all, or ids that cannot be compared (see
   * {@link differentWaIds}), the event goes through as it always has.
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
  ): Promise<boolean> {
    // A message still being processed has no stored copy yet, but the projector may already hold it
    // (PostgreSQL), so its own key is checked instead.
    const original = targetId
      ? ((await this.readStoredMessage(targetId, 'checking what an edit, revoke or reaction targets'))?.key ??
        this.inboundInFlight.get(targetId)?.key)
      : undefined;
    if (!original) return false;
    const broadcast = kind === 'reaction' && !!original.remoteJid?.endsWith('@broadcast');
    if (broadcast && original.fromMe === true) return false;
    const originalChats = [original.remoteJid, original.remoteJidAlt];
    if (broadcast && original.remoteJid !== 'status@broadcast') originalChats.push(original.participant);
    const neutral = (jid: string): string => this.host.toNeutralJid(jid);
    const foreign =
      differentWaIds(originalChats, [key.remoteJid, key.remoteJidAlt], neutral) ||
      (checkAuthor &&
        ((original.fromMe === true) !== (key.fromMe === true) ||
          (key.fromMe !== true &&
            differentWaIds(
              [original.participant, original.participantAlt],
              [key.participant, key.participantAlt],
              neutral,
            ))));
    if (foreign) {
      this.host.logger.warn('Dropping an edit, revoke or reaction aimed at a message from another chat or author', {
        msgId: key.id ?? 'unknown',
        targetId,
        remoteJid: key.remoteJid,
      });
    }
    return foreign;
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
    const apply = async (): Promise<void> => this.host.updateStoredMessage(messageId, change);
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
   * Compared in the neutral dialect, and through each key's alt twin as targetsForeignMessage does, so
   * a chat or sender seen by lid once and by phone once matches even when the pair is not yet known.
   */
  private mayChange(target: WAMessageKey, envelope: WAMessageKey, isDelete: boolean): boolean {
    const neutral = (jids: Array<string | null | undefined>): string[] =>
      jids.filter((jid): jid is string => !!jid).map(jid => this.host.toNeutralJid(jid));
    const chat = (key: WAMessageKey): string[] => neutral([key.remoteJid, key.remoteJidAlt]);
    const author = (key: WAMessageKey): string[] =>
      key.fromMe === true ? ['fromMe'] : key.participant ? neutral([key.participant, key.participantAlt]) : chat(key);
    const overlap = (a: string[], b: string[]): boolean => a.some(jid => b.includes(jid));
    if (!overlap(chat(target), chat(envelope))) return false;
    const inGroup = chat(target).some(jid => parseWaId(jid).kind === 'group');
    return (isDelete && inGroup) || overlap(author(target), author(envelope));
  }

  handleMessagesUpdate(
    updates: Array<{ key?: { id?: string | null; remoteJid?: string | null }; update?: { status?: number | null } }>,
  ): void {
    for (const u of updates) {
      const status = mapBaileysStatus(u.update?.status);
      if (status && u.key?.id) {
        // Canonicalize the update's chat exactly as the inbound mapper does, so an ack's chatId
        // matches the chatId of the message events it accompanies.
        const chatId = u.key.remoteJid ? this.host.toNeutralJid(u.key.remoteJid) : undefined;
        this.host.getOnMessageAck()?.(u.key.id, status, chatId);
      }
    }
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
    const phone = userPart(selfJid);
    const lid = this.host.getSocketOrNull()?.user?.lid;
    const lidUser = lid ? userPart(lid) : undefined;
    const isSelf = (jid: string | undefined): boolean => {
      if (!jid) return false;
      const { kind, userPart: user } = parseWaId(jid);
      if (kind === 'user') return user === phone;
      if (kind !== 'lid') return false;
      if (lidUser !== undefined) return user === lidUser;
      // Creds carrying no `user.lid` leave nothing to compare a lid-addressed actor against, and
      // every such comparison would answer false: a group this session created would then be
      // reported as a join of itself. Fall back to the session's own lid to phone mapping, which the
      // store learns from the same traffic.
      return userPart(this.host.toNeutralJid(jid)) === phone;
    };
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
    // rejectCall arriving afterwards reports not-found instead of acting on a dead call. The other
    // unmapped statuses (ringing/preaccept/transport/relaylatency) are chatter on a call that is
    // still live and must stay rejectable.
    if (call.status === 'terminate') {
      this.liveCalls.delete(call.id);
      return;
    }
    const outcome = CALL_OUTCOMES[call.status];
    if (!outcome) return;

    const live = this.liveCalls.get(call.id);
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
    // The published identity is cached alongside the raw JID so a rejection issued through the API
    // can report the same shape the engine-observed outcomes do — the call event itself is long
    // gone by then.
    this.liveCalls.set(callId, { callFrom, expiresAt: now + BaileysEvents.LIVE_CALL_TTL_MS, ...published });
    return isNewCall;
  }

  /**
   * Reject a currently-ringing call. The entry is evicted before the attempt, so an outcome that
   * arrives meanwhile cannot publish a second one, and a rejected call does not become rejectable
   * again. A failed attempt leaves the call ringing, so its entry is put back for a retry unless the
   * id rang again or the connection was torn down meanwhile. An unknown id or an expired entry maps to CallNotFoundError (HTTP 404).
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
    const clears = this.liveCalls.clears;
    try {
      await withQueryDeadline(
        sock.rejectCall(callId, entry.callFrom),
        BAILEYS_QUERY_BUDGET_MS,
        'WhatsApp did not confirm the call rejection in time',
      );
    } catch (err) {
      // A teardown meanwhile ended the connection and its call handles, so the handle stays gone.
      // Known limit: an outcome that ended the call during the attempt found no entry and left no
      // trace, so the handle comes back even then, until its TTL runs out.
      if (this.liveCalls.clears === clears && !this.liveCalls.has(callId) && entry.expiresAt > Date.now()) {
        this.liveCalls.set(callId, entry);
      }
      throw err;
    }
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
    // A proxied session must not fetch media around its proxy (#859). Baileys reads the dispatcher
    // from the nested `options`; a top-level one is ignored.
    const dispatcher = this.host.getFetchDispatcher();
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
        participant: msg.key.participant ?? undefined,
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
