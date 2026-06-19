import * as path from 'path';
import * as qrcode from 'qrcode';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { buildIncomingMessageFromBaileys, mapBaileysStatus } from './baileys-message-mapper';
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
  TextStatusOptions,
} from '../interfaces/whatsapp-engine.interface';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { createLogger } from '../../common/services/logger.service';
import { BaileysAdapterConfig, BaileysLogger } from '../types/baileys.types';
import { BaileysSessionStore } from './baileys-session-store';
import { capInboundMedia } from './inbound-media-cap';

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

export class BaileysAdapter implements IWhatsAppEngine {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;

  private readonly logger = createLogger('BaileysAdapter');
  private readonly authPath: string;
  private readonly sessionStore = new BaileysSessionStore();
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

    const sock = b.default({
      auth: state,
      version,
      browser: BAILEYS_BROWSER,
      printQRInTerminal: false,
      // BaileysLogger matches ILogger exactly; cast needed because the module resolves
      // the type through a deep import path that TypeScript does not auto-unify here.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
      logger: createSilentLogger() as unknown as ILogger,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => void saveCreds());
    sock.ev.on('connection.update', update => this.handleConnectionUpdate(update));
    sock.ev.on('messages.upsert', event => this.handleMessagesUpsert(event));
    sock.ev.on('messages.update', updates => this.handleMessagesUpdate(updates));
    sock.ev.on('contacts.upsert', contacts => this.sessionStore.upsertContacts(contacts));
    sock.ev.on('contacts.update', updates => this.sessionStore.upsertContacts(updates));
    sock.ev.on('chats.upsert', chats => this.sessionStore.upsertChats(chats));
    sock.ev.on('chats.update', updates => this.sessionStore.upsertChats(updates));
    sock.ev.on('messaging-history.set', history => {
      this.sessionStore.upsertContacts(history.contacts);
      this.sessionStore.upsertChats(history.chats);
      // lidPnMappings is not in the installed @whiskeysockets/baileys@6.7.23 type definition but
      // is present at runtime in later protocol versions; cast to access it safely.
      const lidPnMappings = (history as unknown as { lidPnMappings?: { lid: string; pn: string }[] }).lidPnMappings;
      this.sessionStore.addLidMappings(lidPnMappings ?? []);
    });
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
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;

      if (this.intentionalClose) {
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }

      if (statusCode === this.lib?.DisconnectReason.loggedOut) {
        // Credentials invalidated — terminal. Re-linking requires a fresh QR/pairing.
        this.setStatus(EngineStatus.DISCONNECTED);
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
    // ponytail: leaves the multi-file auth dir on disk; a fresh link overwrites it. Add fs cleanup if
    // stale creds ever block re-linking.
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

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const sent = await this.sock!.sendMessage(chatId, { text });
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
    return hit?.exists ? hit.jid : null;
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.ensureReady();
    const presence = state === 'typing' ? 'composing' : state === 'recording' ? 'recording' : 'paused';
    await this.sock!.sendPresenceUpdate(presence, chatId);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, { image: data, caption: media.caption, mimetype });
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, { video: data, caption: media.caption, mimetype });
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, { audio: data, mimetype, ptt: false });
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await this.resolveMediaBuffer(media);
    return this.sendContent(chatId, { document: data, mimetype, fileName: media.filename ?? 'file' });
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
      contacts: { displayName: contact.name, contacts: [{ vcard: this.buildVCard(contact) }] },
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
    return Object.values(all).map(metadata => mapBaileysGroup(metadata, self));
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const metadata = await this.sock!.groupMetadata(groupId);
      return mapBaileysGroupInfo(metadata);
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
    const metadata = await this.sock!.groupCreate(name, participants);
    return mapBaileysGroup(metadata, this.normalizedSelfJid());
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, participants, 'add');
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, participants, 'remove');
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, participants, 'promote');
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, participants, 'demote');
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
  postTextStatus(_text: string, _options?: TextStatusOptions): Promise<StatusResult> {
    return this.unsupported('postTextStatus');
  }
  postImageStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    return this.unsupported('postImageStatus');
  }
  postVideoStatus(_media: MediaInput, _caption?: string): Promise<StatusResult> {
    return this.unsupported('postVideoStatus');
  }
  deleteStatus(_statusId: string): Promise<void> {
    return this.unsupported('deleteStatus');
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
      void this.processInboundMessage(msg);
    }
  }

  private async processInboundMessage(msg: WAMessage): Promise<void> {
    try {
      const b = await this.loadLib();
      const remoteJid = msg.key.remoteJid!;
      const contentType = b.getContentType(msg.message ?? undefined);

      // --- protocolMessage REVOKE: don't emit onMessage ---
      if (contentType === 'protocolMessage') {
        const pm = msg.message?.protocolMessage;
        if (pm?.type === b.proto.Message.ProtocolMessage.Type.REVOKE) {
          const from = msg.key.fromMe === true ? this.normalizedSelfJid() : remoteJid;
          const to = msg.key.fromMe === true ? remoteJid : this.normalizedSelfJid();
          const revoked: RevokedMessage = {
            id: pm.key?.id ?? '',
            chatId: remoteJid,
            from,
            to,
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
          chatId: remoteJid,
          reaction: rm?.text ?? '',
          senderId: msg.key.participant ?? remoteJid,
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

  private async mapMessage(msg: WAMessage, contentType: string | undefined): Promise<IncomingMessage> {
    const b = await this.loadLib();
    const content = msg.message ?? {};

    // Body: text first, then media caption as fallback.
    const body =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      '';

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
      try {
        const buf = await b.downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: createSilentLogger(),
            reuploadRequest: this.sock!.updateMediaMessage,
          },
        );
        // normalizeMessageContent unwraps documentWithCaptionMessage / viewOnceMessage /
        // ephemeralMessage wrappers so we always reach the inner media sub-message.
        const normalizedContent = b.normalizeMessageContent(content) ?? content;
        const subMessage =
          normalizedContent.imageMessage ??
          normalizedContent.videoMessage ??
          normalizedContent.audioMessage ??
          normalizedContent.documentMessage ??
          normalizedContent.stickerMessage;
        const mimetype = subMessage?.mimetype ?? '';
        const filename = normalizedContent.documentMessage?.fileName ?? undefined;
        // Cap inbound media (lazy base64) so an oversized blob from an untrusted sender is never
        // encoded/persisted/webhooked/broadcast — preventing heap blow-up. Envelope is kept.
        media = capInboundMedia({
          mimetype,
          filename,
          sizeBytes: buf.byteLength,
          toBase64: () => buf.toString('base64'),
        });
        if (media.omitted) {
          this.logger.warn('Inbound media exceeds MEDIA_DOWNLOAD_MAX_BYTES; dropped payload, kept envelope', {
            msgId: msg.key.id,
            sizeBytes: media.sizeBytes,
          });
        }
      } catch (err) {
        this.logger.debug('Failed to download inbound media; emitting message without media', {
          error: err instanceof Error ? err.message : String(err),
          msgId: msg.key.id,
        });
      }
    }

    // --- quoted message ---
    let quotedMessage: IncomingMessage['quotedMessage'];
    const subForContext =
      content.extendedTextMessage ??
      content.imageMessage ??
      content.videoMessage ??
      content.audioMessage ??
      content.documentMessage ??
      content.stickerMessage ??
      content.locationMessage;
    const contextInfo = (
      subForContext as
        | { contextInfo?: { stanzaId?: string | null; quotedMessage?: Record<string, unknown> | null } }
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

    return buildIncomingMessageFromBaileys({
      id: msg.key.id ?? '',
      remoteJid: msg.key.remoteJid!,
      fromMe: msg.key.fromMe === true,
      participant: msg.key.participant ?? undefined,
      body,
      contentType,
      isPtt: content.audioMessage?.ptt === true,
      timestamp: this.toUnixSeconds(msg.messageTimestamp),
      pushName: msg.pushName ?? undefined,
      selfJid: this.normalizedSelfJid(),
      media,
      location,
      quotedMessage,
    });
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
  private buildVCard(contact: ContactCard): string {
    const clean = (s: string): string => s.replace(/[\r\n]+/g, ' ');
    const name = clean(contact.name);
    const number = clean(contact.number);
    const waid = number.replace(/\D/g, '');
    return [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${name}`,
      `TEL;type=CELL;type=VOICE;waid=${waid}:${number}`,
      'END:VCARD',
    ].join('\n');
  }

  /** Send a Baileys content object and shape the result like the other sends. */
  private async sendContent(
    chatId: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ): Promise<MessageResult> {
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
