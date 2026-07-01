import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { buildIncomingMessageFromBaileys, extractBaileysBody, mapBaileysStatus } from './baileys-message-mapper';
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
  Group,
  GroupInfo,
  IncomingMessage,
  IWhatsAppEngine,
  Label,
  LocationInput,
  MediaInput,
  MessageReaction,
  MessageResult,
  PaginatedProducts,
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
import { ConcurrencyLimiter } from './concurrency-limiter';

/** Linked-device identity shown in WhatsApp (Settings → Linked Devices). */
const BAILEYS_BROWSER: [string, string, string] = ['OpenWA', 'Chrome', '120.0.0'];

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
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;

  private readonly logger = createLogger('BaileysAdapter');
  // Bound concurrent inbound media downloads: each materialises a full decrypted buffer in heap, so an
  // unbounded fire-and-forget loop lets a sender flood the gateway with N parallel multi-MB allocations.
  private readonly inboundLimiter = new ConcurrencyLimiter(inboundMediaConcurrency());
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
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
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

    // C2: resurrect-after-stop guard — if disconnect/logout/destroy ran during the awaits above,
    // bail now so we don't create a live socket for a session that was intentionally stopped.
    if (this.intentionalClose) {
      return;
    }

    // An internal reconnect (transient drop) overwrites this.sock WITHOUT going through
    // disconnect/logout/destroy, so the previous socket's WebSocket and the 10 ev listeners we
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
        previous.ev.removeAllListeners('chats.phoneNumberShare');
        previous.end(undefined);
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
      // BaileysLogger matches ILogger exactly; cast needed because the module resolves
      // the type through a deep import path that TypeScript does not auto-unify here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      logger: createBaileysLogger() as unknown as ILogger,
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
    sock.ev.on('messaging-history.set', history => {
      this.sessionStore.upsertContacts(history.contacts);
      this.sessionStore.upsertChats(history.chats);
      // lidPnMappings is not in the installed @whiskeysockets/baileys@6.7.23 type definition but
      // is present at runtime in later protocol versions; cast to access it safely.
      const h = history as unknown as { lidPnMappings?: { lid: string; pn: string }[]; syncType?: unknown };
      const lidPnMappings = h.lidPnMappings;
      this.sessionStore.addLidMappings(lidPnMappings ?? []);
      this.captureHistoryMessages(history.messages ?? []);
      this.logger.debug('History sync received', {
        action: 'baileys_history_set',
        sessionId: this.config.sessionId,
        syncType: h.syncType,
        isLatest: history.isLatest,
        progress: history.progress,
        chats: history.chats?.length ?? 0,
        messages: history.messages?.length ?? 0,
        contacts: history.contacts?.length ?? 0,
        namedContacts: history.contacts?.filter(c => c.name || c.notify).length ?? 0,
        lidContacts: history.contacts?.filter(c => c.lid).length ?? 0,
        lidPnMappings: lidPnMappings?.length ?? 0,
      });
    });
    // WhatsApp pushes this when a lid contact shares its phone number - a direct lid->phone pair.
    sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => this.sessionStore.addLidMappings([{ lid, pn: jid }]));
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
        void this.clearAuthState();
        this.callbacks.onDisconnected?.('logged out');
        return;
      }

      // Recoverable (e.g. restartRequired right after pairing, transient drop) — reconnect with backoff.
      // Do NOT fire onDisconnected here; this is a transient drop, not a terminal disconnect.
      // connect() calls setStatus(INITIALIZING) which fires onStateChanged — that is the correct signal.
      this.logger.log('Baileys connection dropped; reconnecting', { statusCode });

      // I4: capped exponential backoff with in-flight timer guard.
      if (this.reconnectAttempts >= BaileysAdapter.MAX_RECONNECT_ATTEMPTS) {
        this.setStatus(EngineStatus.FAILED);
        this.callbacks.onError?.(`reconnect attempts exhausted (${this.reconnectAttempts})`);
        return;
      }
      this.reconnectAttempts += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** (this.reconnectAttempts - 1));
      // Guard: if a timer is already pending, don't stack another one.
      if (this.reconnectTimer) {
        return;
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.intentionalClose) {
          return; // stopped while waiting — abort
        }
        void this.connect().catch(err => {
          this.setStatus(EngineStatus.FAILED);
          this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
        });
      }, delay);
    }
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
    this.sock?.end(undefined);
    this.sock = null;
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
      this.sock?.end(undefined);
    }
    this.sock = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    await this.config.messageStore?.clearSession(this.config.sessionId).catch(() => undefined);
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
    this.sock?.end(undefined);
    this.sock = null;
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
    const options = this.withEphemeral(chatId);
    const content = { text, ...this.withMentions(mentions) };
    const sent = options
      ? await this.sock!.sendMessage(chatId, content, options)
      : await this.sock!.sendMessage(chatId, content);
    if (sent) {
      void this.config.messageStore?.put(this.config.sessionId, sent).catch(err =>
        this.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
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
    await this.sock!.sendPresenceUpdate(presence, chatId);
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
    if (!forEveryone) {
      // Baileys only supports revoke-for-everyone via sendMessage; delete-for-me is not implemented.
      throw new EngineNotSupportedError('deleteMessage (delete-for-me)');
    }
    const target = await this.requireStored(messageId);
    await this.sock!.sendMessage(chatId, { delete: target.key });
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
  addLabelToChat(_chatId: string, _labelId: string): Promise<void> {
    return this.unsupported('addLabelToChat');
  }
  removeLabelFromChat(_chatId: string, _labelId: string): Promise<void> {
    return this.unsupported('removeLabelFromChat');
  }
  getSubscribedChannels(): Promise<Channel[]> {
    return this.unsupported('getSubscribedChannels');
  }
  getChannelById(_channelId: string): Promise<Channel | null> {
    return this.unsupported('getChannelById');
  }
  subscribeToChannel(_inviteCode: string): Promise<Channel> {
    return this.unsupported('subscribeToChannel');
  }
  unsubscribeFromChannel(_channelId: string): Promise<void> {
    return this.unsupported('unsubscribeFromChannel');
  }
  getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    return this.unsupported('getChannelMessages');
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
    // Only live messages ('notify'); 'append' is history sync, which this storeless slice skips.
    if (event.type !== 'notify') {
      return;
    }
    for (const msg of event.messages) {
      if (!msg.message || !msg.key?.remoteJid) {
        continue; // protocol/empty messages carry no neutral content
      }
      // Throttle through the limiter so a burst of media messages can't run unbounded parallel
      // downloads (each a full decrypted buffer in heap). Ordering stays correct — the message store
      // keeps the newest by timestamp — and none are dropped (the limiter queues the overflow).
      void this.inboundLimiter.run(() => this.processInboundMessage(msg));
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

  private async processInboundMessage(msg: WAMessage): Promise<void> {
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
      const incoming = await this.mapMessage(msg, contentType);
      if (msg.key.fromMe === true) {
        this.callbacks.onMessageCreate?.(incoming);
      } else {
        this.callbacks.onMessage?.(incoming);
      }
      void this.config.messageStore?.put(this.config.sessionId, msg).catch(err =>
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

  private async mapMessage(msg: WAMessage, contentType: string | undefined): Promise<IncomingMessage> {
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
      const lm = content.locationMessage ?? content.liveLocationMessage;
      if (lm) {
        const staticLm = content.locationMessage; // only ILocationMessage has name/address
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
      if (!isMediaDownloadEnabled()) {
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
  private captureHistoryMessages(messages: WAMessage[]): void {
    if (!messages.length) {
      return;
    }
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
      const incoming = this.mapHistoryMessage(msg);
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
  private mapHistoryMessage(msg: WAMessage): IncomingMessage | null {
    const content = msg.message;
    if (!content || !msg.key?.remoteJid || !msg.key.id) {
      return null;
    }
    const contentType = Object.keys(content)[0];
    if (
      contentType === 'protocolMessage' ||
      contentType === 'reactionMessage' ||
      contentType === 'senderKeyDistributionMessage'
    ) {
      return null;
    }
    const body =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      '';
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

  /** Resolve a MediaInput's data (Buffer | base64 string | http(s) URL) to bytes + mimetype. */
  private async resolveMediaBuffer(media: MediaInput): Promise<{ data: Buffer; mimetype: string }> {
    if (Buffer.isBuffer(media.data)) {
      return { data: media.data, mimetype: media.mimetype };
    }
    if (/^https?:\/\//i.test(media.data)) {
      const fetched = await loadRemoteMediaBuffer(media.data);
      // Caller's declared mimetype wins; fall back to the response content-type.
      return { data: fetched.data, mimetype: media.mimetype || fetched.mimetype };
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
    const merged = this.withEphemeral(chatId, options);
    const sent = merged
      ? await this.sock!.sendMessage(chatId, content, merged)
      : await this.sock!.sendMessage(chatId, content);
    if (sent) {
      void this.config.messageStore?.put(this.config.sessionId, sent).catch(err =>
        this.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return { id: sent?.key?.id ?? '', timestamp: this.toUnixSeconds(sent?.messageTimestamp) };
  }

  /** Resolve a previously-seen message from the store, or throw a clear not-found error. */
  private async requireStored(messageId: string): Promise<WAMessage> {
    const found = await this.config.messageStore?.getMessage(this.config.sessionId, messageId);
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
