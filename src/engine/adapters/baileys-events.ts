import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WACallEvent, WAMessage, WAMessageKey, WASocket } from '@whiskeysockets/baileys';
import {
  EditedMessage,
  EngineEventCallbacks,
  GroupEvent,
  IncomingCallEvent,
  ParticipantPresence,
  PresenceState,
  CallOutcome,
  IncomingMessage,
  ReactionEvent,
  RevokedMessage,
} from '../interfaces/whatsapp-engine.interface';
import {
  buildIncomingMessageFromBaileys,
  extractBaileysBody,
  extractBaileysButtonReply,
  extractBaileysButtons,
  extractBaileysCommerce,
  extractBaileysContext,
  extractBaileysLocation,
  isBaileysCatalogShare,
  mapBaileysStatus,
} from './baileys-message-mapper';
import { buildEditedMessage } from './message-mapper';
import { toUnixSeconds } from './baileys-history';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import {
  capInboundMedia,
  coerceDeclaredSize,
  inboundMediaMaxBytes,
  inboundMediaTimeoutMs,
  isMediaDownloadEnabled,
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
  recordMessage(msg: WAMessage): void;
  /** Apply a message edit to the stored body. */
  recordMessageEdit(chatId: string, messageId: string, text: string): void;
  /** Persist an inbound message to the store; undefined when no store is configured. */
  putStoredMessage(msg: WAMessage): Promise<void> | undefined;
  /**
   * True exactly once for the id of a message this session sent through the API, whose library echo
   * is arriving; false for anything the session did not send (see OwnSendRegistry).
   */
  consumeOwnSend(id: string | null | undefined): boolean;
  /** A message this session already delivered or sent, from the persistent store; undefined without a store. */
  getStoredMessage(messageId: string): Promise<WAMessage | null> | undefined;
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

export class BaileysEvents {
  /** How long a received call's handle stays rejectable. Calls ring for roughly a minute, so
   *  two minutes covers the ringing window with margin without pinning dead calls for long. */
  private static readonly LIVE_CALL_TTL_MS = 2 * 60_000;

  /** Live incoming calls by call id, holding the raw `from` JID sock.rejectCall() needs — the
   *  call event is long gone by the time a reject arrives, so it must be cached at event time.
   *  Readonly reference, owned here; the adapter's lifecycle clears it on teardown. */
  readonly liveCalls = new Map<
    string,
    { callFrom: string; expiresAt: number; from: string; isVideo: boolean; isGroup: boolean }
  >();

  constructor(private readonly host: BaileysEventsHost) {}

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
      // messaging-history.set and is captured dispatch-free. A re-delivered inbound message is
      // harmless, since the insert oracle dedupes on the WhatsApp message id and does not dispatch
      // a stored message again. That oracle does NOT gate dispatch on the own-send path, which is
      // why the echo has to be caught here, and why a fromMe message the store already holds is
      // dropped in processInboundMessage before it can be reported a second time.
      //
      // Only ids this session SENT are consumed here. Claiming every inbound fromMe id instead, to
      // close the window where two deliveries of one id arrive before the store write commits, costs
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
      void this.host.inboundLimiter
        .run(() => this.processInboundMessage(msg))
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
          return this.processInboundMessage(msg, { skipMedia: true });
        });
    }
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

  private async processInboundMessage(msg: WAMessage, opts?: { skipMedia?: boolean }): Promise<void> {
    try {
      const b = await this.host.loadLib();
      const remoteJid = msg.key.remoteJid!;
      // Learn any lid->pn pair the key carries BEFORE canonicalizing ids below, so a fresh @lid
      // sender resolves to its phone in this message and for later contact lookups (#362). The pairs
      // also write through to the persistent lid->phone table via addLidMappings.
      this.host.recordKeyLidMappings(msg.key);
      // A live disappearing message (also viewOnce / documentWithCaption / edited) arrives wrapped, so the
      // raw `getContentType` returns the OUTER wrapper key (e.g. 'ephemeralMessage') and downstream type/
      // body/media/location detection would miss the real inner content. Normalize ONCE so the true inner
      // type drives routing here AND mapMessage. normalizeMessageContent leaves protocolMessage and
      // reactionMessage untouched, so the early-return branches below still match.
      const normalizedRoot = b.normalizeMessageContent(msg.message ?? undefined) ?? msg.message ?? undefined;
      const contentType = b.getContentType(normalizedRoot);

      // --- protocolMessage REVOKE: don't emit onMessage ---
      if (contentType === 'protocolMessage') {
        const pm = msg.message?.protocolMessage;
        if (pm?.type === b.proto.Message.ProtocolMessage.Type.REVOKE) {
          const from = msg.key.fromMe === true ? this.host.normalizedSelfJid() : remoteJid;
          const to = msg.key.fromMe === true ? remoteJid : this.host.normalizedSelfJid();
          const revoked: RevokedMessage = {
            id: pm.key?.id ?? '',
            // The REVOKE protocolMessage's key points at the ORIGINAL deleted message,
            // so `id` already IS the original here. Mirror it into `revokedId` so that
            // field is the reliable cross-engine handle (wwebjs sets it separately).
            revokedId: pm.key?.id ?? undefined,
            chatId: this.host.toNeutralJid(remoteJid),
            from: this.host.toNeutralJid(from),
            to: this.host.toNeutralJid(to),
            type: 'revoked',
            body: '',
            timestamp: toUnixSeconds(msg.messageTimestamp),
          };
          this.host.getOnMessageRevoked()?.(revoked);
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
          this.host.recordMessageEdit(remoteJid, edited.messageId, edited.body);
          this.host.getOnMessageEdited()?.(edited);
          return;
        }
        // Other protocol messages (ephemeral, history sync, etc.) — skip silently.
        return;
      }

      // --- reactionMessage: don't emit onMessage ---
      if (contentType === 'reactionMessage') {
        const rm = msg.message?.reactionMessage;
        const event: ReactionEvent = {
          messageId: rm?.key?.id ?? '',
          chatId: this.host.toNeutralJid(remoteJid),
          reaction: rm?.text ?? '',
          senderId: this.host.toNeutralJid(msg.key.participant ?? remoteJid),
        };
        this.host.getOnMessageReaction()?.(event);
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
      // A fromMe message the store already holds was delivered or sent before: WhatsApp re-delivers
      // a node whose ack was lost on a drop, and the own-send path downstream dispatches message.sent
      // whatever its insert did, so the second copy has to stop here. The store is written by both
      // the inbound path below and the send path, and it survives a restart, which the registry
      // consulted in handleMessagesUpsert does not. The read fails open (see readStoredMessage).
      const ownMessageId = msg.key.fromMe === true ? (msg.key.id ?? null) : null;
      if (ownMessageId !== null && (await this.readStoredMessage(ownMessageId))) {
        this.host.logger.debug('Skipping a re-delivered message this session already recorded', {
          msgId: ownMessageId,
        });
        return;
      }
      // The account's own status post reaches the projector and is dropped there: a story is not a
      // conversation, so no `message.sent` is emitted for it. Downloading its media first is work
      // nothing consumes, and a story is a full-size photo or video. Everything else about the path
      // is kept, so the message is still recorded and still guards against a repeat delivery.
      const ownStatusPost = msg.key.fromMe === true && remoteJid === 'status@broadcast';
      const incoming = await this.mapMessage(msg, contentType, {
        skipMediaDownload: opts?.skipMedia || ownStatusPost,
      });
      if (msg.key.fromMe === true) {
        this.host.getOnMessageCreate()?.(incoming);
      } else {
        this.host.getOnMessage()?.(incoming);
      }
      void this.host.putStoredMessage(msg)?.catch(err =>
        this.host.logger.warn('Failed to persist message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      this.host.recordMessage(msg);
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
  private async readStoredMessage(messageId: string): Promise<WAMessage | null> {
    try {
      return (await this.host.getStoredMessage(messageId)) ?? null;
    } catch (err) {
      this.host.logger.warn('Could not read the message store while checking for a repeat delivery', {
        msgId: messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  handleMessagesUpdate(updates: Array<{ key?: { id?: string | null }; update?: { status?: number | null } }>): void {
    for (const u of updates) {
      const status = mapBaileysStatus(u.update?.status);
      if (status && u.key?.id) {
        this.host.getOnMessageAck()?.(u.key.id, status);
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
   * revoke/reject counterpart, so only the shared signal is surfaced. Upstream scope caveat: rc13
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
   * Reject a currently-ringing call. The entry is evicted on ANY attempt (a rejected/ended call
   * will not become rejectable again); an unknown id or an expired entry maps to CallNotFoundError
   * (HTTP 404). A failure of the library's rejectCall() itself propagates as-is.
   */
  async rejectCall(callId: string): Promise<void> {
    const entry = this.liveCalls.get(callId);
    this.liveCalls.delete(callId);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new CallNotFoundError(callId);
    }
    const sock = this.host.getSocketOrNull();
    if (!sock) {
      throw new EngineNotReadyError('Cannot reject a call before the engine is initialized.');
    }
    await withQueryDeadline(
      sock.rejectCall(callId, entry.callFrom),
      BAILEYS_QUERY_BUDGET_MS,
      'WhatsApp did not confirm the call rejection in time',
    );
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
    const download = (async (): Promise<Buffer | { overflowBytes: number }> => {
      const b = await this.host.loadLib();
      stream = (await b.downloadMediaMessage(
        msg,
        'stream',
        dispatcher ? { options: { dispatcher } as RequestInit } : {},
        {
          logger: createSilentLogger(),
          reuploadRequest: this.host.getSocket().updateMediaMessage,
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
    })();

    // A slow/trickling sender never trips the byte cap, so without a deadline it pins a concurrency
    // slot (and, on Baileys, the whole inbound handler) indefinitely. On timeout, destroy the stream
    // and treat it as no usable media.
    return withInboundDownloadTimeout(download, inboundMediaTimeoutMs(), () => {
      timedOut = true;
      stream?.destroy?.();
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
  ): Promise<IncomingMessage['media']> {
    const isMediaType =
      contentType === 'imageMessage' ||
      contentType === 'videoMessage' ||
      contentType === 'audioMessage' ||
      contentType === 'documentMessage' ||
      contentType === 'documentWithCaptionMessage' ||
      contentType === 'stickerMessage';
    if (!isMediaType) {
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
      const subMessage =
        normalizedContent.imageMessage ??
        normalizedContent.videoMessage ??
        normalizedContent.audioMessage ??
        normalizedContent.documentMessage ??
        normalizedContent.stickerMessage;
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
    const subMessage =
      normalizedContent.imageMessage ??
      normalizedContent.videoMessage ??
      normalizedContent.audioMessage ??
      normalizedContent.documentMessage ??
      normalizedContent.stickerMessage;
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
    opts?: { skipMediaDownload?: boolean },
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
    const media = await this.resolveInboundMedia(msg, contentType, content, b, opts?.skipMediaDownload === true);
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
