import { EventEmitter } from 'events';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode';
import * as path from 'path';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { AdapterContext } from './whatsapp-web-js/context';
import { MessagingAdapter } from './whatsapp-web-js/messaging.adapter';
import { ContactAdapter } from './whatsapp-web-js/contact.adapter';
import { GroupAdapter } from './whatsapp-web-js/group.adapter';
import { LabelAdapter } from './whatsapp-web-js/label.adapter';
import { ChannelAdapter } from './whatsapp-web-js/channel.adapter';
import { StatusAdapter } from './whatsapp-web-js/status.adapter';
import { CatalogAdapter } from './whatsapp-web-js/catalog.adapter';

export interface WhatsAppWebJsConfig {
  sessionId: string;
  sessionDataPath: string;
  puppeteer?: {
    headless?: boolean;
    args?: string[];
  };
  // Phase 3: Proxy per session
  proxy?: {
    url: string;
    type: 'http' | 'https' | 'socks4' | 'socks5';
  };
}

interface WWebMessageLike {
  id: { _serialized: string };
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe: boolean;
  hasMedia: boolean;
  hasQuotedMsg: boolean;
  downloadMedia: () => Promise<{ mimetype: string; filename?: string; data: string } | null>;
  getQuotedMessage: () => Promise<{ id: { _serialized: string }; body: string }>;
}

/**
 * whatsapp-web.js engine adapter.
 *
 * Owns the client lifecycle (initialize/connect/disconnect, event wiring,
 * status, QR, incoming-message building) and delegates every domain operation
 * to a concern-scoped sub-adapter (messaging, contacts, groups, labels,
 * channels, statuses, catalog) sharing one AdapterContext. The public surface
 * implements IWhatsAppEngine unchanged — this is a structural split only.
 */
export class WhatsAppWebJsAdapter extends EventEmitter implements IWhatsAppEngine {
  private client: Client | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private initStartedAtMs: number | null = null;

  constructor(private readonly config: WhatsAppWebJsConfig) {
    super();
  }

  private readonly logger = createLogger('WhatsAppWebJsAdapter');

  // Shared context + concern-scoped sub-adapters (Tier 3 #9). The main adapter
  // owns lifecycle/client; sub-adapters reach the live client via ctx.requireClient().
  private readonly ctx: AdapterContext = {
    requireClient: () => this.requireClient(),
    logger: this.logger,
  };
  private readonly messaging = new MessagingAdapter(this.ctx);
  private readonly contacts = new ContactAdapter(this.ctx);
  private readonly groups = new GroupAdapter(this.ctx);
  private readonly labels = new LabelAdapter(this.ctx);
  private readonly channels = new ChannelAdapter(this.ctx);
  private readonly statuses = new StatusAdapter(this.ctx);
  private readonly catalog = new CatalogAdapter(this.ctx);

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.setStatus(EngineStatus.INITIALIZING);
    this.initStartedAtMs = Date.now();

    try {
      // Build puppeteer args, including proxy if configured
      const puppeteerArgs = this.config.puppeteer?.args || [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ];

      // Add proxy configuration if provided
      if (this.config.proxy) {
        puppeteerArgs.push(`--proxy-server=${this.config.proxy.url}`);
        this.logger.log(
          `Using proxy: ${this.config.proxy.type}://${this.config.proxy.url.replace(/:[^:@]*@/, ':***@')}`,
        );
      }

      const parseNumberEnv = (value: string | undefined, fallback: number): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };

      const authTimeoutMs = parseNumberEnv(process.env.WWEBJS_AUTH_TIMEOUT_MS, 90000);
      const takeoverOnConflict = process.env.WWEBJS_TAKEOVER_ON_CONFLICT !== 'false';
      const takeoverTimeoutMs = parseNumberEnv(process.env.WWEBJS_TAKEOVER_TIMEOUT_MS, 0);
      const qrMaxRetries = parseNumberEnv(process.env.WWEBJS_QR_MAX_RETRIES, 0);

      this.logger.log('Initializing WhatsApp client', {
        action: 'client_initialize',
        sessionId: this.config.sessionId,
        headless: this.config.puppeteer?.headless ?? true,
        puppeteerArgsCount: puppeteerArgs.length,
        authTimeoutMs,
        takeoverOnConflict,
        takeoverTimeoutMs,
        qrMaxRetries,
      });

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.config.sessionId,
          dataPath: path.resolve(this.config.sessionDataPath),
        }),
        authTimeoutMs,
        takeoverOnConflict,
        takeoverTimeoutMs,
        qrMaxRetries,
        puppeteer: {
          headless: this.config.puppeteer?.headless ?? true,
          args: puppeteerArgs,
        },
      });

      this.setupEventHandlers();
      await this.client.initialize();
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('qr', async (qr: string) => {
      try {
        this.qrCode = await qrcode.toDataURL(qr);
        const elapsedMs = this.initStartedAtMs ? Date.now() - this.initStartedAtMs : undefined;
        this.logger.log('QR event received', {
          action: 'qr_event',
          sessionId: this.config.sessionId,
          elapsedMs,
        });
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(this.qrCode);
      } catch (error) {
        this.logger.error('Error generating QR code', String(error));
      }
    });

    this.client.on('authenticated', () => {
      const elapsedMs = this.initStartedAtMs ? Date.now() - this.initStartedAtMs : undefined;
      this.logger.log('Session authenticated, waiting ready', {
        action: 'authenticated',
        sessionId: this.config.sessionId,
        elapsedMs,
      });
      this.setStatus(EngineStatus.AUTHENTICATING);
      this.qrCode = null;
    });

    this.client.on('ready', () => {
      try {
        const info = this.client?.info;
        this.phoneNumber = info?.wid?.user || null;
        this.pushName = info?.pushname || null;
        const elapsedMs = this.initStartedAtMs ? Date.now() - this.initStartedAtMs : undefined;
        this.logger.log('Session ready event', {
          action: 'ready_event',
          sessionId: this.config.sessionId,
          elapsedMs,
        });
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
      } catch (error) {
        this.logger.error('Error getting client info', String(error));
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.('', '');
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message', async rawMsg => {
      try {
        const msg = rawMsg as unknown as WWebMessageLike;
        const incomingMessage = await this.buildIncomingMessage(msg);
        this.callbacks.onMessage?.(incomingMessage);
      } catch (error) {
        this.logger.error('Error processing incoming message', String(error));
      }
    });

    // Fired for all message creations; we only need outgoing ones for message.sent webhooks.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on('message_create', async rawMsg => {
      try {
        const msg = rawMsg as unknown as WWebMessageLike;
        if (!msg.fromMe) return;
        const outgoingMessage = await this.buildIncomingMessage(msg);
        this.callbacks.onMessageSent?.(outgoingMessage);
      } catch (error) {
        this.logger.error('Error processing outgoing message', String(error));
      }
    });

    this.client.on('message_ack', (msg, ack) => {
      this.callbacks.onMessageAck?.(msg.id._serialized, ack);
    });

    this.client.on('disconnected', reason => {
      const elapsedMs = this.initStartedAtMs ? Date.now() - this.initStartedAtMs : undefined;
      this.logger.warn('Client disconnected event', {
        action: 'disconnected_event',
        sessionId: this.config.sessionId,
        reason,
        elapsedMs,
      });
      this.setStatus(EngineStatus.DISCONNECTED);
      this.callbacks.onDisconnected?.(reason);
    });

    this.client.on('auth_failure', () => {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onDisconnected?.('Authentication failed');
    });
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  private async buildIncomingMessage(msg: WWebMessageLike): Promise<IncomingMessage> {
    const incomingMessage: IncomingMessage = {
      id: msg.id._serialized,
      from: msg.from,
      to: msg.to,
      chatId: msg.fromMe ? msg.to : msg.from,
      body: msg.body,
      type: msg.type,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
      isGroup: (msg.fromMe ? msg.to : msg.from).endsWith('@g.us'),
    };

    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          // Cap embedded media size: base64 decodes to ~3/4 of its length.
          // A burst of large media would otherwise spike memory (whole payload
          // held in the message object). Oversized media keeps its metadata but
          // drops the inline data; callers can fetch it on demand if needed.
          const parsedMax = Number(process.env.MEDIA_MAX_BYTES);
          const maxBytes = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 64 * 1024 * 1024;
          const approxBytes = Math.floor((media.data?.length ?? 0) * 0.75);
          if (approxBytes > maxBytes) {
            this.logger.warn(
              `Media for ${msg.id._serialized} (~${approxBytes} bytes) exceeds MEDIA_MAX_BYTES (${maxBytes}); dropping inline data`,
            );
            incomingMessage.media = {
              mimetype: media.mimetype,
              filename: media.filename || undefined,
              data: '',
            };
          } else {
            incomingMessage.media = {
              mimetype: media.mimetype,
              filename: media.filename || undefined,
              data: media.data,
            };
          }
        }
      } catch (error) {
        this.logger.error('Error downloading media', String(error));
      }
    }

    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        incomingMessage.quotedMessage = {
          id: quoted.id._serialized,
          body: quoted.body,
        };
      } catch (error) {
        this.logger.error('Error getting quoted message', String(error));
      }
    }

    return incomingMessage;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        // Use destroy instead of logout to preserve session data
        // This allows reconnecting without needing to scan QR again
        await this.client.destroy();
      } catch (error) {
        this.logger.warn('Destroy client failed:', String(error));
        // Already destroyed or not initialized - ignore
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async logout(): Promise<void> {
    if (this.client) {
      try {
        // Logout clears session data - user will need to scan QR again
        await this.client.logout();
      } catch (error) {
        this.logger.warn('Logout failed:', String(error));
        // Fall back to destroy if logout fails
        try {
          await this.client.destroy();
        } catch (destroyError) {
          this.logger.warn('Client destroy also failed during logout fallback', String(destroyError));
        }
      }
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.setStatus(EngineStatus.DISCONNECTED);
    }
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  // ============= Messaging (delegated) =============

  async sendTextMessage(chatId: string, text: string): Promise<MessageResult> {
    return this.messaging.sendTextMessage(chatId, text);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendImageMessage(chatId, media);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendVideoMessage(chatId, media);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendAudioMessage(chatId, media);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendDocumentMessage(chatId, media);
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    return this.messaging.sendLocationMessage(chatId, location);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    return this.messaging.sendContactMessage(chatId, contact);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    return this.messaging.sendStickerMessage(chatId, media);
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    return this.messaging.replyToMessage(chatId, quotedMsgId, text);
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    return this.messaging.forwardMessage(fromChatId, toChatId, messageId);
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    return this.messaging.reactToMessage(chatId, messageId, emoji);
  }

  async getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    return this.messaging.getMessageReactions(chatId, messageId);
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone: boolean = true): Promise<void> {
    return this.messaging.deleteMessage(chatId, messageId, forEveryone);
  }

  // ============= Contacts (delegated) =============

  async getContacts(): Promise<Contact[]> {
    return this.contacts.getContacts();
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    return this.contacts.getContactById(contactId);
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return this.contacts.checkNumberExists(number);
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    return this.contacts.getProfilePicture(contactId);
  }

  async blockContact(contactId: string): Promise<void> {
    return this.contacts.blockContact(contactId);
  }

  async unblockContact(contactId: string): Promise<void> {
    return this.contacts.unblockContact(contactId);
  }

  // ============= Groups (delegated) =============

  async getGroups(): Promise<Group[]> {
    return this.groups.getGroups();
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    return this.groups.getGroupInfo(groupId);
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    return this.groups.createGroup(name, participants);
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    return this.groups.addParticipants(groupId, participants);
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    return this.groups.removeParticipants(groupId, participants);
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    return this.groups.promoteParticipants(groupId, participants);
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    return this.groups.demoteParticipants(groupId, participants);
  }

  async leaveGroup(groupId: string): Promise<void> {
    return this.groups.leaveGroup(groupId);
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    return this.groups.setGroupSubject(groupId, subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    return this.groups.setGroupDescription(groupId, description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    return this.groups.getGroupInviteCode(groupId);
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    return this.groups.revokeGroupInviteCode(groupId);
  }

  // ============= Labels (delegated) =============

  async getLabels(): Promise<Label[]> {
    return this.labels.getLabels();
  }

  async getLabelById(labelId: string): Promise<Label | null> {
    return this.labels.getLabelById(labelId);
  }

  async getChatLabels(chatId: string): Promise<Label[]> {
    return this.labels.getChatLabels(chatId);
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    return this.labels.addLabelToChat(chatId, labelId);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    return this.labels.removeLabelFromChat(chatId, labelId);
  }

  // ============= Channels (delegated) =============

  async getSubscribedChannels(): Promise<Channel[]> {
    return this.channels.getSubscribedChannels();
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    return this.channels.getChannelById(channelId);
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    return this.channels.subscribeToChannel(inviteCode);
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    return this.channels.unsubscribeFromChannel(channelId);
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    return this.channels.getChannelMessages(channelId, limit);
  }

  // ============= Status/Stories (delegated stubs) =============

  async getContactStatuses(): Promise<Status[]> {
    return this.statuses.getContactStatuses();
  }

  async getContactStatus(contactId: string): Promise<Status[]> {
    return this.statuses.getContactStatus(contactId);
  }

  async postTextStatus(text: string, options?: TextStatusOptions): Promise<StatusResult> {
    return this.statuses.postTextStatus(text, options);
  }

  async postImageStatus(media: MediaInput, caption?: string): Promise<StatusResult> {
    return this.statuses.postImageStatus(media, caption);
  }

  async postVideoStatus(media: MediaInput, caption?: string): Promise<StatusResult> {
    return this.statuses.postVideoStatus(media, caption);
  }

  async deleteStatus(statusId: string): Promise<void> {
    return this.statuses.deleteStatus(statusId);
  }

  // ============= Catalog (delegated stubs) =============

  async getCatalog(): Promise<Catalog | null> {
    return this.catalog.getCatalog();
  }

  async getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return this.catalog.getProducts(options);
  }

  async getProduct(productId: string): Promise<Product | null> {
    return this.catalog.getProduct(productId);
  }

  async sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult> {
    return this.catalog.sendProduct(chatId, productId, body);
  }

  async sendCatalog(chatId: string, body?: string): Promise<MessageResult> {
    return this.catalog.sendCatalog(chatId, body);
  }

  /** Returns the active client or throws when not READY (shared via AdapterContext). */
  private requireClient(): Client {
    this.ensureReady();
    return this.client!;
  }

  private ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.client) {
      throw new Error('WhatsApp client is not ready');
    }
  }
}
