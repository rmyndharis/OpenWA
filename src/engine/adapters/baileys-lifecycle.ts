import * as fs from 'fs';
import type { Agent } from 'https';
import * as qrcode from 'qrcode';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger.js';
import { EngineEventCallbacks, EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { type createLogger } from '../../common/services/logger.service';
import { BaileysAdapterConfig } from '../types/baileys.types';
import { createBaileysLogger } from './baileys-logger';
import type { BaileysEvents } from './baileys-events';
import type { BaileysHistory } from './baileys-history';
import type { BaileysSessionStore } from './baileys-session-store';

/** Linked-device identity shown in WhatsApp (Settings → Linked Devices). The display name is
 * operator-brandable via BAILEYS_BROWSER_NAME; it only applies to pairings made after the change. */
const BAILEYS_BROWSER: [string, string, string] = [
  process.env.BAILEYS_BROWSER_NAME?.trim() || 'OpenWA',
  'Chrome',
  '120.0.0',
];

/**
 * How long logout() waits for WhatsApp to acknowledge the `remove-companion-device` IQ. Completion of
 * an engine-native unlink requires a tagged IQ result from the server (NOT a WebSocket write flush),
 * so this bound is the difference between a 502 (operation incomplete) and a 200 (unlink completed).
 * Set above the typical round-trip but well under the service's 10s teardown deadline so a wedged
 * transport surfaces as a retryable 502 instead of wedging the session.
 */
const BAILEYS_LOGOUT_ACK_TIMEOUT_MS = 8_000;

/**
 * Build the Node-layer agent for a session egress proxy (#859). Both the WhatsApp WebSocket
 * (`agent`) and media up/downloads (`fetchAgent`) ride it; credentials stay in the URL and are
 * authenticated on the socket itself, so none of the Chromium CDP auth timing the wwjs engine is
 * exposed to applies here. The scheme set matches the create-session DTO validator; anything else
 * (a pre-validation DB row) throws, failing the session closed rather than silently going direct.
 */
export function createProxyAgent(proxyUrl: string): Agent {
  const { protocol } = new URL(proxyUrl);
  if (protocol === 'http:' || protocol === 'https:') {
    return new HttpsProxyAgent(proxyUrl);
  }
  if (protocol === 'socks4:' || protocol === 'socks5:') {
    return new SocksProxyAgent(proxyUrl);
  }
  throw new Error(`Unsupported proxy protocol for the baileys engine: ${protocol}`);
}

/**
 * Connection lifecycle extracted from BaileysAdapter: connect/reconnect with capped backoff, QR
 * rendering, logout with the remove-companion-device ACK, terminal-close handling, and the state
 * behind them (sock, status, reconnect counters, the lazily-loaded library). The adapter keeps the
 * public IWhatsAppEngine members as thin forwarders and injects this narrow host surface via
 * closures, so the delegate never touches adapter state directly; the two state fields the rest of
 * the adapter reads live (`sock`, `connectedAt`) are public here and aliased by adapter accessors.
 */
export interface BaileysLifecycleHost {
  readonly logger: ReturnType<typeof createLogger>;
  /** This session's multi-file auth dir (authDir/sessionId) — wiped by clearAuthState on terminal logout. */
  readonly authPath: string;
  /** Adapter config, passed through: proxyUrl/sessionId in connectInner, messageStore/dbSessionId in
   *  the retry-getMessage path and logout's session cleanup. */
  readonly config: BaileysAdapterConfig;
  /** Live-call cache handle — the map is owned by the events delegate (call events + rejectCall);
   *  lifecycle teardown clears it so a late rejectCall() reports not-found on a dead socket. */
  readonly liveCalls: Map<string, { callFrom: string; expiresAt: number }>;
  /** `628999:12@s.whatsapp.net` / `628999@s.whatsapp.net` -> `628999`. */
  extractPhone(id: string | undefined): string | null;
  /** Persist contact records pushed by the socket (contacts.upsert/update, messaging-history.set). */
  upsertContacts: BaileysSessionStore['upsertContacts'];
  /** Persist chat records pushed by the socket (chats.upsert/update, messaging-history.set). */
  upsertChats: BaileysSessionStore['upsertChats'];
  /** Learn lid<->phone mappings pushed by the socket (messaging-history.set, lid-mapping.update). */
  addLidMappings: BaileysSessionStore['addLidMappings'];
  handleMessagesUpsert: BaileysEvents['handleMessagesUpsert'];
  handleMessagesUpdate: BaileysEvents['handleMessagesUpdate'];
  logContactEvent: BaileysEvents['logContactEvent'];
  handleGroupParticipantsUpdate: BaileysEvents['handleGroupParticipantsUpdate'];
  handleGroupsUpdate: BaileysEvents['handleGroupsUpdate'];
  handleCallEvents: BaileysEvents['handleCallEvents'];
  handlePresenceUpdate: BaileysEvents['handlePresenceUpdate'];
  captureHistoryMessages: BaileysHistory['captureHistoryMessages'];
  /** Backfill names the initial sync skipped (runs on connection 'open'). */
  hydrateNames: BaileysHistory['hydrateNames'];
  /** The currently-registered onQRCode callback, if any (assigned at initialize()). */
  getOnQRCode(): EngineEventCallbacks['onQRCode'];
  /** The currently-registered onReady callback, if any (assigned at initialize()). */
  getOnReady(): EngineEventCallbacks['onReady'];
  /** The currently-registered onDisconnected callback, if any (assigned at initialize()). */
  getOnDisconnected(): EngineEventCallbacks['onDisconnected'];
  /** The currently-registered onError callback, if any (assigned at initialize()). */
  getOnError(): EngineEventCallbacks['onError'];
  /** The currently-registered onStateChanged callback, if any (assigned at initialize()). */
  getOnStateChanged(): EngineEventCallbacks['onStateChanged'];
  /** The currently-registered onCredentialTeardownStarted callback, if any (assigned at initialize()). */
  getOnCredentialTeardownStarted(): EngineEventCallbacks['onCredentialTeardownStarted'];
  /** The currently-registered onAccountRestriction callback, if any (assigned at initialize()). */
  getOnAccountRestriction(): EngineEventCallbacks['onAccountRestriction'];
}

export class BaileysLifecycle {
  /** A close this long after the previous close means the connection had been healthy in between —
   *  the backoff counter restarts from scratch instead of inheriting an old incident's attempts. */
  private static readonly RECONNECT_STABILITY_RESET_MS = 5 * 60_000;

  /** Live Baileys socket, null when disconnected. Public so the adapter's `sock` accessor can alias
   *  it (an unmodified spec pokes `adapter.sock` through a cast; delegate hosts read it live). */
  sock: WASocket | null = null;
  /** Unix-seconds timestamp of the last 'open' connection.update, used to distinguish a genuinely
   *  live message misfiled as 'append' (see BaileysEvents.handleMessagesUpsert) from real history backfill.
   *  Public so the adapter can alias it for the events delegate's live read. */
  connectedAt = 0;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private intentionalClose = false;
  private connecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Date.now() of the last close that scheduled a reconnect — input to the stability reset. */
  private lastConnectionCloseAt = 0;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  private lib?: typeof BaileysLib;

  constructor(private readonly host: BaileysLifecycleHost) {}

  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  async loadLib(): Promise<typeof BaileysLib> {
    return (this.lib ??= await import('@whiskeysockets/baileys'));
  }

  async initialize(): Promise<void> {
    // Single-use after teardown: disconnect()/destroy()/forceDestroy()/logout() set this latch, and
    // it must NOT be re-armed here. A retired adapter (e.g. one whose session was stopped/deleted
    // during the service's pre-initialize window) would otherwise open a fresh socket no caller is
    // tracking. A new adapter starts with the latch false, so the first initialize() proceeds; a
    // later teardown leaves it true for the adapter's lifetime. connectInner() re-checks the latch
    // after its auth/version awaits as a fence against teardown during those I/O steps.
    if (this.intentionalClose) {
      return;
    }
    try {
      await this.connect();
    } catch (err) {
      this.setStatus(EngineStatus.FAILED);
      this.host.getOnError()?.(err instanceof Error ? err.message : String(err));
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
    // Build the egress proxy agent BEFORE any auth-state I/O so an unusable proxy value fails the
    // session (engine_error) instead of silently connecting direct (#859).
    let proxyAgent: Agent | undefined;
    if (this.host.config.proxyUrl) {
      proxyAgent = createProxyAgent(this.host.config.proxyUrl);
      const { protocol, host } = new URL(this.host.config.proxyUrl);
      // Credential-stripped, matching the wwjs adapter's log line (#628).
      this.host.logger.log(`Using proxy: ${protocol}//${host}`, { sessionId: this.host.config.sessionId });
    }
    const b = await this.loadLib();
    const { state, saveCreds } = await b.useMultiFileAuthState(this.host.authPath);
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
        previous.ev.removeAllListeners('presence.update');
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
      // Session egress proxy (#859): the WS and media transfers share one agent; undefined = direct.
      agent: proxyAgent,
      fetchAgent: proxyAgent,
      // Enable the initial sync. Baileys defaults `shouldSyncHistoryMessage` to `() => !!syncFullHistory`,
      // so leaving both unset disables ALL history + app-state sync - no contacts, chats, recent history,
      // or lid->phone mappings ever arrive (the address-book app-state sync only runs once history sync is
      // enabled; see WhiskeySockets/Baileys Socket/index.js + Socket/chats.js). Returning true enables it
      // while keeping the full-archive download opt-in: with syncFullHistory false WhatsApp sends the
      // RECENT window + the full contact/app-state snapshot, not the entire message history.
      shouldSyncHistoryMessage: () => true,
      syncFullHistory: process.env.BAILEYS_SYNC_FULL_HISTORY === 'true',
      // Baileys defaults markOnlineOnConnect to true: every (re)connect broadcasts `available`,
      // and WhatsApp suppresses the paired phone's push notifications while any linked device is
      // online — a 24/7 gateway then permanently silences the phone (#871). Set
      // BAILEYS_MARK_ONLINE_ON_CONNECT=false to stay invisible; the default preserves prior
      // behavior. Note this only gates the on-connect presence: the typing / chat-state API still
      // sends per-chat presence for that call regardless.
      markOnlineOnConnect: process.env.BAILEYS_MARK_ONLINE_ON_CONNECT !== 'false',
      // Baileys defaults this to `async () => undefined` (Defaults/index.js). Without a real
      // implementation, WhatsApp's message-retry protocol — triggered whenever a recipient's client
      // fails to decrypt on the first attempt — has nothing to resend, so the recipient is stuck on
      // "waiting for this message" indefinitely instead of the retry resolving it within seconds.
      // Backed by the same messageStore used for reply/forward/react/delete-by-id.
      getMessage: async key => {
        if (!key.id) {
          return undefined;
        }
        const stored = await this.host.config.messageStore?.getMessage(this.host.config.dbSessionId, key.id);
        return stored?.message ?? undefined;
      },
      logger: baileysLogger,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => void saveCreds());
    sock.ev.on('connection.update', update => this.handleConnectionUpdate(update));
    sock.ev.on('messages.upsert', event => this.host.handleMessagesUpsert(event));
    sock.ev.on('messages.update', updates => this.host.handleMessagesUpdate(updates));
    sock.ev.on('contacts.upsert', contacts => {
      this.host.logContactEvent('contacts.upsert', contacts);
      this.host.upsertContacts(contacts);
    });
    sock.ev.on('contacts.update', updates => {
      this.host.logContactEvent('contacts.update', updates);
      this.host.upsertContacts(updates);
    });
    sock.ev.on('chats.upsert', chats => {
      this.host.logger.debug('Baileys chats event', {
        action: 'baileys_chats',
        event: 'upsert',
        count: chats?.length ?? 0,
      });
      this.host.upsertChats(chats);
    });
    sock.ev.on('chats.update', updates => {
      this.host.logger.debug('Baileys chats event', {
        action: 'baileys_chats',
        event: 'update',
        count: updates?.length ?? 0,
      });
      this.host.upsertChats(updates);
    });
    sock.ev.on('group-participants.update', event => this.host.handleGroupParticipantsUpdate(event));
    sock.ev.on('groups.update', updates => this.host.handleGroupsUpdate(updates));
    sock.ev.on('messaging-history.set', history => {
      this.host.upsertContacts(history.contacts);
      this.host.upsertChats(history.chats);
      this.host.addLidMappings(history.lidPnMappings ?? []);
      void this.host.captureHistoryMessages(history.messages ?? []);
      this.host.logger.debug('History sync received', {
        action: 'baileys_history_set',
        sessionId: this.host.config.sessionId,
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
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => this.host.addLidMappings([{ lid, pn }]));
    sock.ev.on('call', calls => this.host.handleCallEvents(calls));
    sock.ev.on('presence.update', update => this.host.handlePresenceUpdate(update));
  }

  private handleConnectionUpdate(update: {
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: unknown };
    reachoutTimeLock?: { isActive?: boolean; timeEnforcementEnds?: Date; enforcementType?: string };
  }): void {
    const { connection, qr, lastDisconnect, reachoutTimeLock } = update;

    // Arrives on its own update (no `connection` key) both when WhatsApp pushes a change and when
    // probeAccountRestriction() pulls the current state — Baileys routes its own query result back
    // through this same event, so one handler covers both channels.
    if (reachoutTimeLock) {
      this.reportReachoutTimelock(reachoutTimeLock);
    }

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
      this.phoneNumber = this.host.extractPhone(this.sock?.user?.id);
      this.pushName = this.sock?.user?.name ?? null;
      // I4: reset the reconnect counter on a successful connection.
      this.reconnectAttempts = 0;
      // Small backward buffer for clock skew between this host and WhatsApp's server (messageTimestamp
      // is WA's clock, Date.now() is ours) — without it, a message sent right at reconnect time could
      // land a couple seconds "before" connectedAt and be misjudged as history.
      this.connectedAt = Math.floor(Date.now() / 1000) - 10;
      this.setStatus(EngineStatus.READY);
      this.host.getOnReady()?.(this.phoneNumber ?? '', this.pushName ?? '');
      // WhatsApp only PUSHES a timelock when it changes, so a gateway that starts (or reconnects)
      // while the account is already restricted would never hear about it. Ask once per connection.
      void this.probeAccountRestriction();
      // Backfill names the initial sync skipped (see BaileysHistory.hydrateNames).
      void this.host.hydrateNames();
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
        void this.handleRemoteLoggedOut();
        return;
      }

      if (statusCode === (this.lib?.DisconnectReason.connectionReplaced ?? 440)) {
        // Another live instance took over this account. Reconnecting
        // would fight it — two instances endlessly replacing each other — so this is terminal:
        // the operator stops the other instance, then starts this session again (onError = terminal
        // + evict in the session service). Auth state is NOT cleared: the link itself is still valid.
        this.setStatus(EngineStatus.FAILED);
        this.host.liveCalls.clear(); // terminal close: dead call handles, like the loggedOut branch above
        this.host.getOnError()?.(
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
        this.host.liveCalls.clear(); // terminal close: dead call handles, like the loggedOut branch above
        this.host.getOnError()?.(
          'Account rejected by WhatsApp (403) — the number is likely banned or blocked; reconnecting will not help',
        );
        return;
      }

      // Every other close (408/411/428/500/503/515/undefined) is transient: reconnect with capped
      // backoff and NO attempt ceiling — a long network outage must
      // not kill the session. The counter resets on 'open' and via the stability window below.
      // Do NOT fire onDisconnected here; this is a transient drop, not a terminal disconnect.
      this.host.logger.log('Baileys connection dropped; reconnecting', { statusCode });

      // The socket is dead NOW, but the reconnect attempt only runs after the backoff delay below
      // (up to 60 s + jitter; connectInner's own setStatus(INITIALIZING) fires just before the new
      // socket is created). Staying READY across that window makes probeLiveness() report a live
      // session and lets sends fail against the dead socket, so drop to INITIALIZING here — the
      // 'open' branch restores READY. setStatus no-ops on an unchanged status, so the duplicate
      // closes Baileys can emit per drop do not flap onStateChanged.
      this.setStatus(EngineStatus.INITIALIZING);

      // Duplicate close while a reconnect timer is already pending — ignore it WITHOUT burning an
      // attempt (Baileys can emit more than one close per drop; the increment must come after this).
      if (this.reconnectTimer) {
        return;
      }

      // Stability reset: a close >5 min after the previous one means the connection had been
      // healthy in between — start the backoff fresh instead of inheriting the old counter.
      const now = Date.now();
      if (now - this.lastConnectionCloseAt > BaileysLifecycle.RECONNECT_STABILITY_RESET_MS) {
        this.reconnectAttempts = 0;
      }
      this.lastConnectionCloseAt = now;
      this.scheduleReconnect();
    }
  }

  /**
   * Translate Baileys' reachout-timelock state into the neutral restriction signal. Baileys reports
   * this first-class — it is not inferred from failures — and it reports the lift as well as the
   * onset, so `isActive: false` is a positive "no restriction" and is forwarded as `null`.
   *
   * A timelock does NOT close the connection: the account stays linked and existing chats keep
   * working, only starting new conversations is blocked. Nothing here touches status or reconnects.
   */
  private reportReachoutTimelock(state: {
    isActive?: boolean;
    timeEnforcementEnds?: Date;
    enforcementType?: string;
  }): void {
    const report = this.host.getOnAccountRestriction();
    if (!report) return;

    if (!state.isActive) {
      report(null);
      return;
    }

    // `time_enforcement_ends` is a server-supplied string Baileys parses with parseInt, so a
    // malformed value yields an Invalid Date whose getTime() is NaN — which would serialize to null
    // and read as "no expiry known". Same outcome, but reached deliberately rather than by accident.
    const endsAt = state.timeEnforcementEnds?.getTime();
    report({
      kind: 'reachout_timelock',
      // DEFAULT is Baileys' own "no specific enforcement type" value, not a placeholder of ours.
      code: state.enforcementType ?? 'DEFAULT',
      expiresAt: typeof endsAt === 'number' && Number.isFinite(endsAt) ? endsAt : undefined,
    });
  }

  /**
   * Ask WhatsApp for the account's current restriction standing. The answer is not used here:
   * Baileys emits its own `connection.update { reachoutTimeLock }` with the result, so it arrives
   * through the same path as a pushed change.
   *
   * Best-effort by design — an account or server that does not answer this query must not turn a
   * healthy connection into a logged failure, so it stays at debug level.
   */
  private async probeAccountRestriction(): Promise<void> {
    try {
      await this.sock?.fetchAccountReachoutTimelock();
    } catch (error) {
      this.host.logger.debug('Could not read the account restriction state', {
        action: 'baileys_restriction_probe_failed',
        sessionId: this.host.config.sessionId,
        error: String(error),
      });
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
        this.host.logger.warn('Baileys reconnect attempt failed; will retry', {
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
      this.host.getOnQRCode()?.(this.qrCode);
    } catch (error) {
      this.host.logger.error('Error generating QR code', String(error));
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
    this.host.liveCalls.clear();
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Capture the exact live socket. Without one the unlink cannot be sent, and an optional-chained
    // send would resolve as though it had been — reporting a confirmed unlink, writing the audit row,
    // and then wiping the on-disk credentials, leaving the device linked server-side with nothing
    // left to retry with. Reachable: a WhatsApp-side logout nulls the socket while the engine stays
    // registered for the whole reconnect backoff.
    const sourceSock = this.sock;
    if (!sourceSock) {
      throw new Error('No live WhatsApp socket — the unlink was not sent');
    }

    try {
      // Completion of an engine-native unlink requires a tagged IQ result from WhatsApp — Baileys'
      // own sock.logout() resolves on a WebSocket write flush (NOT an IQ ack) and transmits nothing
      // at all when creds.me is unset, so a resolved promise proves nothing about the unlink. Use
      // the public query() surface against the pinned `remove-companion-device` node instead.
      const b = await this.loadLib();
      const jid = sourceSock.user?.id;
      if (!jid) {
        // The companion identity is required to address the unlink; without it nothing is sent.
        throw new Error('No linked companion identity — the unlink was not sent');
      }
      const response: unknown = await sourceSock.query(
        {
          tag: 'iq',
          attrs: { to: b.S_WHATSAPP_NET, type: 'set', id: sourceSock.generateMessageTag(), xmlns: 'md' },
          content: [{ tag: 'remove-companion-device', attrs: { jid, reason: 'user_initiated' } }],
        },
        BAILEYS_LOGOUT_ACK_TIMEOUT_MS,
      );
      if (!response) {
        // query() resolved without a result — WhatsApp did not acknowledge the unlink request.
        throw new Error('WhatsApp did not acknowledge the unlink request');
      }

      // Acknowledged. End/null the captured socket, clear live call handles, and drop to
      // DISCONNECTED before the awaited cleanup so no send/path observes a half-torn-down socket.
      this.localSocketShutdown(sourceSock);
      await this.host.config.messageStore?.clearSession(this.host.config.dbSessionId).catch(() => undefined);
      // Wipe the multi-file auth dir so a fresh link starts clean — stale creds would otherwise be
      // reloaded on the next connect() and block re-linking (Baileys retries them, no QR emitted).
      // A removal failure propagates: completion requires cleanup, so the operation is incomplete.
      await this.clearAuthState();
    } catch (err) {
      // EVERY failure exit (missing identity, query rejection/timeout, empty response, OR a later
      // auth removal failure) still stops sourceSock locally so no engine/socket orphan is left in
      // the service map after it evicts the engine on 502. Failure before acknowledgement must NOT
      // remove auth state — the link may still be valid server-side, and the creds are needed to
      // retry. localSocketShutdown is identity-safe: it only nulls this.sock if it still points at
      // sourceSock (a concurrent reconnect may have already swapped in a fresh socket).
      this.localSocketShutdown(sourceSock);
      throw err;
    }
  }

  /**
   * Identity-safe local shutdown of a captured socket: clears the reconnect timer, ends the socket,
   * clears cached live call handles, drops to DISCONNECTED, and nulls `this.sock` ONLY if it still
   * points at the same object (a concurrent reconnect could have swapped in a fresh one). Called at
   * every logout exit so the service's 502 genuinely means "stopped locally, operation incomplete".
   */
  private localSocketShutdown(sourceSock: WASocket): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      void sourceSock.end(undefined);
    } catch {
      // end() may already have run from Baileys' own close handler — a safe no-op.
    }
    // Cached call handles die with the connection — drop them so a later rejectCall() reports
    // not-found (404) instead of acting on a dead socket (mirrors disconnect/destroy).
    this.host.liveCalls.clear();
    if (this.sock === sourceSock) {
      this.sock = null;
    }
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  /**
   * Handle a WhatsApp-originated `loggedOut` (401) close: the credentials were invalidated server-side
   * and re-linking requires a fresh QR/pairing, so the now-dead multi-file auth dir MUST be wiped —
   * otherwise the next connect() reloads the stale creds and Baileys silently retries them instead of
   * emitting a QR, leaving the session stuck (no QR).
   *
   * The status/socket/live-call teardown happens SYNCHRONOUSLY before any await so the session
   * watchdog never processes a READY socket that is already dead. The strict auth removal is then
   * awaited as a tracked cleanup (Task 5's onCredentialTeardownStarted registers it under the session
   * NAME). On success the engine reports DISCONNECTED + onDisconnected('logged out'); on failure it
   * reports FAILED + onError (terminal — a reconnect with known-invalid auth would loop forever).
   */
  private async handleRemoteLoggedOut(): Promise<void> {
    // Synchronous teardown BEFORE any await.
    this.setStatus(EngineStatus.DISCONNECTED);
    const dead = this.sock;
    this.sock = null;
    // Cached call handles die with the connection — drop them so a later rejectCall() reports
    // not-found (404) instead of acting on a dead socket (mirrors disconnect/logout/destroy).
    this.host.liveCalls.clear();
    void dead?.end(undefined);

    const cleanup = (async (): Promise<void> => {
      try {
        await this.clearAuthState();
      } catch (err) {
        // A failed credential removal is terminal: report FAILED + onError instead of looking like a
        // clean disconnect (the credentials did not actually get wiped).
        this.setStatus(EngineStatus.FAILED);
        this.host.getOnError()?.(
          `Logged out by WhatsApp, but the local credential cleanup failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      this.host.getOnDisconnected()?.('logged out');
    })();
    // Register the destructive promise the instant it begins (NOT guarded on this engine still being
    // live): the rm targets the session NAME's auth dir and would race a (re)created session under
    // that same name. tracked under the captured name, settled regardless of the outcome.
    this.host.getOnCredentialTeardownStarted()?.(cleanup);
    await cleanup;
  }

  /**
   * Delete this session's on-disk multi-file auth state (`authDir/sessionId`). Required after a terminal
   * logout: Baileys would otherwise reload the now-invalid creds on the next connect() and retry them
   * instead of emitting a fresh QR, leaving re-linking stuck. `force` makes a missing dir a no-op.
   * Logs the outcome and RETHROWS on failure: completion of an engine-native unlink (logout 200) AND
   * the loggedOut close path both require cleanup, so a removal failure must propagate (the operation
   * is incomplete), not be swallowed.
   */
  private async clearAuthState(): Promise<void> {
    try {
      await fs.promises.rm(this.host.authPath, { recursive: true, force: true });
      this.host.logger.log('Cleared Baileys auth state', { authPath: this.host.authPath });
    } catch (err) {
      this.host.logger.warn('Failed to clear Baileys auth state', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
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
    this.host.liveCalls.clear();
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  // Baileys has no separate Chromium process to SIGKILL (destroy() already ends the socket
  // synchronously), so a force-destroy is just a destroy.
  forceDestroy(): Promise<void> {
    return this.destroy();
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  /**
   * Cheap local liveness check for the session watchdog. Genuine dead-connection detection is owned
   * by Baileys' built-in keepalive, which surfaces a close event (408) within ~35 s of a silent
   * drop — and the close handler above drops the status to INITIALIZING for the whole reconnect
   * backoff, so READY + a live socket is sufficient here.
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

  ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.sock) {
      throw new EngineNotReadyError();
    }
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.host.getOnStateChanged()?.(status);
  }
}
