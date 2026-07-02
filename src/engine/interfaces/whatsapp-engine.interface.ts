// WhatsApp Engine Interface - Abstract layer for WA engines
//
// Identity contract (the engine boundary is an anti-corruption layer for WhatsApp's id dialects):
// every JID an engine EMITS in a neutral field (`from` / `to` / `chatId` / `author` / contact + chat
// `id`, etc.) is in the NEUTRAL dialect, so application code never has to know which engine produced
// it. The neutral dialect is small:
//   - `<phone>@c.us`  a user known by phone (the raw `@s.whatsapp.net` form folds into this)
//   - `<id>@g.us`     a group
//   - `<lid>@lid`     a user known ONLY by privacy id - phone genuinely unknown (a first-class state)
//   - `status@broadcast` / `<id>@newsletter` / `<id>@broadcast`  special channels
//   - never `@s.whatsapp.net`, never a `:device` suffix
// Resolution rule: prefer `@c.us` (resolve a lid to its phone when the mapping is known), fall back to
// `@lid` only when it can't be resolved. See `engine/identity/wa-id.ts` for the shared implementation.
// (Ids the engine ACCEPTS - e.g. `sendTextMessage(chatId)` - may be neutral; the adapter de-normalizes
// to its own dialect. Full inbound + outbound conformance is being rolled out per-engine.)

export enum EngineStatus {
  DISCONNECTED = 'disconnected',
  INITIALIZING = 'initializing',
  QR_READY = 'qr_ready',
  AUTHENTICATING = 'authenticating',
  READY = 'ready',
  FAILED = 'failed',
}

export interface MessageResult {
  id: string;
  timestamp: number;
}

export interface MediaInput {
  mimetype: string;
  data: Buffer | string; // Buffer or base64 or URL
  filename?: string;
  caption?: string;
  /** Neutral WIDs (`<phone>@c.us`) to @mention in the caption. The adapter de-normalizes per engine. */
  mentions?: string[];
  /** When true, send as a WhatsApp voice note (PTT). audio-only; ignored by other media types. */
  ptt?: boolean;
}

/**
 * Engine-neutral message type. Each adapter maps its library's native message-type tokens
 * (e.g. whatsapp-web.js `chat`/`ptt`/`vcard`) to this vocabulary at the adapter boundary,
 * so no consumer outside the adapter sees engine-specific type strings. `unknown` covers any
 * type the active engine reports that doesn't map to a first-class kind.
 */
export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'call'
  | 'revoked'
  // A message WhatsApp deliberately withheld from linked/companion devices (e.g. high-security
  // business OTPs): the payload is absent by design, not unparseable. See `mapBaileysMessageType`.
  | 'masked'
  | 'unknown';

export interface IncomingMessage {
  id: string;
  from: string;
  to: string;
  chatId: string;
  body: string;
  type: MessageType;
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  /**
   * True for a status/story broadcast (not a real conversation). Set by the adapter so engine-neutral
   * code can skip these without matching an engine-specific pseudo-JID (e.g. `status@broadcast`).
   */
  isStatusBroadcast?: boolean;
  /** WhatsApp ephemeral/disappearing-messages timer in seconds. Set per-chat on each message
   *  in the raw payload. 0 or undefined = no disappearing timer.
   *  Known values: 86400 (24h), 604800 (7d), 7776000 (90d). */
  ephemeralDuration?: number;
  /** For group messages, the WID of the participant who actually sent it (`from` is the group JID there). */
  author?: string;
  /** WIDs @mentioned in the message (empty/absent when none). Surfaced for command targeting. */
  mentionedIds?: string[];
  /** Set for `call` (call_log) messages: video vs voice, and whether an incoming call went unanswered. */
  call?: { video: boolean; missed: boolean };
  /**
   * Set by the adapter when the sender is identified by a privacy id (e.g. a WhatsApp `@lid`) rather
   * than a phone number, so engine-neutral code can decide whether to attempt phone resolution without
   * matching an engine-specific JID scheme.
   */
  isLidSender?: boolean;
  /**
   * Best-effort phone number (MSISDN digits) of the sender, resolved from a privacy id when inline
   * resolution is enabled (`RESOLVE_LID_TO_PHONE`). `null` when the engine cannot map it. Only
   * populated for `isLidSender` messages.
   */
  senderPhone?: string | null;
  /** Sender contact info, best-effort from the WhatsApp Web cache. Sync fields only (no network). */
  contact?: MessageContact;
  media?: {
    mimetype: string;
    filename?: string;
    data?: string; // base64; absent when the payload was omitted (see `omitted`)
    /** True when the media exceeded the inbound size cap and the blob was dropped (envelope kept). */
    omitted?: boolean;
    /** Decoded byte size of the media; always set when `omitted` is true. */
    sizeBytes?: number;
  };
  quotedMessage?: {
    id: string;
    body: string;
  };
  location?: {
    latitude: number;
    longitude: number;
    description?: string;
    address?: string;
    url?: string;
  };
}

/**
 * Synchronous (already-resolved, no network call) fields of a sender contact, surfaced on
 * {@link IncomingMessage}. Async getters (profile pic / about / formatted number) are intentionally
 * NOT included — they hit WhatsApp servers per message and risk rate-limit/ban. All optional; a key
 * is present only when the engine populated it.
 */
export interface MessageContact {
  /** Sender JID (`…@c.us` or a `…@lid` privacy id). */
  id?: string;
  /** Phone digits, best-effort. For `@lid` senders the authoritative number is `IncomingMessage.senderPhone`. */
  number?: string;
  name?: string;
  pushName?: string;
  shortName?: string;
  /** whatsapp-web.js contact type token. */
  type?: string;
  /** Saved in the account's address book. */
  isMyContact?: boolean;
  /** Is a WhatsApp user. */
  isWAContact?: boolean;
  isBusiness?: boolean;
  isEnterprise?: boolean;
  /** Business verified name. */
  verifiedName?: string;
  /** Business verification level. */
  verifiedLevel?: number;
  isBlocked?: boolean;
  /** Label IDs (CRM). Names are not resolved — that would need a network call. */
  labels?: string[];
}

export interface Contact {
  id: string;
  name?: string;
  pushName?: string;
  number: string;
  isMyContact: boolean;
  isBlocked: boolean;
  profilePicUrl?: string;
}

export interface Group {
  id: string;
  name: string;
  participantsCount?: number;
  isAdmin?: boolean;
  /** JID of the parent community this group is linked to, or null if standalone. */
  linkedParentJID?: string | null;
}

export interface GroupParticipant {
  id: string;
  number: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  createdAt?: number;
  participants: GroupParticipant[];
  isReadOnly?: boolean;
  isAnnounce?: boolean;
  /** JID of the parent community this group is linked to, or null if standalone. */
  linkedParentJID?: string | null;
}

export interface ContactCard {
  name: string;
  number: string;
}

export interface LocationInput {
  latitude: number;
  longitude: number;
  description?: string;
  address?: string;
}

export interface ReactionSender {
  senderId: string;
  emoji: string;
  timestamp: number;
}

export interface MessageReaction {
  emoji: string;
  senders: ReactionSender[];
}

// Phase 3: Labels (WhatsApp Business)
export interface Label {
  id: string;
  name: string;
  hexColor: string;
}

// Phase 3: Status/Stories
export interface Status {
  id: string;
  contact: {
    id: string;
    name?: string;
    pushName?: string;
  };
  type: 'text' | 'image' | 'video';
  caption?: string;
  mediaUrl?: string;
  backgroundColor?: string;
  font?: number;
  timestamp: Date;
  expiresAt: Date;
}

export interface StatusPostOptions {
  /** REQUIRED. Neutral JIDs (@c.us / @lid) permitted to see the status. Maps to Baileys statusJidList. */
  recipients: string[];
  /** Hex background colour (#RRGGBB). Text status only. */
  backgroundColor?: string;
  /** Font index. Text status only. */
  font?: number;
  /** Caption. Image/video status only. */
  caption?: string;
}

export interface StatusResult {
  statusId: string;
  timestamp: Date;
  expiresAt: Date;
}

// Phase 3: Channels/Newsletter
export interface Channel {
  id: string;
  name: string;
  description?: string;
  inviteCode?: string;
  subscriberCount?: number;
  picture?: string;
  verified?: boolean;
  createdAt?: number;
}

export interface ChannelMessage {
  id: string;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  mediaUrl?: string;
}

// Phase 3: Catalog (WhatsApp Business)
export interface Catalog {
  id: string;
  name: string;
  description?: string;
  productCount: number;
  url: string;
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  priceFormatted: string;
  imageUrl?: string;
  url: string;
  isAvailable: boolean;
  retailerId?: string;
}

export interface ProductQueryOptions {
  page?: number;
  limit?: number;
}

export interface PaginatedProducts {
  products: Product[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Lightweight summary of a chat, exposed to the dashboard's real-time chats view.
 * Only library-agnostic primitives are leaked here; raw whatsapp-web.js objects are
 * mapped to this shape inside the adapter.
 */
export interface ChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
}

/**
 * Engine-neutral chat presence state. `typing`/`recording` show the indicator to the chat;
 * `paused` clears it. Best-effort: engines without a presence concept may no-op.
 */
export type ChatState = 'typing' | 'recording' | 'paused';

/**
 * Engine-neutral message delivery status. Each adapter maps its native delivery signal
 * (e.g. whatsapp-web.js MessageAck integers, Baileys WAMessageStatus) to this vocabulary,
 * so no consumer outside the adapter sees engine-specific ack codes.
 */
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Structured payload for a remotely-revoked ("deleted for everyone") message.
 * The engine layer never emits a localized display string; `body` is intentionally
 * empty and the dashboard renders the localized "message deleted" text.
 */
export interface RevokedMessage {
  id: string;
  /**
   * Serialized id of the ORIGINAL message that was deleted (when available).
   *
   * This is the reliable cross-engine field for reconciling the deleted message in
   * your own storage — both adapters populate it with the original message id:
   *  - whatsapp-web.js: `id` is the revocation NOTIFICATION (a distinct message), so
   *    `id !== revokedId`. `revokedId` may be undefined when the original is not in
   *    the local store.
   *  - Baileys: the revoke arrives as a protocolMessage whose key already points at
   *    the original, so `id === revokedId`.
   *
   * Consumers should match on `revokedId` (falling back to `id`) rather than `id`.
   */
  revokedId?: string;
  chatId: string;
  from: string;
  to: string;
  type: 'revoked';
  body: '';
  timestamp: number;
}

export interface ReactionEvent {
  messageId: string;
  chatId: string;
  reaction: string;
  senderId: string;
}

export interface EngineEventCallbacks {
  onQRCode?: (qr: string) => void;
  onReady?: (phone: string, pushName: string) => void;
  onMessage?: (message: IncomingMessage) => void;
  /**
   * Fired for messages the account itself created (outgoing) — including sends composed on a
   * linked phone, which the `message`/`onMessage` event never delivers. Used to emit `message.sent`.
   */
  onMessageCreate?: (message: IncomingMessage) => void;
  /**
   * Fired when the delivery status of an outgoing message advances. The adapter maps its native
   * delivery signal to the neutral `DeliveryStatus`, so consumers never see engine-specific codes.
   */
  onMessageAck?: (messageId: string, status: DeliveryStatus) => void;
  onMessageRevoked?: (message: RevokedMessage) => void;
  onMessageReaction?: (event: ReactionEvent) => void;
  /**
   * Bulk historical messages from an engine's initial sync (e.g. Baileys `messaging-history.set`).
   * They predate the live session, so consumers persist them for the chat view but must not dispatch.
   */
  onHistoryMessages?: (messages: IncomingMessage[]) => void;
  onDisconnected?: (reason: string) => void;
  onStateChanged?: (state: EngineStatus) => void;
  /**
   * Fired on a terminal initialization/authentication failure (e.g. Chromium
   * could not launch, or WhatsApp rejected the stored credentials). The engine
   * has already moved to FAILED; `reason` carries a human-readable cause that
   * callers may surface to operators. Distinct from `onDisconnected`, which is
   * recoverable and triggers reconnection.
   */
  onError?: (reason: string) => void;
}

export interface IWhatsAppEngine {
  // Lifecycle
  initialize(callbacks: EngineEventCallbacks): Promise<void>;
  disconnect(): Promise<void>; // Closes browser but keeps session (can reconnect without QR)
  logout(): Promise<void>; // Logs out and clears session data (requires QR scan again)
  destroy(): Promise<void>;
  // Force-kill THIS engine's own resources immediately (e.g. SIGKILL a wedged Chromium for a stuck
  // session), then best-effort graceful teardown — used to recover a session that destroy() can't.
  // Each adapter kills only its own resources (never a process-wide pkill).
  forceDestroy(): Promise<void>;

  // Status
  getStatus(): EngineStatus;
  getQRCode(): string | null;
  /** Request an 8-char pairing code to link via phone number instead of scanning the QR. */
  requestPairingCode(phoneNumber: string): Promise<string>;
  getPhoneNumber(): string | null;
  getPushName(): string | null;

  // Messaging - Basic
  sendTextMessage(chatId: string, text: string, mentions?: string[]): Promise<MessageResult>;
  sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult>;
  sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult>;
  sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult>;
  sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult>;

  // Messaging - Extended (Phase 3)
  sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult>;
  sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult>;
  sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult>;

  // Reply & Forward
  replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult>;
  forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult>;

  // Reactions (Phase 3)
  reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void>;
  getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]>;

  // Contacts
  getContacts(): Promise<Contact[]>;
  getContactById(contactId: string): Promise<Contact | null>;
  checkNumberExists(number: string): Promise<boolean>;
  /**
   * Resolve a phone number to its canonical chat id in the neutral dialect (`<phone>@c.us`), or null
   * if the number is not registered. The engine owns the JID scheme and returns it already neutralized,
   * so the value is engine-agnostic and round-trips back to a send on any engine.
   */
  getNumberId(number: string): Promise<string | null>;
  /**
   * Best-effort resolution of a contact id to a phone number (MSISDN digits), or `null` when the
   * engine cannot map it (e.g. a privacy `@lid` the account has never seen). The contact id is the
   * engine's native scheme; the adapter decides how to resolve it.
   */
  resolveContactPhone(contactId: string): Promise<string | null>;

  // Groups - Basic
  getGroups(): Promise<Group[]>;

  // Groups - Extended (Phase 3)
  getGroupInfo(groupId: string): Promise<GroupInfo | null>;
  createGroup(name: string, participants: string[]): Promise<Group>;
  addParticipants(groupId: string, participants: string[]): Promise<void>;
  removeParticipants(groupId: string, participants: string[]): Promise<void>;
  promoteParticipants(groupId: string, participants: string[]): Promise<void>;
  demoteParticipants(groupId: string, participants: string[]): Promise<void>;
  leaveGroup(groupId: string): Promise<void>;
  setGroupSubject(groupId: string, subject: string): Promise<void>;
  setGroupDescription(groupId: string, description: string): Promise<void>;
  getGroupInviteCode(groupId: string): Promise<string>;
  revokeGroupInviteCode(groupId: string): Promise<string>;

  // Message Operations
  deleteMessage(chatId: string, messageId: string, forEveryone?: boolean): Promise<void>;
  getChatHistory(chatId: string, limit?: number, includeMedia?: boolean): Promise<IncomingMessage[]>;

  // Contact Extended Operations
  getProfilePicture(contactId: string): Promise<string | null>;
  blockContact(contactId: string): Promise<void>;
  unblockContact(contactId: string): Promise<void>;

  // Labels (Phase 3) - WhatsApp Business only
  getLabels(): Promise<Label[]>;
  getLabelById(labelId: string): Promise<Label | null>;
  getChatLabels(chatId: string): Promise<Label[]>;
  addLabelToChat(chatId: string, labelId: string): Promise<void>;
  removeLabelFromChat(chatId: string, labelId: string): Promise<void>;

  // Channels/Newsletter (Phase 3)
  getSubscribedChannels(): Promise<Channel[]>;
  getChannelById(channelId: string): Promise<Channel | null>;
  subscribeToChannel(inviteCode: string): Promise<Channel>;
  unsubscribeFromChannel(channelId: string): Promise<void>;
  getChannelMessages(channelId: string, limit?: number): Promise<ChannelMessage[]>;

  // Status/Stories (Phase 3)
  getContactStatuses(): Promise<Status[]>;
  getContactStatus(contactId: string): Promise<Status[]>;
  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult>;
  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult>;
  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult>;
  deleteStatus(statusId: string): Promise<void>;

  // Catalog (Phase 3) - WhatsApp Business only
  getCatalog(): Promise<Catalog | null>;
  getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts>;
  getProduct(productId: string): Promise<Product | null>;
  sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult>;
  sendCatalog(chatId: string, body?: string): Promise<MessageResult>;

  // Chats
  getChats(): Promise<ChatSummary[]>;
  sendSeen(chatId: string): Promise<boolean>;
  markUnread(chatId: string): Promise<boolean>;
  deleteChat(chatId: string): Promise<boolean>;
  /**
   * Send a typing/recording presence indicator to a chat, or clear it (`paused`).
   * Engine-agnostic and best-effort: engines without a presence concept should no-op.
   */
  sendChatState(chatId: string, state: ChatState): Promise<void>;
}
