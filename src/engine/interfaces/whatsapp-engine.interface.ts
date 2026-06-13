// WhatsApp Engine Interface - Abstract layer for WA engines

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
  ack?: number;
}

export interface MediaInput {
  mimetype: string;
  data: Buffer | string; // Buffer or base64 or URL
  filename?: string;
  caption?: string;
}

export interface IncomingMessage {
  id: string;
  from: string;
  to: string;
  chatId: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  media?: {
    mimetype: string;
    filename?: string;
    data?: string; // base64
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

export interface TextStatusOptions {
  backgroundColor?: string;
  font?: number;
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

export interface EngineEventCallbacks {
  onQRCode?: (qr: string) => void;
  onReady?: (phone: string, pushName: string) => void;
  onMessage?: (message: IncomingMessage) => void;
  onMessageAck?: (messageId: string, ack: number) => void;
  onDisconnected?: (reason: string) => void;
  onStateChanged?: (state: EngineStatus) => void;
}

export interface IWhatsAppEngine {
  // Lifecycle
  initialize(callbacks: EngineEventCallbacks): Promise<void>;
  disconnect(): Promise<void>; // Closes browser but keeps session (can reconnect without QR)
  logout(): Promise<void>; // Logs out and clears session data (requires QR scan again)
  destroy(): Promise<void>;

  // Status
  getStatus(): EngineStatus;
  getQRCode(): string | null;
  getPhoneNumber(): string | null;
  getPushName(): string | null;

  // Messaging - Basic
  sendTextMessage(chatId: string, text: string): Promise<MessageResult>;
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
  postTextStatus(text: string, options?: TextStatusOptions): Promise<StatusResult>;
  postImageStatus(media: MediaInput, caption?: string): Promise<StatusResult>;
  postVideoStatus(media: MediaInput, caption?: string): Promise<StatusResult>;
  deleteStatus(statusId: string): Promise<void>;

  // Catalog (Phase 3) - WhatsApp Business only
  getCatalog(): Promise<Catalog | null>;
  getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts>;
  getProduct(productId: string): Promise<Product | null>;
  sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult>;
  sendCatalog(chatId: string, body?: string): Promise<MessageResult>;
}
