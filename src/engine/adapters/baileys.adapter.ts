import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WACallEvent,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import { buildIncomingMessageFromBaileys, extractBaileysBody, mapBaileysStatus } from './baileys-message-mapper';
import { buildEditedMessage } from './message-mapper';
import { mapBaileysGroup, mapBaileysGroupInfo } from './baileys-group-mapper';
import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger.js';
import {
  ChatState,
  Channel,
  ChannelMessage,
  Catalog,
  Contact,
  ContactCard,
  EngineEventCallbacks,
  EngineStatus,
  EditedMessage,
  Group,
  GroupEvent,
  GroupInfo,
  IncomingCallEvent,
  IncomingMessage,
  IWhatsAppEngine,
  Label,
  LocationInput,
  MediaInput,
  MessageReaction,
  MessageResult,
  PaginatedProducts,
  PollInput,
  Product,
  ProductQueryOptions,
  ReactionEvent,
  RevokedMessage,
  Status,
  StatusResult,
  ChatSummary,
  StatusPostOptions,
} from '../interfaces/whatsapp-engine.interface';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { CallNotFoundError } from '../../common/errors/call-not-found.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { createLogger } from '../../common/services/logger.service';
import { BaileysAdapterConfig, BaileysLogger } from '../types/baileys.types';
import { BaileysSessionStore } from './baileys-session-store';
import { buildVCard } from './vcard';
import {
  capInboundMedia,
  coerceDeclaredSize,
  inboundMediaConcurrency,
  inboundMediaMaxBytes,
  inboundMediaTimeoutMs,
  isMediaDownloadEnabled,
  withInboundDownloadTimeout,
} from './inbound-media-cap';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/** Linked-device identity shown in WhatsApp (Settings → Linked Devices). The display name is
 * operator-brandable via BAILEYS_BROWSER_NAME; it only applies to pairings made after the change. */
const BAILEYS_BROWSER: [string, string, string] = [
  process.env.BAILEYS_BROWSER_NAME?.trim() || 'OpenWA',
  'Chrome',
  '120.0.0',
];

/** Fully silent logger so Baileys does not spam stdout; diagnostics flow via connection.update. */
function createSilentLogger(): BaileysLogger {
  const noop = (): void => {};
  const logger: BaileysLogger = {
    level: 'silent',
    child: () => logger,
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  return logger;
}

const BAILEYS_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];

/**
 * Baileys logger, silent by default. Set `BAILEYS_LOG_LEVEL` (trace|debug|info|warn|error) to surface
 * Baileys' own diagnostics - the history/app-state sync decision flow ("awaiting notification", "App
 * state sync complete", MAC errors) at debug/info, and the raw decoded WA wire frames at trace. Emits
 * JSON lines to stdout (context "baileys-wire") independent of the app log level, so a run can be
 * captured with `BAILEYS_LOG_LEVEL=trace node dist/main > baileys-wire.log`.
 */
function createBaileysLogger(): BaileysLogger {
  const configured = (process.env.BAILEYS_LOG_LEVEL ?? 'silent').toLowerCase();
  if (!BAILEYS_LOG_LEVELS.includes(configured)) {
    return createSilentLogger();
  }
  const threshold = BAILEYS_LOG_LEVELS.indexOf(configured);
  const write =
    (lvl: string) =>
    (obj: unknown, msg?: string): void => {
      if (BAILEYS_LOG_LEVELS.indexOf(lvl) < threshold) {
        return;
      }
      const rec =
        typeof obj === 'string' ? { msg: obj } : { ...(obj as Record<string, unknown>), ...(msg ? { msg } : {}) };
      process.stdout.write(
        JSON.stringify({ ts: new Date().toISOString(), level: lvl, context: 'baileys-wire', ...rec }) + '\n',
      );
    };
  const logger: BaileysLogger = {
    level: configured,
    child: () => logger,
    trace: write('trace'),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
  return logger;
}

export class BaileysAdapter implements IWhatsAppEngine {
  /** A close this long after the previous close means the connection had been healthy in between —
   *  the backoff counter restarts from scratch instead of inheriting an old incident's attempts. */
  private static readonly RECONNECT_STABILITY_RESET_MS = 5 * 60_000;

  private readonly logger = createLogger('BaileysAdapter');
  // Bound concurrent inbound media downloads: each materialises a full decrypted buffer in heap, so an
  // unbounded fire-and-forget loop lets a sender flood the gateway with N parallel multi-MB allocations.
  private readonly inboundLimiter = new ConcurrencyLimiter(
    inboundMediaConcurrency(),
    // Queue cap == active slots: beyond (active + queued) concurrent media messages, reject instead of
    // parking, so a burst can't grow heap without bound (each parked closure holds the message).
    inboundMediaConcurrency(),
  );
  private readonly authPath: string;
  private readonly sessionStore: BaileysSessionStore;
  private sock: WASocket | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private intentionalClose = false;
  private connecting = false;
  /** Unix-seconds timestamp of the last 'open' connection.update, used to distinguish a genuinely
   *  live message misfiled as 'append' (see handleMessagesUpsert) from real history backfill. */
  private connectedAt = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** How long a received call's handle stays rejectable. Calls ring for roughly a minute, so
   *  two minutes covers the ringing window with margin without pinning dead calls for long. */
  private static readonly LIVE_CALL_TTL_MS = 2 * 60_000;
  /** Live incoming calls by call id, holding the raw `from` JID sock.rejectCall() needs — the
   *  call event is long gone by the time a reject arrives, so it must be cached at event time. */
  private readonly liveCalls = new Map<string, { callFrom: string; expiresAt: number }>();
  /** Date.now() of the last close that scheduled a reconnect — input to the stability reset. */
  private lastConnectionCloseAt = 0;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  private lib?: typeof BaileysLib;

  private async loadLib(): Promise<typeof BaileysLib> {
    return (this.lib ??= await import('@whiskeysockets/baileys'));
  }

  constructor(private readonly config: BaileysAdapterConfig) {
    // Isolate each session's auth state under its own subdirectory of the shared auth dir.
    this.authPath = path.join(config.authDir, config.sessionId);
    this.sessionStore = new BaileysSessionStore(config.lidMappingStore, config.sessionId);
    if (config.proxyUrl) {
      // Proxy support is gated for this slice — Baileys proxying needs an http/socks agent (a new dep).
      this.logger.warn('Proxy configured but not supported by the baileys engine in this slice; ignoring it', {
        action: 'baileys_proxy_unsupported',
        sessionId: config.sessionId,
      });
    }
  }

  // ----- Lifecycle -----

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.intentionalClose = false;
    try {
      await this.connect();
    } catch (err) {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async connect(): Promise<void> {
    // I4: in-flight guard — skip if a connect() is already in progress.
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      await this.connectInner();
    } finally {
      this.connecting = false;
    }
  }

  private async connectInner(): Promise<void> {
    this.setStatus(EngineStatus.INITIALIZING);
    const b = await this.loadLib();
    const { state, saveCreds } = await b.useMultiFileAuthState(this.authPath);
    const { version } = await b.fetchLatestBaileysVersion();
    // BaileysLogger matches ILogger exactly; cast needed because the module resolves the type
    // through a deep import path that TypeScript does not auto-unify here. Shared by the key
    // store wrapper below and the socket itself, rather than constructing two instances.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileysLogger = createBaileysLogger() as unknown as ILogger;

    // Wrap the raw file-backed signal key store with Baileys' own official caching layer.
    // Without it, every session read/write hits disk directly with no protection against a
    // write-then-immediate-read race — observed here as a freshly-established Signal session
    // appearing "missing" moments later, forcing Baileys to discard it and start a brand new
    // PreKey handshake on the very next send (visible as repeated "Closing session" log spam and
    // the recipient stuck on "waiting for this message" until a slow WhatsApp-side retry rescues
    // it). makeCacheableSignalKeyStore keeps the just-written state visible in memory immediately,
    // regardless of disk I/O timing.
    state.keys = b.makeCacheableSignalKeyStore(state.keys, baileysLogger);

    // C2: resurrect-after-stop guard — if disconnect/logout/destroy ran during the awaits above,
    // bail now so we don't create a live socket for a session that was intentionally stopped.
    if (this.intentionalClose) {
      return;
    }

    // An internal reconnect (transient drop) overwrites this.sock WITHOUT going through
    // disconnect/logout/destroy, so the previous socket's WebSocket and the 13 ev listeners we
    // register below would leak on every reconnect. Tear the prior socket down first. Detach OUR
    // connection.update listener BEFORE end(): Baileys' own end() synchronously emits a synthetic
    // connection.update {connection:'close'}, which — if still wired — would re-enter
    // handleConnectionUpdate and schedule a spurious second reconnect.
    const previous = this.sock;
    if (previous) {
      try {
        previous.ev.removeAllListeners('connection.update');
        previous.ev.removeAllListeners('creds.update');
        previous.ev.removeAllListeners('messages.upsert');
        previous.ev.removeAllListeners('messages.update');
        previous.ev.removeAllListeners('contacts.upsert');
        previous.ev.removeAllListeners('contacts.update');
        previous.ev.removeAllListeners('chats.upsert');
        previous.ev.removeAllListeners('chats.update');
        previous.ev.removeAllListeners('messaging-history.set');
        previous.ev.removeAllListeners('lid-mapping.update');
        previous.ev.removeAllListeners('group-participants.update');
        previous.ev.removeAllListeners('groups.update');
        previous.ev.removeAllListeners('call');
        void previous.end(undefined);
      } catch {
        // end() may already have run from Baileys' own close handler — a safe no-op.
      }
    }

    const sock = b.default({
      auth: state,
      version,
      browser: BAILEYS_BROWSER,
      printQRInTerminal: false,
      // Enable the initial sync. Baileys defaults `shouldSyncHistoryMessage` to `() => !!syncFullHistory`,
      // so leaving both unset disables ALL history + app-state sync - no contacts, chats, recent history,
      // or lid->phone mappings ever arrive (the address-book app-state sync only runs once history sync is
      // enabled; see WhiskeySockets/Baileys Socket/index.js + Socket/chats.js). Returning true enables it
      // while keeping the full-archive download opt-in: with syncFullHistory false WhatsApp sends the
      // RECENT window + the full contact/app-state snapshot, not the entire message history.
      shouldSyncHistoryMessage: () => true,
      syncFullHistory: process.env.BAILEYS_SYNC_FULL_HISTORY === 'true',
      // Baileys defaults this to `async () => undefined` (Defaults/index.js). Without a real
      // implementation, WhatsApp's message-retry protocol — triggered whenever a recipient's client
      // fails to decrypt on the first attempt — has nothing to resend, so the recipient is stuck on
      // "waiting for this message" indefinitely instead of the retry resolving it within seconds.
      // Backed by the same messageStore used for reply/forward/react/delete-by-id.
      getMessage: async key => {
        if (!key.id) {
          return undefined;
        }
        const stored = await this.config.messageStore?.getMessage(this.config.dbSessionId, key.id);
        return stored?.message ?? undefined;
      },
      logger: baileysLogger,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => void saveCreds());
    sock.ev.on('connection.update', update => this.handleConnectionUpdate(update));
    sock.ev.on('messages.upsert', event => this.handleMessagesUpsert(event));
    sock.ev.on('messages.update', updates => this.handleMessagesUpdate(updates));
    sock.ev.on('contacts.upsert', contacts => {
      this.logContactEvent('contacts.upsert', contacts);
      this.sessionStore.upsertContacts(contacts);
    });
    sock.ev.on('contacts.update', updates => {
      this.logContactEvent('contacts.update', updates);
      this.sessionStore.upsertContacts(updates);
    });
    sock.ev.on('chats.upsert', chats => {
      this.logger.debug('Baileys chats event', { action: 'baileys_chats', event: 'upsert', count: chats?.length ?? 0 });
      this.sessionStore.upsertChats(chats);
    });
    sock.ev.on('chats.update', updates => {
      this.logger.debug('Baileys chats event', {
        action: 'baileys_chats',
        event: 'update',
        count: updates?.length ?? 0,
      });
      this.sessionStore.upsertChats(updates);
    });
    sock.ev.on('group-participants.update', event => this.handleGroupParticipantsUpdate(event));
    sock.ev.on('groups.update', updates => this.handleGroupsUpdate(updates));
    sock.ev.on('messaging-history.set', history => {
      this.sessionStore.upsertContacts(history.contacts);
      this.sessionStore.upsertChats(history.chats);
      this.sessionStore.addLidMappings(history.lidPnMappings ?? []);
      void this.captureHistoryMessages(history.messages ?? []);
      this.logger.debug('History sync received', {
        action: 'baileys_history_set',
        sessionId: this.config.sessionId,
        syncType: history.syncType,
        isLatest: history.isLatest,
        progress: history.progress,
        chats: history.chats?.length ?? 0,
        messages: history.messages?.length ?? 0,
        contacts: history.contacts?.length ?? 0,
        namedContacts: history.contacts?.filter(c => c.name || c.notify).length ?? 0,
        lidContacts: history.contacts?.filter(c => c.lid).length ?? 0,
        lidPnMappings: history.lidPnMappings?.length ?? 0,
      });
    });
    // WhatsApp pushes this when a lid<->phone mapping is learned (renamed from the pre-v7
    // 'chats.phoneNumberShare' event, whose { lid, jid } payload this shape directly replaces).
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => this.sessionStore.addLidMappings([{ lid, pn }]));
    sock.ev.on('call', calls => this.handleCallEvents(calls));
  }

  private handleConnectionUpdate(update: {
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: unknown };
  }): void {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      // Baileys hands us the raw QR ref string; render it to a PNG data URL so the stored
      // value matches the whatsapp-web.js engine's contract (the dashboard does <img src={qrCode}>).
      void this.handleQrCode(qr);
    }

    if (connection === 'connecting') {
      this.setStatus(EngineStatus.INITIALIZING);
    }

    if (connection === 'open') {
      this.qrCode = null;
      this.phoneNumber = this.extractPhone(this.sock?.user?.id);
      this.pushName = this.sock?.user?.name ?? null;
      // I4: reset the reconnect counter on a successful connection.
      this.reconnectAttempts = 0;
      // Small backward buffer for clock skew between this host and WhatsApp's server (messageTimestamp
      // is WA's clock, Date.now() is ours) — without it, a message sent right at reconnect time could
      // land a couple seconds "before" connectedAt and be misjudged as history.
      this.connectedAt = Math.floor(Date.now() / 1000) - 10;
      this.setStatus(EngineStatus.READY);
      this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
      // Backfill names the initial sync skipped (see hydrateNames).
      void this.hydrateNames();
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;

      if (this.intentionalClose) {
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }

      if (statusCode === this.lib?.DisconnectReason.loggedOut) {
        // Credentials invalidated — terminal. Re-linking requires a fresh QR/pairing, so the now-dead
        // multi-file auth dir MUST be wiped: otherwise the next connect() reloads the stale creds and
        // Baileys silently retries them instead of emitting a new QR, leaving the session stuck (no QR).
        this.setStatus(EngineStatus.DISCONNECTED);
        this.sock = null;
        // Cached call handles die with the connection — drop them so a later rejectCall() reports
        // not-found (404) instead of acting on a dead socket (mirrors disconnect/logout/destroy).
        this.liveCalls.clear();
        void this.clearAuthState();
        this.callbacks.onDisconnected?.('logged out');
        return;
      }

      if (statusCode === (this.lib?.DisconnectReason.connectionReplaced ?? 440)) {
        // Another live instance took over this account. Reconnecting
        // would fight it — two instances endlessly replacing each other — so this is terminal:
        // the operator stops the other instance, then starts this session again (onError = terminal
        // + evict in the session service). Auth state is NOT cleared: the link itself is still valid.
        this.setStatus(EngineStatus.FAILED);
        this.liveCalls.clear(); // terminal close: dead call handles, like the loggedOut branch above
        this.callbacks.onError?.(
          'Connection replaced by another instance (440) — stop the other instance, then start this session again',
        );
        return;
      }

      if (statusCode === (this.lib?.DisconnectReason.forbidden ?? 403)) {
        // The account itself was rejected by WhatsApp (banned/blocked — an authorization-level
        // refusal that must not be retried). Retrying forever is pointless and risks worsening
        // the account's standing, so this is terminal like 440. Auth state is NOT cleared (unlike
        // 401): this is an account-level refusal, not dead credentials — the operator keeps the auth
        // files for inspection and can retry manually once the account issue is resolved.
        this.setStatus(EngineStatus.FAILED);
        this.liveCalls.clear(); // terminal close: dead call handles, like the loggedOut branch above
        this.callbacks.onError?.(
          'Account rejected by WhatsApp (403) — the number is likely banned or blocked; reconnecting will not help',
        );
        return;
      }

      // Every other close (408/411/428/500/503/515/undefined) is transient: reconnect with capped
      // backoff and NO attempt ceiling — a long network outage must
      // not kill the session. The counter resets on 'open' and via the stability window below.
      // Do NOT fire onDisconnected here; this is a transient drop, not a terminal disconnect.
      // connect() calls setStatus(INITIALIZING) which fires onStateChanged — that is the correct signal.
      this.logger.log('Baileys connection dropped; reconnecting', { statusCode });

      // Duplicate close while a reconnect timer is already pending — ignore it WITHOUT burning an
      // attempt (Baileys can emit more than one close per drop; the increment must come after this).
      if (this.reconnectTimer) {
        return;
      }

      // Stability reset: a close >5 min after the previous one means the connection had been
      // healthy in between — start the backoff fresh instead of inheriting the old counter.
      const now = Date.now();
      if (now - this.lastConnectionCloseAt > BaileysAdapter.RECONNECT_STABILITY_RESET_MS) {
        this.reconnectAttempts = 0;
      }
      this.lastConnectionCloseAt = now;
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule the next reconnect attempt with capped exponential backoff (1 s doubling up to a 60 s
   * cap, plus up to 1 s jitter). Deliberately NO attempt ceiling: transient drops retry forever —
   * only loggedOut (401), forbidden (403), and connectionReplaced (440) are terminal. A connect()
   * failure inside the attempt is just a failed attempt: warn and schedule the next one.
   */
  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** (this.reconnectAttempts - 1)) + Math.floor(Math.random() * 1000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionalClose) {
        return; // stopped while waiting — abort
      }
      void this.connect().catch(err => {
        // A failed attempt (e.g. fetchLatestBaileysVersion offline mid-outage) is NOT terminal —
        // the outage may outlast any fixed attempt budget, so schedule the following attempt.
        this.logger.warn('Baileys reconnect attempt failed; will retry', {
          attempt: this.reconnectAttempts,
          error: err instanceof Error ? err.message : String(err),
        });
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Render the raw Baileys QR ref to a PNG data URL, then publish it (mirrors the whatsapp-web.js engine). */
  private async handleQrCode(qr: string): Promise<void> {
    try {
      this.qrCode = await qrcode.toDataURL(qr);
      this.setStatus(EngineStatus.QR_READY);
      this.callbacks.onQRCode?.(this.qrCode);
    } catch (error) {
      this.logger.error('Error generating QR code', String(error));
    }
  }

  disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    void this.sock?.end(undefined);
    this.sock = null;
    // Cached call handles die with the socket — drop them so a later rejectCall() reports
    // not-found instead of acting on a closed connection.
    this.liveCalls.clear();
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      await this.sock?.logout();
    } catch (err) {
      this.logger.warn('Baileys logout failed; ending socket', {
        error: err instanceof Error ? err.message : String(err),
      });
      void this.sock?.end(undefined);
    }
    this.sock = null;
    this.liveCalls.clear();
    this.setStatus(EngineStatus.DISCONNECTED);
    await this.config.messageStore?.clearSession(this.config.dbSessionId).catch(() => undefined);
    // Wipe the multi-file auth dir so a fresh link starts clean — stale creds would otherwise be
    // reloaded on the next connect() and block re-linking (Baileys retries them, no QR emitted).
    await this.clearAuthState();
  }

  /**
   * Delete this session's on-disk multi-file auth state (`authDir/sessionId`). Required after a terminal
   * logout: Baileys would otherwise reload the now-invalid creds on the next connect() and retry them
   * instead of emitting a fresh QR, leaving re-linking stuck. `force` makes a missing dir a no-op.
   */
  private async clearAuthState(): Promise<void> {
    try {
      await fs.promises.rm(this.authPath, { recursive: true, force: true });
      this.logger.log('Cleared Baileys auth state', { authPath: this.authPath });
    } catch (err) {
      this.logger.warn('Failed to clear Baileys auth state', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  destroy(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    void this.sock?.end(undefined);
    this.sock = null;
    this.liveCalls.clear();
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  // Baileys has no separate Chromium process to SIGKILL (destroy() already ends the socket
  // synchronously), so a force-destroy is just a destroy.
  forceDestroy(): Promise<void> {
    return this.destroy();
  }

  // ----- Status -----

  getStatus(): EngineStatus {
    return this.status;
  }

  /**
   * Cheap local liveness check for the session watchdog. Genuine dead-connection detection is owned
   * by Baileys' built-in keepalive, which surfaces a close event (408) within ~35 s of a silent
   * drop and drives the reconnect path above — so READY + a live socket is sufficient here.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async probeLiveness(): Promise<boolean> {
    return this.status === EngineStatus.READY && this.sock != null;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) {
      throw new EngineNotReadyError('Cannot request a pairing code before the engine is initialized.');
    }
    return this.sock.requestPairingCode(phoneNumber);
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  // ----- Messaging -----

  async sendTextMessage(chatId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    this.ensureReady();
    const jid = await this.toDeliverableJid(chatId);
    const options = this.withEphemeral(jid);
    const content = { text, ...this.withMentions(mentions) };
    const sent = options
      ? await this.sock!.sendMessage(jid, content, options)
      : await this.sock!.sendMessage(jid, content);
    if (sent) {
      void this.config.messageStore?.put(this.config.dbSessionId, sent).catch(err =>
        this.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // Parity with the wwjs engine's message_create → message.sent (see emitOwnSendEcho).
      void this.emitOwnSendEcho(sent);
    }
    return {
      id: sent?.key?.id ?? '',
      timestamp: this.toUnixSeconds(sent?.messageTimestamp),
    };
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async getNumberId(number: string): Promise<string | null> {
    this.ensureReady();
    const results = await this.sock!.onWhatsApp(number);
    const hit = results?.[0];
    // Baileys returns a raw `<phone>@s.whatsapp.net`; neutralize it before it crosses the engine
    // boundary so the value matches whatsapp-web.js (`<phone>@c.us`) and the IWhatsAppEngine contract
    // (no raw `@s.whatsapp.net` in a neutral field). It also round-trips back to a send on either engine.
    return hit?.exists ? this.sessionStore.toNeutralJid(hit.jid) : null;
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.ensureReady();
    const presence = state === 'typing' ? 'composing' : state === 'recording' ? 'recording' : 'paused';
    try {
      await this.sock!.sendPresenceUpdate(presence, await this.toDeliverableJid(chatId));
    } catch (error) {
      // Presence is best-effort — a failure here must never surface as a 500 on the direct typing
      // endpoint or MCP tool (mirrors the whatsapp-web.js adapter; #583 R4). A migrated contact can
      // yield `No LID for user` on the presence path even when the actual send succeeds.
      this.logger.warn(`Could not set chat state '${state}' for ${chatId} (best-effort)`, { error: String(error) });
    }
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, {
      image: data,
      caption: media.caption,
      mimetype,
      ...this.withMentions(media.mentions),
    });
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, {
      video: data,
      caption: media.caption,
      mimetype,
      ...this.withMentions(media.mentions),
    });
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, { audio: data, mimetype, ptt: media.ptt ?? false });
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, {
      document: data,
      mimetype,
      fileName: media.filename ?? 'file',
      caption: media.caption,
      ...this.withMentions(media.mentions),
    });
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, { sticker: data });
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    return this.sendContent(chatId, {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.description,
        address: location.address,
      },
    });
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    return this.sendContent(chatId, {
      contacts: { displayName: contact.name, contacts: [{ vcard: buildVCard(contact) }] },
    });
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    this.ensureReady();
    // selectableCount 1 = single choice; 0 = no limit, which is how WhatsApp expresses
    // "allow multiple answers". Baileys generates the poll's messageSecret itself.
    return this.sendContent(chatId, {
      poll: {
        name: poll.name,
        values: poll.options,
        selectableCount: poll.allowMultipleAnswers ? 0 : 1,
      },
    });
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const quoted = await this.requireStored(quotedMsgId);
    return this.sendContent(chatId, { text }, { quoted });
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const forward = await this.requireStored(messageId);
    return this.sendContent(toChatId, { forward });
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const target = await this.requireStored(messageId);
    await this.sock!.sendMessage(chatId, { react: { text: emoji, key: target.key } });
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone = true): Promise<void> {
    this.ensureReady();
    const target = await this.requireStored(messageId);
    if (forEveryone) {
      await this.sock!.sendMessage(chatId, { delete: target.key });
      return;
    }
    // Delete-for-me (revoke on this device only): Baileys exposes it as a chat modification, not a
    // sendMessage. The stored message timestamp (epoch seconds) is part of the payload.
    await this.sock!.chatModify(
      {
        deleteForMe: {
          deleteMedia: true,
          key: target.key,
          timestamp: this.toUnixSeconds(target.messageTimestamp),
        },
      },
      chatId,
    );
  }

  async editMessage(chatId: string, messageId: string, body: string): Promise<MessageResult> {
    this.ensureReady();
    const target = await this.requireStored(messageId);
    // Only the account's own messages are editable: WhatsApp refuses the edit of an inbound message
    // but the send would still resolve, dressing the refusal up as success (and the service layer
    // would then "update" the stored body). Refuse first — mirrors the wwjs null-edit guard.
    if (target.key.fromMe !== true) {
      throw new EngineRefusedError(
        `the edit of message ${messageId} was rejected — only the account's own messages can be edited`,
      );
    }
    // The stored key must belong to the requested chat — editing with another chat's key is a
    // not-found here, not a cross-chat write. Both sides are neutralized so @c.us/@s.whatsapp.net
    // (and a known lid<->pn twin) compare equal.
    if (this.sessionStore.toNeutralJid(target.key.remoteJid ?? '') !== this.sessionStore.toNeutralJid(chatId)) {
      throw new MessageNotFoundError(messageId, chatId);
    }
    // An edit keeps the original message id, so it is neither re-persisted nor echoed as a new send.
    // The destination is resolved like any other send: a lid-migrated contact rejects PN-addressed
    // sends with ack error 463 (see toDeliverableJid).
    const jid = await this.toDeliverableJid(chatId);
    const sent = await this.sock!.sendMessage(jid, { text: body, edit: target.key });
    return { id: sent?.key?.id ?? messageId, timestamp: this.toUnixSeconds(sent?.messageTimestamp) };
  }

  // ----- Groups -----

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    const all = await this.sock!.groupFetchAllParticipating();
    const self = this.normalizedSelfJid();
    return Object.values(all).map(metadata =>
      mapBaileysGroup(metadata, self, jid => this.sessionStore.toNeutralJid(jid)),
    );
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const metadata = await this.sock!.groupMetadata(groupId);
      return mapBaileysGroupInfo(metadata, jid => this.sessionStore.toNeutralJid(jid));
    } catch (err) {
      this.logger.debug('groupMetadata failed; treating as not-found', {
        groupId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null; // not a group / not found
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    const metadata = await this.sock!.groupCreate(name, this.toEngineParticipants(participants));
    return mapBaileysGroup(metadata, this.normalizedSelfJid(), jid => this.sessionStore.toNeutralJid(jid));
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), 'add');
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), 'remove');
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), 'promote');
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), 'demote');
  }

  /**
   * Fold neutral `<phone>@c.us` participant ids back to the engine wire dialect (`@s.whatsapp.net`) before
   * a group write. `@lid` (a first-class addressing mode) and the group id itself are left untouched.
   */
  private toEngineParticipants(participants: string[]): string[] {
    return participants.map(p => this.sessionStore.toEngineJid(p));
  }

  /**
   * Build the `{ mentions }` slice of a Baileys message content, de-normalizing neutral `@c.us` WIDs to
   * the engine dialect. Returns an empty object when none are given so the content is byte-identical to
   * the pre-#530 send (no stray `mentions` key). The text must still contain the `@<number>` token for
   * WhatsApp to render the tag — that is the caller's responsibility.
   */
  private withMentions(mentions?: string[]): { mentions?: string[] } {
    return mentions?.length ? { mentions: this.toEngineParticipants(mentions) } : {};
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.groupLeave(groupId);
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    await this.sock!.groupUpdateSubject(groupId, subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    await this.sock!.groupUpdateDescription(groupId, description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    return (await this.sock!.groupInviteCode(groupId)) ?? '';
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    return (await this.sock!.groupRevokeInvite(groupId)) ?? '';
  }

  async joinGroupViaInviteCode(inviteCode: string): Promise<string> {
    this.ensureReady();
    // Baileys resolves undefined when the invite is invalid/expired/revoked — no group id surfaces —
    // and rejects with an IQ error (e.g. not-authorized / gone) for the same client-facing cause.
    // Both map to a 400, not a 500.
    let jid: string | undefined;
    try {
      jid = await this.sock!.groupAcceptInvite(inviteCode);
    } catch {
      jid = undefined;
    }
    if (!jid) {
      throw new InvalidInviteCodeError();
    }
    // The returned group JID crosses the engine boundary, so it is neutralized like every other emission.
    return this.sessionStore.toNeutralJid(jid);
  }

  async setGroupMessagesAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    this.ensureReady();
    await this.sock!.groupSettingUpdate(groupId, adminsOnly ? 'announcement' : 'not_announcement');
  }

  async setGroupInfoAdminsOnly(groupId: string, adminsOnly: boolean): Promise<void> {
    this.ensureReady();
    await this.sock!.groupSettingUpdate(groupId, adminsOnly ? 'locked' : 'unlocked');
  }

  async setGroupEphemeral(groupId: string, durationSec: number): Promise<void> {
    this.ensureReady();
    await this.sock!.groupToggleEphemeral(groupId, durationSec);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      return (await this.sock!.profilePictureUrl(contactId, 'image')) ?? null;
    } catch (err) {
      this.logger.debug('profilePictureUrl failed; no picture or hidden', {
        contactId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null; // no picture set, or hidden by privacy
    }
  }

  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.updateBlockStatus(contactId, 'block');
  }

  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.updateBlockStatus(contactId, 'unblock');
  }

  // ----- Profile (own account) -----

  async setProfileName(name: string): Promise<void> {
    this.ensureReady();
    await this.sock!.updateProfileName(name);
  }

  async setProfileStatus(status: string): Promise<void> {
    this.ensureReady();
    await this.sock!.updateProfileStatus(status);
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    this.ensureReady();
    const selfJid = this.normalizedSelfJid();
    if (!selfJid) {
      throw new Error('cannot set the profile picture: the own JID is not known yet');
    }
    // updateProfilePicture takes a WAMediaUpload; resolveMediaBuffer covers Buffer | base64 | URL,
    // the same conversion the media sends use.
    const { data } = await this.resolveMediaBuffer(media);
    await this.sock!.updateProfilePicture(selfJid, data);
  }

  // ----- Contacts & chats -----

  // eslint-disable-next-line @typescript-eslint/require-await
  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    return this.sessionStore.listContacts();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    return this.sessionStore.findContact(contactId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.ensureReady();
    return this.sessionStore.resolvePhone(contactId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChats(): Promise<ChatSummary[]> {
    this.ensureReady();
    return this.sessionStore.listChats();
  }

  async sendSeen(chatId: string): Promise<boolean> {
    this.ensureReady();
    const last = this.sessionStore.lastMessage(chatId);
    if (!last) {
      return false; // nothing known to mark read
    }
    await this.sock!.readMessages([last.key]);
    return true;
  }

  async markUnread(chatId: string): Promise<boolean> {
    this.ensureReady();
    const last = this.sessionStore.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' unread toggle needs the last message; can't synthesize it
    }
    await this.sock!.chatModify(
      { markRead: false, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      chatId,
    );
    return true;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    this.ensureReady();
    const last = this.sessionStore.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' delete needs the last message; can't synthesize it
    }
    await this.sock!.chatModify(
      { delete: true, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      chatId,
    );
    return true;
  }

  // ----- Gated: not supported by this minimal slice (no store) -----
  /* eslint-disable @typescript-eslint/no-unused-vars */

  getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    return this.unsupported('getMessageReactions');
  }
  getChatHistory(_chatId: string, _limit?: number, _includeMedia?: boolean): Promise<IncomingMessage[]> {
    return this.unsupported('getChatHistory');
  }
  getLabels(): Promise<Label[]> {
    return this.unsupported('getLabels');
  }
  getLabelById(_labelId: string): Promise<Label | null> {
    return this.unsupported('getLabelById');
  }
  getChatLabels(_chatId: string): Promise<Label[]> {
    return this.unsupported('getChatLabels');
  }
  // WhatsApp Business only — Baileys rejects these on personal accounts. The label must already
  // exist (use getLabels on an engine that lists them); addChatLabel/removeChatLabel associate it
  // with a chat, they do not create/edit the label definition.
  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.addChatLabel(chatId, labelId);
  }
  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.removeChatLabel(chatId, labelId);
  }
  getSubscribedChannels(): Promise<Channel[]> {
    return this.unsupported('getSubscribedChannels');
  }
  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    // newsletterMetadata resolves ANY channel by jid (richer than the wwjs subscribed-list lookup).
    const meta = await this.sock!.newsletterMetadata('jid', channelId);
    return meta ? this.toChannel(meta) : null;
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const meta = await this.sock!.newsletterMetadata('invite', inviteCode);
    if (!meta) {
      throw new ChannelNotFoundError(inviteCode);
    }
    await this.sock!.newsletterFollow(meta.id);
    return this.toChannel(meta);
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.newsletterUnfollow(channelId);
  }

  // getChannelMessages is not wired: Baileys' newsletterFetchMessages returns the RAW query
  // BinaryNode with no library parser, so mapping it to ChannelMessage[] needs a verified
  // BinaryNode walk (or a live spike) that can't be validated without a WhatsApp session. Kept as a
  // documented adapter-gap in the engine capability matrix rather than shipped as an unverified walk.
  getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    return this.unsupported('getChannelMessages');
  }

  /** Map a Baileys NewsletterMetadata to the neutral Channel shape (optionals only when present). */
  private toChannel(meta: {
    id: string;
    name: string;
    description?: string;
    invite?: string;
    creation_time?: number;
    subscribers?: number;
    picture?: { url?: string };
    verification?: string;
    thread_metadata?: { creation_time?: number };
  }): Channel {
    const createdAt = meta.creation_time ?? meta.thread_metadata?.creation_time;
    return {
      id: meta.id,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.invite ? { inviteCode: meta.invite } : {}),
      ...(meta.subscribers !== undefined ? { subscriberCount: meta.subscribers } : {}),
      ...(meta.picture?.url ? { picture: meta.picture.url } : {}),
      ...(meta.verification ? { verified: meta.verification === 'VERIFIED' } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }
  getContactStatuses(): Promise<Status[]> {
    return this.unsupported('getContactStatuses');
  }
  getContactStatus(_contactId: string): Promise<Status[]> {
    return this.unsupported('getContactStatus');
  }
  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    return this.postStatus({ text }, options);
  }
  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('image', media, options);
  }
  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('video', media, options);
  }
  private async postMediaStatus(
    kind: 'image' | 'video',
    media: MediaInput,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    const content: AnyMessageContent =
      kind === 'image'
        ? { image: data, caption: options.caption, mimetype }
        : { video: data, caption: options.caption, mimetype };
    return this.postStatus(content, options);
  }
  /**
   * Best-effort status revoke. Unlike deleteMessage, status messages are NOT persisted, so the revoke
   * key must be constructed from statusId alone (no messageStore lookup). The participant is the
   * engine-dialect self JID (`<me>@s.whatsapp.net`). The revoke shape is empirically UNVERIFIED — the
   * live spike only tested posting; if WhatsApp rejects it, fall back to EngineNotSupportedError.
   */
  async deleteStatus(statusId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.sendMessage('status@broadcast', {
      delete: {
        remoteJid: 'status@broadcast',
        fromMe: true,
        id: statusId,
        participant: this.sessionStore.toEngineJid(this.normalizedSelfJid()),
      },
    });
  }
  getCatalog(): Promise<Catalog | null> {
    return this.unsupported('getCatalog');
  }
  getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return this.unsupported('getProducts');
  }
  getProduct(_productId: string): Promise<Product | null> {
    return this.unsupported('getProduct');
  }
  sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendProduct');
  }
  sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendCatalog');
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // ----- Helpers -----

  private handleMessagesUpsert(event: { messages: WAMessage[]; type: string }): void {
    for (const msg of event.messages) {
      if (!msg.message || !msg.key?.remoteJid) {
        continue; // protocol/empty messages carry no neutral content
      }
      if (event.type !== 'notify') {
        // Baileys echoes back OUR OWN just-sent messages through this same 'append' path too, and
        // sendContent() already emits onMessageCreate for those via emitOwnSendEcho() — always
        // exclude fromMe here (unconditionally, regardless of timestamp) so that echo doesn't fire
        // onMessageCreate a second time.
        if (msg.key.fromMe === true) {
          continue;
        }
        // For everyone else: gate on the message's own timestamp vs. this connection's open time,
        // not the upsert batch's `type` tag. `type: 'append'` usually means real history-sync
        // backfill, but Baileys can also tag a genuinely new CUSTOMER message 'append' when it
        // arrives in the same window as a reconnect's state-sync handshake — a strict
        // `type !== 'notify'` filter silently drops that message (observed as "the first message
        // after a reconnect gets ignored"). A message sent AFTER this connection opened is live
        // regardless of which tag the batch carries; true backfill always predates it.
        if (this.toUnixSeconds(msg.messageTimestamp) < this.connectedAt) {
          continue;
        }
      }
      // Throttle through the limiter so a burst of media messages can't run unbounded parallel
      // downloads (each a full decrypted buffer in heap). Ordering stays correct — the message store
      // keeps the newest by timestamp. When the waiter queue is saturated we REJECT instead of parking
      // forever, and re-process the message WITHOUT media: the message (body + metadata) is still
      // emitted, but we skip the heap-heavy download that the limiter exists to bound.
      void this.inboundLimiter
        .run(() => this.processInboundMessage(msg))
        .catch(() => {
          this.logger.warn('Inbound media limiter saturated; emitting message without media', {
            msgId: msg.key?.id ?? 'unknown',
          });
          return this.processInboundMessage(msg, { skipMedia: true });
        });
    }
  }

  /** Diagnostic: log a contacts event's size + whether records carry names/lids (and a small sample). */
  private logContactEvent(
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
    this.logger.debug('Baileys contacts event', {
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
      const b = await this.loadLib();
      const remoteJid = msg.key.remoteJid!;
      // Learn any lid->pn pair the key carries BEFORE canonicalizing ids below, so a fresh @lid
      // sender resolves to its phone in this message and for later contact lookups (#362). The pairs
      // also write through to the persistent lid->phone table via addLidMappings.
      this.sessionStore.recordKeyLidMappings(msg.key);
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
          const from = msg.key.fromMe === true ? this.normalizedSelfJid() : remoteJid;
          const to = msg.key.fromMe === true ? remoteJid : this.normalizedSelfJid();
          const revoked: RevokedMessage = {
            id: pm.key?.id ?? '',
            // The REVOKE protocolMessage's key points at the ORIGINAL deleted message,
            // so `id` already IS the original here. Mirror it into `revokedId` so that
            // field is the reliable cross-engine handle (wwebjs sets it separately).
            revokedId: pm.key?.id ?? undefined,
            chatId: this.sessionStore.toNeutralJid(remoteJid),
            from: this.sessionStore.toNeutralJid(from),
            to: this.sessionStore.toNeutralJid(to),
            type: 'revoked',
            body: '',
            timestamp: this.toUnixSeconds(msg.messageTimestamp),
          };
          this.callbacks.onMessageRevoked?.(revoked);
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
              selfJid: this.normalizedSelfJid(),
              mentionedJids: contextInfo?.mentionedJid ?? undefined,
            },
            jid => this.sessionStore.toNeutralJid(jid),
          );
          const hasMedia =
            editedContentType === 'imageMessage' ||
            editedContentType === 'videoMessage' ||
            editedContentType === 'audioMessage' ||
            editedContentType === 'documentMessage' ||
            editedContentType === 'documentWithCaptionMessage' ||
            editedContentType === 'stickerMessage';
          const edited: EditedMessage = buildEditedMessage(base, hasMedia);
          this.sessionStore.recordMessageEdit(remoteJid, edited.messageId, edited.body);
          this.callbacks.onMessageEdited?.(edited);
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
          chatId: this.sessionStore.toNeutralJid(remoteJid),
          reaction: rm?.text ?? '',
          senderId: this.sessionStore.toNeutralJid(msg.key.participant ?? remoteJid),
        };
        this.callbacks.onMessageReaction?.(event);
        return;
      }

      // --- Normal message: enrich + emit ---
      const incoming = await this.mapMessage(msg, contentType, { skipMediaDownload: opts?.skipMedia });
      if (msg.key.fromMe === true) {
        this.callbacks.onMessageCreate?.(incoming);
      } else {
        this.callbacks.onMessage?.(incoming);
      }
      void this.config.messageStore?.put(this.config.dbSessionId, msg).catch(err =>
        this.logger.warn('Failed to persist message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      this.sessionStore.recordMessage(msg);
    } catch (err) {
      this.logger.error(
        `Unhandled error processing inbound message (id=${msg.key?.id ?? 'unknown'}); dropping`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private handleMessagesUpdate(
    updates: Array<{ key?: { id?: string | null }; update?: { status?: number | null } }>,
  ): void {
    for (const u of updates) {
      const status = mapBaileysStatus(u.update?.status);
      if (status && u.key?.id) {
        this.callbacks.onMessageAck?.(u.key.id, status);
      }
    }
  }

  /**
   * Baileys `group-participants.update`: a membership change. Only add/remove map to the neutral
   * join/leave kinds — promote/demote (and 'modify', a phone-number-change rewrite) change no
   * membership and are skipped. The event carries no timestamp, so it is stamped at receipt.
   */
  private handleGroupParticipantsUpdate(event: {
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
      groupId: this.sessionStore.toNeutralJid(event.id),
      participantIds,
      timestamp: Math.floor(Date.now() / 1000),
    };
    // authorPn is the phone-dialect twin of a lid author: prefer it so the neutral actor id does
    // not depend on whether the lid->pn mapping happens to be learned yet.
    const actor = event.authorPn ?? event.author;
    if (actor) {
      payload.actorId = this.sessionStore.toNeutralJid(actor);
    }
    this.callbacks.onGroupEvent?.(payload);
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
  private handleGroupsUpdate(
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
        groupId: this.sessionStore.toNeutralJid(update.id),
        participantIds: [],
        changes,
        timestamp: Math.floor(Date.now() / 1000),
      };
      const actor = update.authorPn ?? update.author;
      if (actor) {
        payload.actorId = this.sessionStore.toNeutralJid(actor);
      }
      this.callbacks.onGroupEvent?.(payload);
    }
  }

  /**
   * Baileys `call` events carry the whole call lifecycle; only the `offer` status is a NEW incoming
   * call (ringing/preaccept/timeout/reject/accept/terminate are progress and hang-up updates and
   * are skipped). Offline-replayed offers (missed-while-disconnected) and the account's own
   * outgoing calls are skipped too. The raw `from` JID is cached keyed by call id —
   * sock.rejectCall() needs it verbatim later, when the event itself is long gone.
   */
  private handleCallEvents(calls: WACallEvent[]): void {
    for (const call of Array.isArray(calls) ? calls : []) {
      if (!call || call.status !== 'offer' || !call.id || !call.from) {
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
      const selfJid = this.normalizedSelfJid();
      if (selfJid) {
        const self = this.sessionStore.toNeutralJid(selfJid);
        if (
          this.sessionStore.toNeutralJid(call.from) === self ||
          this.sessionStore.toNeutralJid(call.chatId) === self
        ) {
          continue;
        }
      }
      this.cacheLiveCall(call.id, call.from);
      const payload: IncomingCallEvent = {
        callId: call.id,
        // callerPn is the phone-dialect twin of a lid caller: prefer it so the neutral caller id
        // does not depend on whether the lid->pn mapping happens to be learned yet (same rule as
        // the group actor ids above).
        from: this.sessionStore.toNeutralJid(call.callerPn ?? call.from),
        isVideo: call.isVideo === true,
        isGroup: call.isGroup === true,
        // The event carries a real Date; fall back to receipt time when absent/unparseable.
        timestamp:
          call.date instanceof Date && !Number.isNaN(call.date.getTime())
            ? Math.floor(call.date.getTime() / 1000)
            : Math.floor(Date.now() / 1000),
      };
      this.callbacks.onCall?.(payload);
    }
  }

  /**
   * Cache a ringing call's raw caller JID for a later rejectCall(). Lazy expiry: inserting a new
   * call drops already-expired entries, so a session that receives calls but never rejects them
   * can't grow the map without bound; an entry that never sees another call is tiny and is dropped
   * on teardown (disconnect/logout/destroy) or at the next call. No per-entry timer to clean up.
   */
  private cacheLiveCall(callId: string, callFrom: string): void {
    const now = Date.now();
    for (const [id, entry] of this.liveCalls) {
      if (entry.expiresAt <= now) {
        this.liveCalls.delete(id);
      }
    }
    this.liveCalls.set(callId, { callFrom, expiresAt: now + BaileysAdapter.LIVE_CALL_TTL_MS });
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
    if (!this.sock) {
      throw new EngineNotReadyError('Cannot reject a call before the engine is initialized.');
    }
    await this.sock.rejectCall(callId, entry.callFrom);
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
      return entry ? this.sessionStore.toNeutralJid(entry) : null;
    }
    if (entry && typeof entry === 'object') {
      const e = entry as { phoneNumber?: unknown; id?: unknown; lid?: unknown };
      const jid = [e.phoneNumber, e.id, e.lid].find((v): v is string => typeof v === 'string' && v.length > 0);
      return jid ? this.sessionStore.toNeutralJid(jid) : null;
    }
    return null;
  }

  /**
   * Download inbound media via a stream, accumulating chunks but ABORTING (destroy + discard) once the
   * running total exceeds `maxBytes`. Returns null on abort. Uses `downloadMediaMessage(..., 'stream')`
   * (not the raw `downloadContentFromMessage`) so the library's expired-media re-upload retry is kept;
   * for under-cap media the concatenated buffer is byte-identical to the 'buffer' mode it replaces.
   */
  private async downloadInboundMediaCapped(msg: WAMessage, maxBytes: number): Promise<Buffer | null> {
    // Hold the stream handle in the outer scope so the timeout can destroy it. A genuine
    // download/read error still rejects (propagating to the caller's catch as before); only a
    // wall-clock timeout or the byte-cap overflow resolves to null.
    let stream: (AsyncIterable<Buffer> & { destroy?: () => void }) | undefined;
    const download = (async (): Promise<Buffer | null> => {
      const b = await this.loadLib();
      stream = (await b.downloadMediaMessage(
        msg,
        'stream',
        {},
        {
          logger: createSilentLogger(),
          reuploadRequest: this.sock!.updateMediaMessage,
        },
      )) as AsyncIterable<Buffer> & { destroy?: () => void };

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy?.();
          return null;
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    })();

    // A slow/trickling sender never trips the byte cap, so without a deadline it pins a concurrency
    // slot (and, on Baileys, the whole inbound handler) indefinitely. On timeout, destroy the stream
    // and treat it as no usable media (same null the cap-abort returns).
    return withInboundDownloadTimeout(download, inboundMediaTimeoutMs(), () => stream?.destroy?.());
  }

  private async mapMessage(
    msg: WAMessage,
    contentType: string | undefined,
    opts?: { skipMediaDownload?: boolean },
  ): Promise<IncomingMessage> {
    const b = await this.loadLib();
    const content = msg.message ?? {};
    // Read body/isPtt off the NORMALIZED content: a disappearing message (ephemeralMessage), a captioned
    // document (documentWithCaptionMessage) and viewOnce/edited wrappers nest the real text/caption under
    // an inner message, so the raw wrapper exposes none at top level. Identity no-op when unwrapped.
    const normalized = b.normalizeMessageContent(content) ?? content;

    // Body: text first, then media caption, then WhatsApp Business interactive shapes (#562).
    const body = extractBaileysBody(normalized);

    // --- location ---
    // ILocationMessage has name/address; ILiveLocationMessage does not — use the static variant only.
    let location: IncomingMessage['location'];
    if (contentType === 'locationMessage' || contentType === 'liveLocationMessage') {
      // Read off the NORMALIZED content: an ephemeral/disappearing-chat location nests under the wrapper,
      // so the raw `content.locationMessage` is undefined and the coordinates would be silently dropped.
      const lm = normalized.locationMessage ?? normalized.liveLocationMessage;
      if (lm) {
        const staticLm = normalized.locationMessage; // only ILocationMessage has name/address
        location = {
          latitude: lm.degreesLatitude ?? 0,
          longitude: lm.degreesLongitude ?? 0,
          description: staticLm?.name ?? undefined,
          address: staticLm?.address ?? undefined,
        };
      }
    }

    // --- media (image / video / audio / document / sticker) ---
    let media: IncomingMessage['media'];
    const isMediaType =
      contentType === 'imageMessage' ||
      contentType === 'videoMessage' ||
      contentType === 'audioMessage' ||
      contentType === 'documentMessage' ||
      contentType === 'documentWithCaptionMessage' ||
      contentType === 'stickerMessage';
    if (isMediaType) {
      // The outbound "sent" echo passes skipMediaDownload: the sender already holds the media, and for
      // parity with the wwjs message.sent (which carries no media buffer) we emit only the marker here.
      if (opts?.skipMediaDownload || !isMediaDownloadEnabled()) {
        // Emit the omitted marker so the media field is present (webhook/n8n/dashboard contract).
        // mimetype is available pre-download from the message content.
        const normalizedContent = b.normalizeMessageContent(content) ?? content;
        const subMessage =
          normalizedContent.imageMessage ??
          normalizedContent.videoMessage ??
          normalizedContent.audioMessage ??
          normalizedContent.documentMessage ??
          normalizedContent.stickerMessage;
        media = {
          mimetype: subMessage?.mimetype ?? '',
          filename: normalizedContent.documentMessage?.fileName ?? undefined,
          omitted: true,
          sizeBytes: coerceDeclaredSize(subMessage?.fileLength),
        };
      } else {
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
          // Pre-download gate: an honest over-cap sender's media is never decrypted into heap at all
          // (Baileys integrity-checks content against the declared size, so this is a robust bound).
          media = { mimetype, filename, omitted: true, sizeBytes: declared };
          this.logger.warn('Inbound media declared size exceeds MEDIA_DOWNLOAD_MAX_BYTES; skipped download', {
            msgId: msg.key.id,
            sizeBytes: declared,
          });
        } else {
          try {
            // Stream-download with a running-total abort so a sender who understates fileLength still
            // can't materialise an over-cap blob. For under-cap media this yields the identical buffer.
            const buf = await this.downloadInboundMediaCapped(msg, maxBytes);
            if (buf === null) {
              media = { mimetype, filename, omitted: true, sizeBytes: maxBytes };
              this.logger.warn(
                'Inbound media download aborted (over MEDIA_DOWNLOAD_MAX_BYTES or past MEDIA_DOWNLOAD_TIMEOUT_MS); emitting omitted marker',
                { msgId: msg.key.id },
              );
            } else {
              // capInboundMedia is the last line (lazy base64, never persist/webhook/broadcast an over-cap
              // blob); the real heap bound is the pre-gate + streaming abort + concurrency limiter.
              media = capInboundMedia({
                mimetype,
                filename,
                sizeBytes: buf.byteLength,
                toBase64: () => buf.toString('base64'),
              });
            }
          } catch (err) {
            this.logger.debug('Failed to download inbound media; emitting message without media', {
              error: err instanceof Error ? err.message : String(err),
              msgId: msg.key.id,
            });
          }
        }
      }
    }

    // --- quoted message + disappearing-messages timer ---
    let quotedMessage: IncomingMessage['quotedMessage'];
    // Read context off the NORMALIZED content: a live disappearing message arrives wrapped in
    // `ephemeralMessage` (also viewOnce / documentWithCaption), whose inner content carries the
    // contextInfo. The raw wrapper exposes none at top level, so both the quote and the timer
    // (`contextInfo.expiration`) would be missed if we read the raw content here.
    const normalizedForContext = b.normalizeMessageContent(content) ?? content;
    const subForContext =
      normalizedForContext.extendedTextMessage ??
      normalizedForContext.imageMessage ??
      normalizedForContext.videoMessage ??
      normalizedForContext.audioMessage ??
      normalizedForContext.documentMessage ??
      normalizedForContext.stickerMessage ??
      normalizedForContext.locationMessage;
    const contextInfo = (
      subForContext as
        | {
            contextInfo?: {
              stanzaId?: string | null;
              quotedMessage?: Record<string, unknown> | null;
              expiration?: number | null;
              mentionedJid?: string[] | null;
            };
          }
        | undefined
    )?.contextInfo;
    if (contextInfo?.quotedMessage && contextInfo.stanzaId) {
      const qm = contextInfo.quotedMessage as {
        conversation?: string | null;
        extendedTextMessage?: { text?: string | null } | null;
        imageMessage?: { caption?: string | null } | null;
        videoMessage?: { caption?: string | null } | null;
        documentMessage?: { caption?: string | null } | null;
      };
      const qBody =
        qm.conversation ??
        qm.extendedTextMessage?.text ??
        qm.imageMessage?.caption ??
        qm.videoMessage?.caption ??
        qm.documentMessage?.caption ??
        '';
      quotedMessage = { id: contextInfo.stanzaId, body: qBody };
    }

    return buildIncomingMessageFromBaileys(
      {
        id: msg.key.id ?? '',
        remoteJid: msg.key.remoteJid!,
        fromMe: msg.key.fromMe === true,
        participant: msg.key.participant ?? undefined,
        body,
        contentType,
        isPtt: normalized.audioMessage?.ptt === true,
        timestamp: this.toUnixSeconds(msg.messageTimestamp),
        pushName: msg.pushName ?? undefined,
        selfJid: this.normalizedSelfJid(),
        media,
        location,
        quotedMessage,
        ephemeralDuration: contextInfo?.expiration ?? undefined,
        mentionedJids: contextInfo?.mentionedJid ?? undefined,
      },
      jid => this.sessionStore.toNeutralJid(jid),
    );
  }

  /**
   * Persist the bulk history Baileys pushes on connect (`messaging-history.set`) - the only
   * pre-connection history source. Maps each message media-free and hands the batch to the dispatch-free
   * `onHistoryMessages` callback, harvesting `pushName` into contacts on the way (history `contacts`
   * carry no names) and seeding each chat's last-message preview.
   */
  private async captureHistoryMessages(messages: WAMessage[]): Promise<void> {
    if (!messages.length) {
      return;
    }
    const b = await this.loadLib();
    const nameUpdates: { id: string; notify: string }[] = [];
    const mapped: IncomingMessage[] = [];
    for (const msg of messages) {
      if (msg.key?.fromMe !== true && msg.pushName) {
        const sender = msg.key?.participant ?? msg.key?.remoteJid;
        if (sender) {
          nameUpdates.push({ id: sender, notify: msg.pushName });
        }
      }
      // Seed the chat's last-message preview + sort time (newest wins); else history-only chats
      // would read "No messages yet".
      this.sessionStore.recordMessage(msg);
      const incoming = this.mapHistoryMessage(b, msg);
      if (incoming) {
        mapped.push(incoming);
      }
    }
    if (nameUpdates.length) {
      this.sessionStore.upsertContacts(nameUpdates);
    }
    if (mapped.length) {
      this.callbacks.onHistoryMessages?.(mapped);
    }
  }

  /**
   * Backfill chat/contact display names after connect. Baileys 6.7.x often skips the initial app-state
   * sync (the state machine goes Online before it runs) and the PUSH_NAME sync can fail to decrypt, so
   * names never arrive. Fetch group subjects (reliable) and best-effort re-trigger the app-state sync;
   * both are non-fatal, and DM push-names still arrive via `contacts.update` on live messages.
   */
  private async hydrateNames(): Promise<void> {
    try {
      const groups = await this.sock!.groupFetchAllParticipating();
      const named = Object.values(groups)
        .filter(g => g?.id && g.subject)
        .map(g => ({ id: g.id, name: g.subject }));
      if (named.length) {
        this.sessionStore.upsertChats(named);
        this.logger.debug('Hydrated group names', { action: 'baileys_hydrate_groups', count: named.length });
      }
    } catch (err) {
      this.logger.warn('Group name hydration failed', { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const b = await this.loadLib();
      await this.sock!.resyncAppState(b.ALL_WA_PATCH_NAMES, false);
      this.logger.debug('Re-synced app state for contact names', { action: 'baileys_resync_appstate' });
    } catch (err) {
      this.logger.warn('App-state resync for contact names failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Media-free WAMessage -> IncomingMessage map for bulk history (downloading media for thousands of
   * messages would be ruinous; the type is kept, the payload dropped). Returns null for protocol /
   * reaction / key / empty messages, which carry nothing for the chat view.
   */
  private mapHistoryMessage(b: typeof BaileysLib, msg: WAMessage): IncomingMessage | null {
    const raw = msg.message;
    if (!raw || !msg.key?.remoteJid || !msg.key.id) {
      return null;
    }
    // Unwrap ephemeral/viewOnce/documentWithCaption/edited wrappers so the real type and body surface —
    // else a disappearing-chat message maps to type 'unknown' with an empty body. Identity no-op when
    // already unwrapped. Derive ONE contentType from the normalized content for both the skip-filter and
    // the type mapping, and reuse extractBaileysBody (the same body extraction the live path uses).
    const content = b.normalizeMessageContent(raw) ?? raw;
    const contentType = b.getContentType(content);
    if (
      !contentType ||
      contentType === 'protocolMessage' ||
      contentType === 'reactionMessage' ||
      contentType === 'senderKeyDistributionMessage'
    ) {
      return null;
    }
    const body = extractBaileysBody(content);
    return buildIncomingMessageFromBaileys(
      {
        id: msg.key.id,
        remoteJid: msg.key.remoteJid,
        fromMe: msg.key.fromMe === true,
        participant: msg.key.participant ?? undefined,
        body,
        contentType,
        isPtt: content.audioMessage?.ptt === true,
        timestamp: this.toUnixSeconds(msg.messageTimestamp),
        pushName: msg.pushName ?? undefined,
        selfJid: this.normalizedSelfJid(),
        // Populate the disappearing-messages timer using the same extraction the live path and the
        // session-store cache share (`msg.ephemeralDuration` primary, `contextInfo.expiration` fallback),
        // so the history sink can apply the STORE_EPHEMERAL_MESSAGES opt-out symmetrically with onMessage.
        ephemeralDuration: this.sessionStore.extractEphemeralDuration(msg),
      },
      jid => this.sessionStore.toNeutralJid(jid),
    );
  }

  private normalizedSelfJid(): string {
    const phone = this.extractPhone(this.sock?.user?.id);
    return phone ? `${phone}@s.whatsapp.net` : '';
  }

  /** Baileys timestamps are `number | Long`; normalize to unix seconds. */
  private toUnixSeconds(ts: number | { toNumber(): number } | null | undefined): number {
    if (ts == null) {
      return Math.floor(Date.now() / 1000);
    }
    return typeof ts === 'number' ? ts : ts.toNumber();
  }

  /** Protocol-message edit timestamps are milliseconds; the enclosing message timestamp is seconds. */
  private toEditUnixSeconds(
    timestampMs: number | { toNumber(): number } | null | undefined,
    fallback: number | { toNumber(): number } | null | undefined,
  ): number {
    if (timestampMs == null) return this.toUnixSeconds(fallback);
    const milliseconds = typeof timestampMs === 'number' ? timestampMs : timestampMs.toNumber();
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : this.toUnixSeconds(fallback);
  }

  /** Resolve a MediaInput's data (Buffer | base64 string | http(s) URL) to bytes + mimetype. */
  private async resolveMediaBuffer(media: MediaInput): Promise<{ data: Buffer; mimetype: string }> {
    if (Buffer.isBuffer(media.data)) {
      return { data: media.data, mimetype: media.mimetype };
    }
    if (/^https?:\/\//i.test(media.data)) {
      const fetched = await loadRemoteMediaBuffer(media.data);
      // A generic placeholder mimetype (buildMediaInput's 'application/octet-stream' default when the
      // caller supplied none) carries no real signal — defer to the fetched response content-type,
      // which was sniffed from the actual bytes. This fixes URL-based sends where the caller has no
      // mimetype to pass through the conversation-send facade (e.g. chatwoot-adapter outbound relay).
      const callerMimetype = media.mimetype && media.mimetype !== 'application/octet-stream' ? media.mimetype : null;
      return { data: fetched.data, mimetype: callerMimetype ?? fetched.mimetype };
    }
    return { data: Buffer.from(media.data, 'base64'), mimetype: media.mimetype };
  }

  /** Build a minimal WhatsApp-compatible vCard from a neutral contact card. */
  /**
   * Fold the chat's known disappearing-messages timer into Baileys' send options so outbound messages
   * honor the chat's ephemeral setting (#473). Returns `options` unchanged when no positive timer is
   * cached: omitting `ephemeralExpiration` reproduces today's behavior (Baileys' send guard is truthy),
   * so an unknown / boot-window / stale-empty cache never forces a message to disappear. Returning
   * `undefined` keeps the send a 2-arg call, identical to before. React/delete/status do not route
   * through here, so they are excluded by construction (reactions are NOT excluded by Baileys' guard).
   */
  /**
   * Resolve a 1:1 phone-dialect chat id (`@c.us` / `@s.whatsapp.net`) to the contact's `@lid` when the
   * mapping is known. WhatsApp rejects PN-addressed 1:1 sends to LID-migrated accounts with ack error
   * 463 ("missing tctoken" — the privacy token is stored and honored under the LID), while the very
   * same send addressed to the LID delivers (verified live). Groups, broadcast, already-lid and
   * unmapped ids pass through unchanged, reproducing the previous behavior.
   */
  private async toDeliverableJid(chatId: string): Promise<string> {
    if (!chatId.endsWith('@c.us') && !chatId.endsWith('@s.whatsapp.net')) {
      return chatId;
    }
    try {
      const pn = this.sessionStore.toEngineJid(chatId);
      const lid = await this.sock?.signalRepository?.lidMapping?.getLIDForPN(pn);
      return lid ?? chatId;
    } catch {
      return chatId; // resolution is best-effort; an unmapped contact sends to the PN as before
    }
  }

  private withEphemeral(
    chatId: string,
    options?: MiscMessageGenerationOptions,
  ): MiscMessageGenerationOptions | undefined {
    const ephemeralExpiration = this.sessionStore.getEphemeralExpiration(chatId);
    if (ephemeralExpiration === undefined) {
      return options;
    }
    return { ...options, ephemeralExpiration };
  }

  /** Send a Baileys content object and shape the result like the other sends. */
  private async sendContent(
    chatId: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ): Promise<MessageResult> {
    const jid = await this.toDeliverableJid(chatId);
    const merged = this.withEphemeral(jid, options);
    const sent = merged
      ? await this.sock!.sendMessage(jid, content, merged)
      : await this.sock!.sendMessage(jid, content);
    if (sent) {
      void this.config.messageStore?.put(this.config.dbSessionId, sent).catch(err =>
        this.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // wwjs fires `message_create` for its own API sends, which SessionService turns into `message.sent`.
      // Baileys' own socket-sends echo back only as a `type:'append'` upsert (skipped as history sync), so
      // that event never fired for API sends. Emit the outbound "created" callback here for parity —
      // best-effort and off the response path, with no media re-download (matching the wwjs payload).
      void this.emitOwnSendEcho(sent);
    }
    return { id: sent?.key?.id ?? '', timestamp: this.toUnixSeconds(sent?.messageTimestamp) };
  }

  /**
   * Emit the engine-neutral "message created" callback for a message this session just sent via the API,
   * so downstream `message.sent` webhook/WS/hook delivery matches the whatsapp-web.js engine. Best-effort:
   * a mapping failure must never fail the send that already succeeded.
   */
  private async emitOwnSendEcho(sent: WAMessage): Promise<void> {
    if (!this.callbacks.onMessageCreate) return;
    try {
      const b = await this.loadLib();
      if (!sent.message || !sent.key?.remoteJid) return;
      const normalizedRoot = b.normalizeMessageContent(sent.message) ?? sent.message;
      const contentType = b.getContentType(normalizedRoot);
      // protocol / reaction / empty own messages carry no neutral "sent" content.
      if (!contentType || contentType === 'protocolMessage' || contentType === 'reactionMessage') return;
      const neutral = await this.mapMessage(sent, contentType, { skipMediaDownload: true });
      this.callbacks.onMessageCreate(neutral);
    } catch (err) {
      this.logger.warn('Failed to emit own-send echo', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Resolve a previously-seen message from the store, or throw a clear not-found error. */
  private async requireStored(messageId: string): Promise<WAMessage> {
    const found = await this.config.messageStore?.getMessage(this.config.dbSessionId, messageId);
    if (!found?.key) {
      throw new MessageNotFoundError(messageId);
    }
    return found;
  }

  /**
   * Post a status (story) to `status@broadcast` with a denormalized `statusJidList` (the allow-list of
   * neutral recipients folded back to the engine dialect). Image/video variants route through here too.
   * The outbound status echo is NOT persisted — status isn't a chat message (the inbound filter in
   * handleMessagesUpsert already skips `type:'append'` echoes).
   */
  private async postStatus(content: AnyMessageContent, options: StatusPostOptions): Promise<StatusResult> {
    this.ensureReady();
    const statusJidList = options.recipients.map(r => this.sessionStore.toEngineJid(r));
    const sent = await this.sock!.sendMessage('status@broadcast', content, {
      statusJidList,
      backgroundColor: options.backgroundColor,
      font: options.font,
    });
    return this.toStatusResult(sent);
  }

  /** Shape a Baileys send result into a StatusResult; expiresAt is timestamp + 24h (WhatsApp status TTL). */
  private toStatusResult(sent: WAMessage | undefined): StatusResult {
    const ts = sent?.messageTimestamp ? new Date(this.toUnixSeconds(sent.messageTimestamp) * 1000) : new Date();
    return {
      statusId: sent?.key?.id ?? '',
      timestamp: ts,
      expiresAt: new Date(ts.getTime() + 24 * 3_600_000),
    };
  }

  private unsupported(method: string): Promise<any> {
    return Promise.reject(new EngineNotSupportedError(method));
  }

  protected ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.sock) {
      throw new EngineNotReadyError();
    }
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }

  /** `628999:12@s.whatsapp.net` / `628999@s.whatsapp.net` -> `628999`. */
  private extractPhone(id: string | undefined): string | null {
    if (!id) {
      return null;
    }
    return id.split(':')[0].split('@')[0] || null;
  }
}
