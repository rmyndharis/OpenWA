// API Service Layer for OpenWA Dashboard
// Centralized API client with TypeScript types

import { warnIfInsecureHttpUrl } from '../utils/urlSecurity';
import {
  broadcastAuthEvent,
  clearSessionMetadata,
  DASHBOARD_CSRF_HEADER,
  DASHBOARD_CSRF_HEADER_VALUE,
  getActiveApiKeyId,
  isKeyUnusable,
} from '../utils/authLifecycle';
import { fetchAllPages } from '../utils/fetchAllPages';

// Resolve the API base URL. By default this is the same-origin relative path '/api',
// correct when the dashboard and API are served from the same origin (the default
// single-container setup). For a split-origin deployment (dashboard hosted separately
// from the API), set VITE_API_URL at build time to the API ORIGIN — e.g.
// `VITE_API_URL=https://gateway.example.com` — and the '/api' prefix is appended here.
// Previously VITE_API_URL was documented but never read, so the dashboard always called
// same-origin '/api' and a split deployment failed with "Invalid API Key" (#91).
// Exported so direct fetches (e.g. auth/validate in Login.tsx / App.tsx) honor VITE_API_URL
// too — otherwise split-origin deployments break. Empty VITE_API_URL → '/api'.
export const API_ORIGIN = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
export const API_BASE_URL = `${API_ORIGIN}/api`;
// Warn (not refuse — would break dev + TLS-terminating-proxy) when the API origin is an
// insecure http:// URL pointing at a non-localhost host (API keys sent in cleartext).
if (API_ORIGIN) warnIfInsecureHttpUrl(API_ORIGIN, 'VITE_API_URL');

// =============================================================================
// Types
// =============================================================================

/**
 * The four tunable keys, as the gateway resolves them — not the raw stored column, which the API
 * never returns. `maxReconnectAttempts` is null when reconnects are unlimited, which is the default
 * and which no number in the accepted 0-20 range can express.
 */
export interface SessionConfig {
  autoRejectCalls: boolean;
  maxReconnectAttempts: number | null;
  reconnectBaseDelay: number;
  linkPreview: boolean | null;
}

export type SessionProxyType = 'http' | 'https' | 'socks4' | 'socks5';

export interface SessionProxy {
  enabled: boolean;
  proxyType: SessionProxyType | null;
  proxyHost: string | null;
  hasCredentials: boolean;
}

export interface CreateSessionOptions {
  proxyUrl?: string;
  proxyType?: SessionProxyType;
}

export interface Session {
  id: string;
  name: string;
  status:
    | 'created'
    | 'initializing'
    | 'authenticating'
    | 'qr_ready'
    | 'ready'
    | 'disconnected'
    | 'action_required'
    | 'failed';
  /**
   * Whether the gateway holds a live engine for this session right now. The precondition the
   * lifecycle routes enforce, and not derivable from `status`: `disconnected` covers both a session
   * mid automatic-reconnect (engine present, start 400s) and one stopped through stop() (no engine).
   * Optional BY DESIGN, not drift: the wire always carries it, but this client's state model
   * clears it to "unknown" after a websocket status event until the row refreshes, so the action
   * helpers fall back to the historical status set instead of trusting a stale value.
   */
  engineLoaded?: boolean;
  phone?: string | null;
  pushName?: string | null;
  connectedAt?: string | null;
  lastActive?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Human-readable reason carried while the status is 'failed' (terminal failure),
   * 'action_required' (operator must intervene, e.g. acknowledge an onboarding modal), or
   * 'initializing' during an engine-internal reconnect (from the fifth consecutive attempt, or while a
   * retry waits after a failed relaunch). */
  lastError?: string | null;
  /**
   * A limit WhatsApp itself has placed on the account, or null when there is none. Distinct from
   * `lastError`, which describes a fault on the gateway's side of the link. Optional only because a
   * dashboard can be served by a gateway that predates the field.
   */
  restriction?: AccountRestriction | null;
}

/** One participant's presence within a chat. */
export interface ParticipantPresence {
  id: string;
  /** `composing`/`recording` mean actively typing or recording; `paused` means they stopped. */
  state: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';
  /** Unix SECONDS. Absent whenever the contact's privacy settings hide last-seen. */
  lastSeen?: number;
}

/** The last presence reported for a chat since it was subscribed. */
export interface ChatPresence {
  chatId: string;
  participants: ParticipantPresence[];
  groupOnlineCount?: number;
  /** When the gateway received the report — NOT a WhatsApp timestamp. */
  observedAt: string;
}

/**
 * A restriction WhatsApp has in force on a session's account.
 *
 * `reachout_timelock` leaves the session connected and existing chats working — only starting new
 * conversations is blocked — which is why it can appear on a perfectly `ready` session. `tos_block`
 * and `proxy_block` refuse the connection itself and so cannot. `passkey_required` is WhatsApp asking
 * for a passkey before it completes a link, which the Baileys engine cannot answer; the session stays
 * at its QR, so it appears on a session that is not yet linked and never on a `ready` one.
 */
export interface AccountRestriction {
  kind: 'reachout_timelock' | 'tos_block' | 'proxy_block' | 'passkey_required';
  /** The engine's own token for the cause, verbatim (`TOS_BLOCK`, `BIZ_QUALITY`, …). */
  code: string;
  /** ISO timestamp when enforcement ends, when WhatsApp states one. */
  expiresAt?: string | null;
}

export interface SessionStats {
  total: number;
  active: number;
  ready: number;
  disconnected: number;
  byStatus: Record<string, number>;
  memoryUsage?: { heapUsed: number; heapTotal: number; rss: number };
}

export type WebhookFilterOperator = 'is' | 'isNot' | 'contains' | 'equals';

export interface WebhookFilterCondition {
  field: string;
  operator: WebhookFilterOperator;
  value: string | string[] | boolean;
  caseSensitive?: boolean;
}

export interface WebhookFilters {
  conditions: WebhookFilterCondition[];
}

export interface Webhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  filters?: WebhookFilters | null;
  active: boolean;
  retryCount: number;
  /** Null until the first delivery attempt. */
  lastTriggeredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Request bodies for webhook writes. `secret` and `headers` are write-only: no webhook read returns them.
export interface CreateWebhookRequest {
  url: string;
  events: string[];
  filters?: WebhookFilters | null;
  secret?: string;
  headers?: Record<string, string>;
}

export interface UpdateWebhookRequest {
  url?: string;
  events?: string[];
  active?: boolean;
  filters?: WebhookFilters | null;
  /** An empty string removes the stored secret. */
  secret?: string;
  /** Replaces the stored map wholesale; `{}` removes every custom header. */
  headers?: Record<string, string>;
}

export interface MessageTemplate {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header?: string | null;
  footer?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplatePayload {
  name: string;
  body: string;
  header?: string | null;
  footer?: string | null;
}

/** The capability vocabulary a key may be BLOCKED from; an empty list blocks nothing. */
export const API_KEY_CAPABILITIES = [
  'messages:read',
  'messages:send',
  'messages:edit',
  'messages:delete',
  'messages:moderate',
  'chats:read',
  'chats:manage',
  'contacts:read',
  'contacts:write',
  'groups:read',
  'groups:manage',
  'groups:invite',
  'sessions:read',
  'sessions:create',
  'sessions:lifecycle',
  'sessions:pair',
  'sessions:config',
  'sessions:proxy',
  'labels:read',
  'labels:write',
  'profile:write',
  'catalog:read',
  'catalog:send',
  'templates:read',
  'templates:write',
  'webhooks:read',
  'webhooks:write',
  'automation:read',
  'automation:write',
  'channels:read',
  'channels:write',
  'status:read',
  'status:send',
  'status:delete',
  'media:convert',
  'calls:manage',
  'search:read',
  'events:read',
  'audit:read',
  'stats:read',
  'settings:read',
  'infra:read',
  'infra:write',
  'plugins:read',
  'plugins:write',
  'integrations:manage',
  'apikeys:manage',
] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  role: 'admin' | 'operator' | 'viewer';
  allowedIps?: string[];
  allowedSessions?: string[];
  allowedChats?: string[];
  deniedPermissions?: ApiKeyCapability[];
  isActive: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  usageCount: number;
  createdAt: string;
}

/** The creation response: every list/detail field plus the plaintext key, shown exactly once. */
export interface CreatedApiKey extends ApiKey {
  apiKey: string;
}

export interface AuditLog {
  id: string;
  action: string;
  severity: 'info' | 'warn' | 'error';
  apiKeyId: string | null;
  apiKeyName: string | null;
  sessionId: string | null;
  sessionName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  /** Null when the action succeeded. */
  errorMessage: string | null;
  /** Free-form context whose shape varies per action. */
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MessageResponse {
  messageId: string;
  timestamp: number;
}

// Mirrors the backend engine ChatKind (dashboard cannot import wa-id.ts).
export type ChatKind = 'individual' | 'group' | 'channel' | 'status' | 'broadcast' | 'unknown';
// Mirrors CHAT_KINDS in the backend webhook filter registry (src/modules/webhook/filters/filter-types.ts).
export const CHAT_KINDS: readonly ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

// Chat summary returned by GET /sessions/:id/chats (mirrors the backend ChatSummary).
export interface Chat {
  id: string;
  name: string;
  /** Baileys only: phone digits when the chat is held under a privacy id and the session can map it. */
  phone?: string;
  isGroup: boolean;
  kind: ChatKind;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
  lastMessageType?: MessageType;
  archived: boolean;
  pinned: boolean;
  muted: boolean;
  muteExpiration?: number;
}

// Engine-neutral message types (mirrors the backend's IWhatsAppEngine MessageType). The backend
// normalizes raw engine tokens at the adapter boundary (#265/#270), so persisted rows, the
// message.received/sent payloads, and the websocket all use these values.
export const MESSAGE_TYPES = [
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'call',
  'revoked',
  'order',
  'product',
  'masked',
  'unknown',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Coerce an arbitrary string (e.g. a raw websocket payload field) to a known MessageType. */
export function asMessageType(value: string | undefined): MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(value ?? '') ? (value as MessageType) : 'unknown';
}

export interface ChatMessage {
  id: string;
  waMessageId?: string;
  chatId: string;
  /** Chat kind of the source conversation (present on live engine/WS payloads). */
  kind?: ChatKind;
  /**
   * Human-readable name of the message's sender. For a group this is the participant who posted
   * (their pushName/contact name); the chat view uses it to label who said what, like WhatsApp. Null
   * on legacy rows or when the engine could not resolve a name.
   */
  chatName?: string;
  /**
   * Stable sender identity for a group message: the participant JID who actually posted (`from` is
   * the group JID). Present on live/engine payloads and on rows persisted after the column was
   * added; absent on 1:1 messages, outgoing echoes, and legacy rows.
   */
  author?: string;
  from: string;
  to: string;
  body: string;
  type: MessageType;
  direction: 'incoming' | 'outgoing';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  timestamp?: number;
  createdAt: string;
  /**
   * Storage key of the archived media copy. Null once retention deleted it, even where an older gateway left
   * `metadata.media.archived` set. Absent on live socket payloads and engine history.
   */
  mediaPath?: string | null;
  metadata?: {
    poll?: { name: string; options: string[]; allowMultipleAnswers: boolean };
    media?: {
      mimetype: string;
      filename?: string;
      data?: string;
      omitted?: boolean;
      sizeBytes?: number;
      /** With `omitted`: the inline copy was dropped because the chat-media archive holds the bytes. */
      archived?: boolean;
    };
    quotedMessage?: { id: string; body: string };
    reactions?: Record<string, string>;
    /** The gateway observed an edit of this message. */
    edited?: boolean;
    call?: { video: boolean; missed: boolean };
    /** Business prompt choices (Baileys). Present on inbound prompts that offer buttons. */
    buttons?: Array<{ id: string; text: string }>;
  };
}

// Live WhatsApp message from the engine history endpoint (not a persisted DB row): it carries `fromMe`
// instead of `direction`/`status`. Used to backfill a chat thread the gateway never captured live.
export interface EngineHistoryMessage {
  id: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: MessageType;
  /** Unix timestamp in seconds. */
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  isStatusBroadcast?: boolean;
  kind: ChatKind;
  /** Disappearing-messages timer on the chat, in seconds. Absent when the chat has none set. */
  ephemeralDuration?: number;
  /** True when the sender forwarded this message rather than writing it. Absent otherwise. */
  isForwarded?: boolean;
  /** How many times the message has been forwarded. Set with `isForwarded`. */
  forwardingScore?: number;
  /** Sender in a group: `from` is the group JID, so this participant WID is the real poster. */
  author?: string;
  mentionedIds?: string[];
  /** Present on `call` messages only. */
  call?: { video: boolean; missed: boolean };
  isLidSender?: boolean;
  senderPhone?: string | null;
  /**
   * Sender contact info, best-effort from the engine's cache. History carries `name` and `pushName`;
   * the richer fields are added when `WEBHOOK_CONTACT_DETAILS=true`, as on `message.received`.
   */
  contact?: {
    id?: string;
    number?: string;
    name?: string;
    pushName?: string;
    shortName?: string;
    type?: string;
    isMyContact?: boolean;
    isWAContact?: boolean;
    isBusiness?: boolean;
    isEnterprise?: boolean;
    verifiedName?: string;
    verifiedLevel?: number;
    isBlocked?: boolean;
    labels?: string[];
  };
  /** Status/story styling. Declared by the engine payload; this route never sets either. */
  backgroundColor?: string;
  font?: number;
  media?: {
    mimetype: string;
    filename?: string;
    data?: string;
    omitted?: boolean;
    sizeBytes?: number;
  };
  poll?: { name: string; options: string[]; allowMultipleAnswers: boolean };
  quotedMessage?: { id: string; body: string };
  location?: { latitude: number; longitude: number; description?: string; address?: string; url?: string };
  /** Present on `order` messages only: the placed cart, plus the single-order token for its items. */
  order?: { orderId: string; token?: string };
  /** Present on `product` messages only: the catalog product shared into the chat. */
  product?: { productId: string; title?: string; description?: string; businessOwnerJid?: string };
}

// Mirrors the backend engine Channel / ChannelMessage (GET /sessions/:id/channels[/:id/messages]).
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

// Mirrors the backend engine Status / IWhatsAppEngine status methods (GET /sessions/:id/status).
export interface StatusUpdate {
  id: string;
  contact: { id: string; name?: string; pushName?: string };
  type: 'text' | 'image' | 'video' | 'voice';
  caption?: string;
  mediaUrl?: string;
  backgroundColor?: string;
  font?: number;
  timestamp: string;
  expiresAt: string;
}

export interface ContactStatusGroup {
  contact: { id: string; name?: string; pushName?: string };
  items: StatusUpdate[];
  latest: string;
}

/** GET /sessions/:id/groups/:groupId (GroupInfoDto). */
export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  createdAt?: number;
  participants: Array<{ id: string; number: string; name?: string; isAdmin: boolean; isSuperAdmin: boolean }>;
  /** Only admins may edit the group's info. */
  locked?: boolean;
  announce?: boolean;
}

export interface GroupAck {
  success: boolean;
  message: string;
}

/** One participant's outcome of a membership write; the gateway answers 200 even when some are refused. */
export interface GroupParticipantResult {
  id: string;
  success: boolean;
  status?: number;
  message?: string;
}

export interface GroupParticipantsAck extends GroupAck {
  results: GroupParticipantResult[];
}

// An entry of the session's address book, from GET /sessions/:id/contacts: what the recipient pickers and the
// chat list's saved-contact check read. Only the name, push name and picture are optional.
export interface Contact {
  id: string;
  name?: string;
  pushName?: string;
  /**
   * MSISDN digits for a `<phone>@c.us` id. For an `<lid>@lid` id, the lid's digits on whatsapp-web.js, which are
   * not a phone number, and on Baileys the phone's digits, or '' when the phone is unknown.
   * Digits only, no separators — always present in the response. */
  number: string;
  isMyContact: boolean;
  isBlocked: boolean;
  /** Absent when the contact has none or privacy hides it. */
  profilePicUrl?: string;
}

export interface SendMediaPayload {
  base64?: string;
  url?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
  /** Quote an earlier message, making the media send a reply. Omit for an ordinary send. */
  quotedMessageId?: string;
}

// Payloads below mirror the backend DTOs in src/modules/message/dto (raw bodies, no envelope).
export interface SendLocationPayload {
  chatId: string;
  latitude: number;
  longitude: number;
  description?: string;
  address?: string;
}

export interface SendContactPayload {
  chatId: string;
  contactName: string;
  contactNumber: string;
}

export interface SendPollPayload {
  chatId: string;
  name: string;
  options: string[];
  allowMultipleAnswers?: boolean;
}

export interface ForwardMessagePayload {
  fromChatId: string;
  toChatId: string;
  messageId: string;
}

// Media block of a single bulk message (BulkMediaDto — no caption; caption sits next to it).
export interface BulkMediaPayload {
  url?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
  ptt?: boolean;
}

export interface BulkMessageItem {
  chatId: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'document';
  content: {
    text?: string;
    image?: BulkMediaPayload;
    video?: BulkMediaPayload;
    audio?: BulkMediaPayload;
    document?: BulkMediaPayload;
    caption?: string;
    mentions?: string[];
  };
  variables?: Record<string, string>;
}

export interface SendBulkPayload {
  batchId?: string;
  messages: BulkMessageItem[];
  options?: {
    delayBetweenMessages?: number;
    randomizeDelay?: boolean;
    stopOnError?: boolean;
  };
}

/** 202 response of POST send-bulk — the batch is processing asynchronously; poll getBatchStatus. */
export interface BulkBatchResponse {
  batchId: string;
  status: string;
  totalMessages: number;
  estimatedCompletionTime?: string;
  statusUrl: string;
}

export type BatchStatus = 'pending' | 'processing' | 'completed' | 'cancelled' | 'failed';

export interface BatchProgress {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  cancelled: number;
}

export interface BatchMessageResult {
  chatId: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  messageId?: string;
  error?: { code: string; message: string };
  sentAt?: string;
}

/** GET batch/:batchId shape. */
export interface BatchStatusResponse {
  batchId: string;
  status: BatchStatus;
  progress: BatchProgress;
  /** One entry per recipient already attempted — empty until the first send resolves. */
  results: BatchMessageResult[];
  startedAt?: string | null;
  completedAt?: string | null;
}

/** POST batch/:batchId/cancel shape: the batch state without per-recipient results or timestamps. */
export interface BatchCancelResponse {
  batchId: string;
  status: BatchStatus;
  progress: BatchProgress;
}

export interface HealthStatus {
  status: 'ok' | 'error';
  timestamp?: string;
  /** Running backend version (from package.json) — read live so the sidebar never shows a stale build. */
  version?: string;
  details?: {
    database?: { status: string };
    redis?: { status: string };
    queue?: { status: string };
  };
}

/** GET /infra/update-check: the running version against the latest published release. */
export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
}

export interface InfraStatus {
  // `builtIn` = OpenWA's own bundled container is actually running and backing this service (live),
  // not just the saved intent; falls back to the saved flag (the environment's first) beside a host that reaches the
  // bundled container when Docker is unavailable. (#488) `running` = a bundled container OpenWA created is up,
  // whether or not the service uses it, beside this instance's own built-in flag (the environment's first, else the
  // saved one); false for one Docker Compose created and with that flag not true, absent while Docker is unreachable,
  // and from an older gateway.
  database: { connected: boolean; type: string; host: string; builtIn: boolean; running?: boolean };
  redis: { enabled: boolean; connected: boolean; host: string; port: number; builtIn: boolean; running?: boolean };
  queue: {
    enabled: boolean;
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: {
    type: 'local' | 's3';
    path?: string;
    bucket?: string;
    // S3 only, when an endpoint is set: the one the server dials, which a stopped bundled MinIO still names.
    endpoint?: string;
    builtIn: boolean;
    running?: boolean;
    s3Available?: boolean;
  };
  engine: {
    type: string;
    headless: boolean;
    // whatsapp-web.js only: the WhatsApp Web build the gateway resolves for sessions to pin (distinct from the
    // library version, and not necessarily the build a page runs: a session whose pinned page cannot be
    // downloaded or written starts unpinned) and how it was chosen. (#488)
    webVersion?: string | null;
    webVersionSource?: 'pinned' | 'auto' | 'native';
  };
  /**
   * Editable settings supplied by a layer above `data/.env.generated` (the container environment or a
   * project `.env`), which therefore cannot be changed from this page until that layer is. Reported by
   * the gateway rather than inferred from a running-vs-saved mismatch, because that mismatch is also
   * what an unrestarted save looks like and the two need opposite advice (#1082).
   *
   * Optional only because a dashboard can be served by a gateway that predates the field.
   */
  envPinned?: string[];
}

// Saved infrastructure config (from data/.env.generated) used to hydrate the form.
// Secrets are never returned — `*Set` flags indicate whether a value is stored.
export interface SavedConfig {
  database: {
    type: 'sqlite' | 'postgres';
    builtIn: boolean;
    // Whether the saved config states the built-in mode of this service. False when a host the environment
    // pins decides it, when the file does not select the service (the first boot writes every flag as false),
    // when the file holds the bundled host with the flag not true (the next boot dials the container) and when
    // nothing is saved: the form then follows what /infra/status reports as running.
    builtInSet: boolean;
    host: string;
    port: string;
    username: string;
    database: string;
    schema: string;
    poolSize: number;
    sslEnabled: boolean;
    sslRejectUnauthorized: boolean;
    passwordSet: boolean;
  };
  redis: { enabled: boolean; builtIn: boolean; builtInSet: boolean; host: string; port: string; passwordSet: boolean };
  queue: { enabled: boolean };
  storage: {
    type: 'local' | 's3';
    builtIn: boolean;
    builtInSet: boolean;
    localPath: string;
    s3Bucket: string;
    s3Region: string;
    s3Endpoint: string;
    s3CredentialsSet: boolean;
  };
  engine: { type: string; headless: boolean; sessionDataPath: string; browserArgs: string };
}

export interface SaveConfigPayload {
  database?: {
    // Absent keeps the stored selection; the form leaves out a type the environment pins.
    type?: 'sqlite' | 'postgres';
    builtIn?: boolean;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    schema?: string;
    poolSize?: number;
    sslEnabled?: boolean;
    sslRejectUnauthorized?: boolean;
  };
  redis?: {
    enabled?: boolean;
    builtIn?: boolean;
    host?: string;
    port?: string;
    password?: string;
  };
  queue?: {
    enabled?: boolean;
  };
  storage?: {
    type?: 'local' | 's3';
    builtIn?: boolean;
    localPath?: string;
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
  };
  engine?: {
    type?: string;
    headless?: boolean;
    sessionDataPath?: string;
    browserArgs?: string;
  };
}

// Global message search (mirrors the backend GET /search contract from #664).
// `timestamp` is epoch-seconds (the messages column is seconds, not ms); `dateFrom`/`dateTo`
// are epoch-ms on the wire — see `dateFrom`/`dateTo` JSDoc below.
export interface SearchParams {
  q: string;
  sessionId?: string;
  chatId?: string;
  direction?: string;
  type?: string;
  from?: string;
  /** Epoch-ms lower bound (inclusive) — the backend binds against messages.timestamp (/1000). */
  dateFrom?: number;
  /** Epoch-ms upper bound (inclusive). */
  dateTo?: number;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  messageId: string;
  waMessageId: string;
  sessionId: string;
  chatId: string;
  body: string;
  /** Provider-generated excerpt with `<mark>` highlight markers — render as text, never as HTML. */
  snippet: string;
  /** Epoch-seconds (mirrors the persisted messages.timestamp column). */
  timestamp: number;
  type: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  score?: number;
}

export interface SearchResults {
  hits: SearchHit[];
  total: number;
  tookMs: number;
  provider: string;
}

// =============================================================================
// API Client
// =============================================================================

// Shared failure handling for every response shape (json/text/blob). When the stored API key is
// unusable (a 401 for an invalid/expired/revoked key, or a 403 because its allowedIps refuse this
// client) clear it and return to login so the user isn't stuck on a dashboard where every request
// fails; the never-settling promise halts this request's chain so callers neither flash a generic
// error toast nor receive an undefined payload while the page navigates away. Otherwise throw an
// Error carrying the HTTP status and, when the gateway supplied one, its machine code.
// `sentKey` is the key the request carried (null when none). Logout aborts nothing in flight, so an
// answer can arrive after the stored key changed. With a key sent but none stored, a sign-out is
// already under way (an earlier failure of the same burst, or the user on the login form): stay
// silent and do not navigate again. A request sent without a key comes only from a chain that
// outlived a logout (the dashboard shows the login form whenever no key is stored), so with none
// stored it stays silent too rather than reloading the login form under the user. With another key
// stored, the answer speaks for a key no longer in use and must not sign out the current one, so it
// fails like any other error.
async function handleErrorResponse<T>(response: Response, sentActorId: string | null): Promise<T> {
  // On a non-JSON body (e.g. a reverse-proxy 502/503/504 HTML page) fall through to `HTTP <status>`
  // rather than statusText: the toast folds an exact `HTTP 502`/`HTTP 503` into its connection-lost
  // toast (a 504 keeps its own), and statusText is empty over HTTP/2 anyway.
  const error = await response.json().catch(() => ({}));
  const storedActorId = getActiveApiKeyId();
  if (isKeyUnusable(response.status, error.message) && (storedActorId === sentActorId || storedActorId === null)) {
    clearSessionMetadata();
    if (sentActorId !== null && storedActorId === sentActorId) {
      broadcastAuthEvent({ type: 'logout' });
    }
    if (typeof window !== 'undefined') {
      if (sentActorId !== null && storedActorId === sentActorId) window.location.assign('/');
      return new Promise<T>(() => {});
    }
  }
  // Carry the HTTP status on the Error (message unchanged, so the toast de-dup still matches) so
  // callers can tell apart a permission 403 from a real server 5xx instead of guessing from text.
  // Carry the machine `code` too: the gateway's stable codes (SESSION_LOGOUT_INCOMPLETE,
  // SESSION_NAME_TEARDOWN_PENDING, ...) drive specific recovery UI, and a reverse-proxy 502 that
  // never reached the gateway carries no code at all.
  const err = new Error(error.message || `HTTP ${response.status}`) as Error & {
    status?: number;
    code?: string;
    retryAfterSeconds?: number;
  };
  err.status = response.status;
  if (typeof error.code === 'string') err.code = error.code;
  // Retry-After in seconds (an HTTP date is ignored): the media loaders wait at least that long before retrying a 503.
  const retryAfter = Number(response.headers.get('Retry-After') ?? Number.NaN);
  if (retryAfter >= 0) err.retryAfterSeconds = retryAfter;
  throw err;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const sentActorId = getActiveApiKeyId();

  // For FormData (file uploads) let the browser set multipart/form-data + boundary itself.
  const isFormData = options.body instanceof FormData;
  const headers: HeadersInit = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    [DASHBOARD_CSRF_HEADER]: DASHBOARD_CSRF_HEADER_VALUE,
    ...options.headers,
  };

  const response = await fetch(url, { ...options, credentials: 'include', headers });

  if (!response.ok) {
    return handleErrorResponse<T>(response, sentActorId);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

/** Like {@link request} but returns the raw response text, e.g. a plugin's HTML config-UI bundle. */
async function requestText(endpoint: string): Promise<string> {
  const sentActorId = getActiveApiKeyId();
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    credentials: 'include',
    headers: { [DASHBOARD_CSRF_HEADER]: DASHBOARD_CSRF_HEADER_VALUE },
  });

  if (!response.ok) {
    return handleErrorResponse<string>(response, sentActorId);
  }

  return response.text();
}

/** Like {@link request} but returns a Blob, e.g. for status media downloads. */
async function requestBlob(endpoint: string, signal?: AbortSignal): Promise<Blob> {
  const url = `${API_BASE_URL}${endpoint}`;
  const sentActorId = getActiveApiKeyId();

  const headers: HeadersInit = {
    [DASHBOARD_CSRF_HEADER]: DASHBOARD_CSRF_HEADER_VALUE,
  };

  const response = await fetch(url, { credentials: 'include', headers, signal });

  if (!response.ok) {
    return handleErrorResponse<Blob>(response, sentActorId);
  }

  return response.blob();
}

let pendingLogout: Promise<void> = Promise.resolve();

export const authApi = {
  createSession: async (apiKey: string) => {
    // Wait for any in-flight logout DELETE so a slow Set-Cookie Max-Age=0 response cannot clear
    // the freshly created session cookie on rapid logout-then-relogin.
    await pendingLogout;
    return fetch(`${API_BASE_URL}/auth/session`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
        [DASHBOARD_CSRF_HEADER]: DASHBOARD_CSRF_HEADER_VALUE,
      },
    });
  },
  getSession: () =>
    fetch(`${API_BASE_URL}/auth/session`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        [DASHBOARD_CSRF_HEADER]: DASHBOARD_CSRF_HEADER_VALUE,
      },
    }),
  deleteSession: () => {
    const req = fetch(`${API_BASE_URL}/auth/session`, {
      method: 'DELETE',
      credentials: 'include',
      keepalive: true,
      headers: {
        [DASHBOARD_CSRF_HEADER]: DASHBOARD_CSRF_HEADER_VALUE,
      },
    });
    pendingLogout = req.then(
      () => undefined,
      () => undefined,
    );
    return req;
  },
};

// =============================================================================
// Session API
// =============================================================================

const enc = encodeURIComponent;

/** Safety cap on paginated chat and contact list walks so a non-terminating server cannot loop forever. */
export const MAX_PAGINATED_LIST_ITEMS = 50_000;

export const sessionApi = {
  list: () => request<Session[]>('/sessions'),
  get: (id: string) => request<Session>(`/sessions/${enc(id)}`),
  create: (name: string, options?: CreateSessionOptions) =>
    request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name,
        ...(options?.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
      }),
    }),
  delete: (id: string) => request<void>(`/sessions/${enc(id)}`, { method: 'DELETE' }),
  getConfig: (id: string) => request<SessionConfig>(`/sessions/${enc(id)}/config`),
  // PATCH merges: only the keys sent are touched. Send null to clear one back to its default.
  updateConfig: (id: string, patch: Partial<Record<keyof SessionConfig, boolean | number | null>>) =>
    request<SessionConfig>(`/sessions/${enc(id)}/config`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  getProxy: (id: string) => request<SessionProxy>(`/sessions/${enc(id)}/proxy`),
  updateProxy: (id: string, patch: { proxyUrl?: string | null }) =>
    request<SessionProxy>(`/sessions/${enc(id)}/proxy`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  start: (id: string) => request<Session>(`/sessions/${enc(id)}/start`, { method: 'POST' }),
  stop: (id: string) => request<Session>(`/sessions/${enc(id)}/stop`, { method: 'POST' }),
  logout: (id: string) => request<Session>(`/sessions/${enc(id)}/logout`, { method: 'POST' }),
  forceKill: (id: string) => request<Session>(`/sessions/${enc(id)}/force-kill`, { method: 'POST' }),
  getQR: (id: string) => request<{ qrCode: string; status: string }>(`/sessions/${enc(id)}/qr`),
  requestPairingCode: (id: string, phoneNumber: string) =>
    request<{ pairingCode: string; status: string }>(`/sessions/${enc(id)}/pairing-code`, {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    }),
  getStats: () => request<SessionStats>('/sessions/stats/overview'),
  getGroups: (id: string) =>
    request<{ id: string; name?: string; linkedParentJID?: string | null }[]>(`/sessions/${enc(id)}/groups`),
  // Operator route, Baileys only: whatsapp-web.js answers 501. Participants are WhatsApp ids (`…@c.us`).
  createGroup: (id: string, name: string, participants: string[]) =>
    request<{ id: string; name: string }>(`/sessions/${enc(id)}/groups`, {
      method: 'POST',
      body: JSON.stringify({ name, participants }),
    }),
  getGroup: (id: string, groupId: string) => request<GroupInfo>(`/sessions/${enc(id)}/groups/${enc(groupId)}`),
  // The group writes below are operator routes. Whether WhatsApp lets this account make them (an admin,
  // or any member while the group's info is unlocked) is decided by WhatsApp; a refusal answers 403.
  setGroupSubject: (id: string, groupId: string, subject: string) =>
    request<GroupAck>(`/sessions/${enc(id)}/groups/${enc(groupId)}/subject`, {
      method: 'PUT',
      body: JSON.stringify({ subject }),
    }),
  setGroupDescription: (id: string, groupId: string, description: string) =>
    request<GroupAck>(`/sessions/${enc(id)}/groups/${enc(groupId)}/description`, {
      method: 'PUT',
      body: JSON.stringify({ description }),
    }),
  setGroupPicture: (id: string, groupId: string, base64: string, mimetype: string) =>
    request<GroupAck>(`/sessions/${enc(id)}/groups/${enc(groupId)}/picture`, {
      method: 'PUT',
      body: JSON.stringify({ base64, mimetype }),
    }),
  addGroupParticipants: (id: string, groupId: string, participants: string[]) =>
    request<GroupParticipantsAck>(`/sessions/${enc(id)}/groups/${enc(groupId)}/participants`, {
      method: 'POST',
      body: JSON.stringify({ participants }),
    }),
  removeGroupParticipants: (id: string, groupId: string, participants: string[]) =>
    request<GroupParticipantsAck>(`/sessions/${enc(id)}/groups/${enc(groupId)}/participants`, {
      method: 'DELETE',
      body: JSON.stringify({ participants }),
    }),
  setGroupAdmins: (id: string, groupId: string, participants: string[], admin: boolean) =>
    request<GroupParticipantsAck>(
      `/sessions/${enc(id)}/groups/${enc(groupId)}/participants/${admin ? 'promote' : 'demote'}`,
      { method: 'POST', body: JSON.stringify({ participants }) },
    ),
  leaveGroup: (id: string, groupId: string) =>
    request<GroupAck>(`/sessions/${enc(id)}/groups/${enc(groupId)}/leave`, { method: 'POST' }),
  getChats: async (id: string, signal?: AbortSignal) => {
    let lastError: unknown;
    const { items, throttled } = await fetchAllPages<Chat>(
      async (limit, offset) => {
        signal?.throwIfAborted();
        try {
          const data = await request<Chat[]>(`/sessions/${enc(id)}/chats?limit=${limit}&offset=${offset}`, { signal });
          return { data, total: data.length < limit ? offset + data.length : Infinity };
        } catch (err) {
          lastError = err;
          throw err;
        } finally {
          signal?.throwIfAborted();
        }
      },
      { pageSize: 1000, maxItems: MAX_PAGINATED_LIST_ITEMS },
    );
    // A later throttled page must fail the load rather than present an incomplete sidebar.
    if (throttled) throw lastError;
    const seen = new Set<string>();
    return items.filter(chat => {
      if (seen.has(chat.id)) return false;
      seen.add(chat.id);
      return true;
    });
  },
  // `messageIds` are the messages to acknowledge. Baileys acknowledges them one by one and, without any, only the
  // newest it holds; whatsapp-web.js reads the whole chat and ignores them.
  markChatRead: (id: string, chatId: string, messageIds?: string[]) =>
    request<{ success: boolean }>(`/sessions/${enc(id)}/chats/read`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...(messageIds?.length ? { messageIds } : {}) }),
    }),
  // Both also delete the gateway's stored copy of the chat's messages (rows, media, search entries).
  clearChatMessages: (id: string, chatId: string) =>
    request<{ success: boolean }>(`/sessions/${enc(id)}/chats/${enc(chatId)}/messages`, {
      method: 'DELETE',
    }),
  deleteChat: (id: string, chatId: string) =>
    request<{ success: boolean }>(`/sessions/${enc(id)}/chats/delete`, {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    }),
  // Archive and pin answer `{ success: false }` when the engine declined to act (WhatsApp keeps at most three
  // chats pinned), which the callers treat as a failure. Mute has no declined outcome and always answers success.
  archiveChat: (id: string, chatId: string, archive: boolean) =>
    request<{ success: boolean }>(`/sessions/${enc(id)}/chats/archive`, {
      method: 'POST',
      body: JSON.stringify({ chatId, archive }),
    }),
  pinChat: (id: string, chatId: string, pin: boolean) =>
    request<{ success: boolean }>(`/sessions/${enc(id)}/chats/pin`, {
      method: 'POST',
      body: JSON.stringify({ chatId, pin }),
    }),
  /** `muteUntil` is epoch MILLISECONDS; null unmutes. */
  muteChat: (id: string, chatId: string, muteUntil: number | null) =>
    request<{ success: boolean }>(`/sessions/${enc(id)}/chats/mute`, {
      method: 'POST',
      body: JSON.stringify({ chatId, muteUntil }),
    }),
  markChatUnread: (id: string, chatId: string) =>
    request<{ success: boolean }>(`/sessions/${enc(id)}/chats/unread`, {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    }),
  // `offset` counts DB rows already fetched for this chat, never rendered rows: the thread merges
  // these with engine history, so paging by the merged length would skip DB rows. `total` is not
  // read to decide whether an older page exists: a page short of `limit` is; a chat with live
  // traffic keeps growing `total` after the fact, so comparing rows-held against it stops early.
  getChatMessages: (id: string, chatId: string, limit = 100, offset = 0) =>
    request<{ messages: ChatMessage[]; total: number }>(
      `/sessions/${enc(id)}/messages?chatId=${enc(chatId)}&limit=${limit}&offset=${offset}`,
    ),
  // Live history straight from WhatsApp (bypasses the DB): backfills a thread the gateway never
  // captured, e.g. a freshly paired session whose persisted store is still empty.
  // includeMedia downloads the media payload (base64) for history messages so stickers/images/
  // video/voice render instead of collapsing to an empty timestamp-only bubble.
  getChatHistory: (id: string, chatId: string, limit = 100, includeMedia = false) =>
    request<EngineHistoryMessage[]>(
      `/sessions/${enc(id)}/messages/${enc(chatId)}/history?limit=${limit}${includeMedia ? '&includeMedia=true' : ''}`,
    ),
  // A message's stored media, fetched on demand. The message list carries its media inline only up to
  // MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES; past that budget the payload arrives as the
  // `{ omitted: true, sizeBytes }` marker and the bytes are only reachable here. Served as an
  // attachment (Content-Disposition), so callers download it rather than rendering it inline.
  getMessageMediaBlob: (id: string, chatId: string, messageId: string, signal?: AbortSignal) =>
    requestBlob(`/sessions/${enc(id)}/messages/${enc(chatId)}/${enc(messageId)}/media`, signal),
  getSubscribedChannels: (id: string) => request<Channel[]>(`/sessions/${enc(id)}/channels`),
  getChannelMessages: (id: string, channelId: string, limit = 50) =>
    request<ChannelMessage[]>(`/sessions/${enc(id)}/channels/${enc(channelId)}/messages?limit=${limit}`),
  getContactStatuses: (id: string) => request<{ statuses: StatusUpdate[] }>(`/sessions/${enc(id)}/status`),
  getStatusMediaBlob: (id: string, statusId: string, signal?: AbortSignal) =>
    requestBlob(`/sessions/${enc(id)}/status/${enc(statusId)}/media`, signal),
  postTextStatus: (
    id: string,
    text: string,
    recipients?: string[],
    extra?: { backgroundColor?: string; font?: number },
  ) =>
    request(`/sessions/${enc(id)}/status/send-text`, {
      method: 'POST',
      body: JSON.stringify({ text, recipients, ...extra }),
    }),
  postImageStatus: (
    id: string,
    image: { url?: string; base64?: string; mimetype?: string },
    recipients?: string[],
    caption?: string,
  ) =>
    request(`/sessions/${enc(id)}/status/send-image`, {
      method: 'POST',
      body: JSON.stringify({ image, recipients, caption }),
    }),
};

// =============================================================================
// Webhook API
// =============================================================================

export const webhookApi = {
  listBySession: (sessionId: string) => request<Webhook[]>(`/sessions/${enc(sessionId)}/webhooks`),
  listAll: () => request<Webhook[]>('/webhooks'),
  create: (sessionId: string, data: CreateWebhookRequest) =>
    request<Webhook>(`/sessions/${enc(sessionId)}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: UpdateWebhookRequest) =>
    request<Webhook>(`/sessions/${enc(sessionId)}/webhooks/${enc(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${enc(sessionId)}/webhooks/${enc(id)}`, { method: 'DELETE' }),
  test: (sessionId: string, id: string) =>
    request<{ success: boolean; statusCode?: number; error?: string }>(
      `/sessions/${enc(sessionId)}/webhooks/${enc(id)}/test`,
      {
        method: 'POST',
      },
    ),
};

// =============================================================================
// Template API
// =============================================================================

export const templateApi = {
  list: (sessionId: string) => request<MessageTemplate[]>(`/sessions/${enc(sessionId)}/templates`),
  create: (sessionId: string, data: TemplatePayload) =>
    request<MessageTemplate>(`/sessions/${enc(sessionId)}/templates`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<TemplatePayload>) =>
    request<MessageTemplate>(`/sessions/${enc(sessionId)}/templates/${enc(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${enc(sessionId)}/templates/${enc(id)}`, { method: 'DELETE' }),
};

// =============================================================================
// Contact API
// =============================================================================

export interface CheckNumberResponse {
  number: string;
  exists: boolean;
  /** The number's WhatsApp id in the neutral `<phone>@c.us` form on both engines, or null if unregistered. */
  whatsappId: string | null;
}

export interface ProfilePictureResponse {
  /** Signed CDN URL for the contact/group picture, or null when hidden / unavailable. */
  url: string | null;
}

export const contactApi = {
  // The route caps a response at 1000 contacts; walk the pages so an address book past that is complete,
  // stopping at MAX_PAGINATED_LIST_ITEMS if the server never returns a short page.
  list: async (sessionId: string) => {
    let lastError: unknown;
    const { items, throttled } = await fetchAllPages(
      async (limit, offset) => {
        try {
          const data = await request<Contact[]>(`/sessions/${enc(sessionId)}/contacts?limit=${limit}&offset=${offset}`);
          // The route answers a bare array with no total: a short page is the last one.
          return { data, total: data.length < limit ? offset + data.length : Infinity };
        } catch (err) {
          lastError = err;
          throw err;
        }
      },
      { pageSize: 1000, maxItems: MAX_PAGINATED_LIST_ITEMS },
    );
    // A page still throttled after the retries would leave the picker silently short; fail the whole
    // load with that page's 429, as a throttled first page already does.
    if (throttled) throw lastError;
    return items;
  },
  /** The ids of the contacts this account has blocked. */
  listBlocked: (sessionId: string) => request<string[]>(`/sessions/${enc(sessionId)}/contacts/blocked`),
  block: (sessionId: string, contactId: string) =>
    request<{ success: boolean }>(`/sessions/${enc(sessionId)}/contacts/${enc(contactId)}/block`, {
      method: 'POST',
    }),
  unblock: (sessionId: string, contactId: string) =>
    request<{ success: boolean }>(`/sessions/${enc(sessionId)}/contacts/${enc(contactId)}/block`, {
      method: 'DELETE',
    }),
  /** Save the contact to the account's address book, or rename the entry it has. */
  upsert: (sessionId: string, contactId: string, firstName: string, lastName?: string) =>
    request<{ success: boolean }>(`/sessions/${enc(sessionId)}/contacts/${enc(contactId)}`, {
      method: 'PUT',
      body: JSON.stringify({ firstName, ...(lastName ? { lastName } : {}) }),
    }),
  checkNumber: (sessionId: string, number: string) =>
    request<CheckNumberResponse>(`/sessions/${enc(sessionId)}/contacts/check/${enc(number)}`),
  // Returns the contact/group profile picture URL. Both engines return null when the user hid their
  // picture or has none. The URL is a signed WhatsApp CDN link that expires in a few hours, so the
  // dashboard caches it for an hour (see useProfilePicture) and re-fetches on expiry.
  profilePicture: (sessionId: string, contactId: string) =>
    request<ProfilePictureResponse>(`/sessions/${enc(sessionId)}/contacts/${enc(contactId)}/profile-picture`),
  // Best-effort resolution of a contact id (e.g. an @lid privacy id) to its phone number (MSISDN
  // digits), or null when the engine can't map it. Cached a day by useResolvedPhone.
  resolvePhone: (sessionId: string, contactId: string) =>
    request<{ contactId: string; phone: string | null }>(
      `/sessions/${enc(sessionId)}/contacts/${enc(contactId)}/phone`,
    ),
  // Batch-resolve profile picture URLs for a whole sidebar in ONE request: the per-chat burst of
  // parallel single fetches exhausts the per-IP throttle (429s). Engine lookups run 5 at a time
  // server-side; ids beyond the backend's 50-id cap are dropped client-side too.
  profilePictures: (sessionId: string, contactIds: string[]) =>
    request<{ pictures: Record<string, string | null> }>(
      `/sessions/${enc(sessionId)}/contacts/profile-pictures?ids=${contactIds.slice(0, 50).map(enc).join(',')}`,
    ),
};

// =============================================================================
// API Key API
// =============================================================================

export const apiKeyApi = {
  list: () => request<ApiKey[]>('/auth/api-keys'),
  create: (data: {
    name: string;
    role: string;
    allowedIps?: string[];
    allowedSessions?: string[];
    expiresAt?: string;
    allowedChats?: string[];
    deniedPermissions?: ApiKeyCapability[];
  }) =>
    request<CreatedApiKey>('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      name?: string;
      role?: string;
      allowedIps?: string[];
      allowedSessions?: string[];
      /** null removes the expiry. */
      expiresAt?: string | null;
      allowedChats?: string[];
      deniedPermissions?: ApiKeyCapability[];
    },
  ) =>
    request<ApiKey>(`/auth/api-keys/${enc(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/auth/api-keys/${enc(id)}`, { method: 'DELETE' }),
  revoke: (id: string) => request<ApiKey>(`/auth/api-keys/${enc(id)}/revoke`, { method: 'POST' }),
};

// =============================================================================
// Audit/Logs API
// =============================================================================

export const auditApi = {
  list: (params?: { action?: string; severity?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.action) query.set('action', params.action);
    if (params?.severity) query.set('severity', params.severity);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const queryStr = query.toString();
    return request<{ data: AuditLog[]; total: number }>(`/audit${queryStr ? `?${queryStr}` : ''}`);
  },
};

// =============================================================================
// Message API
// =============================================================================

export const messageApi = {
  sendText: (sessionId: string, chatId: string, text: string) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/send-text`, {
      method: 'POST',
      body: JSON.stringify({ chatId, text }),
    }),
  sendMedia: (
    sessionId: string,
    chatId: string,
    mediaType: 'image' | 'video' | 'audio' | 'document',
    payload: SendMediaPayload,
  ) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/send-${enc(mediaType)}`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...payload }),
    }),
  sendLocation: (sessionId: string, data: SendLocationPayload) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/send-location`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sendContact: (sessionId: string, data: SendContactPayload) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/send-contact`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Stickers take the same media body as the other send-* endpoints (base64 XOR url + mimetype).
  sendSticker: (sessionId: string, chatId: string, payload: SendMediaPayload) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/send-sticker`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...payload }),
    }),
  sendPoll: (sessionId: string, data: SendPollPayload) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/send-poll`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  forward: (sessionId: string, data: ForwardMessagePayload) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/forward`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Async batch: returns 202 immediately; poll getBatchStatus until a terminal status.
  sendBulk: (sessionId: string, data: SendBulkPayload) =>
    request<BulkBatchResponse>(`/sessions/${enc(sessionId)}/messages/send-bulk`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getBatchStatus: (sessionId: string, batchId: string) =>
    request<BatchStatusResponse>(`/sessions/${enc(sessionId)}/messages/batch/${enc(batchId)}`),
  cancelBatch: (sessionId: string, batchId: string) =>
    request<BatchCancelResponse>(`/sessions/${enc(sessionId)}/messages/batch/${enc(batchId)}/cancel`, {
      method: 'POST',
    }),
  reply: (sessionId: string, data: { chatId: string; quotedMessageId: string; text: string }) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/reply`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  /**
   * Tap a choice on an inbound business button/list prompt (Baileys only).
   * `messageId` is the prompt's WhatsApp id; `buttonId` is `buttons[].id`.
   */
  clickButton: (sessionId: string, data: { chatId: string; messageId: string; buttonId: string; text?: string }) =>
    request<MessageResponse>(`/sessions/${enc(sessionId)}/messages/click-button`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  react: (sessionId: string, data: { chatId: string; messageId: string; emoji: string }) =>
    request<void>(`/sessions/${enc(sessionId)}/messages/react`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, data: { chatId: string; messageId: string; forEveryone?: boolean }) =>
    request<void>(`/sessions/${enc(sessionId)}/messages/delete`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};

// =============================================================================
// Search API
// =============================================================================

export const searchApi = {
  search: (params: SearchParams) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') query.set(key, String(value));
    });
    return request<SearchResults>(`/search?${query.toString()}`);
  },
};

// =============================================================================
// Health & Infrastructure API
// =============================================================================

export const healthApi = {
  check: () => request<HealthStatus>('/health'),
};

export const infraApi = {
  getStatus: () => request<InfraStatus>('/infra/status'),
  getUpdateCheck: () => request<UpdateCheck>('/infra/update-check'),
  getConfig: () => request<SavedConfig>('/infra/config'),
  saveConfig: (config: SaveConfigPayload) =>
    request<{ message: string; saved: boolean; envPath: string; profiles: string[] }>('/infra/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  restart: (profiles?: string[], profilesToRemove?: string[], signal?: AbortSignal) =>
    request<{
      message: string;
      restarting: boolean;
      profiles: string[];
      profilesToRemove: string[];
      estimatedTime: number;
      // Present only when Docker started or stopped built-in services; `errors` lists what failed.
      orchestration?: { errors?: string[] };
      removal?: { errors?: string[] };
    }>('/infra/restart', {
      method: 'POST',
      body: JSON.stringify({ profiles: profiles || [], profilesToRemove: profilesToRemove || [] }),
      signal,
    }),
  // Readiness, not the plain /infra/health ping. The restart poll must not be able to latch onto the
  // process it just asked to shut down: /infra/health answers 200 for the whole drain,
  // while /health/ready reports 503 as soon as draining starts and stays 503 until both databases
  // answer. Public (no API key), like /infra/health.
  healthCheck: (signal?: AbortSignal) =>
    request<{ status: 'ok' | 'error'; details: Record<string, { status: string }> }>('/health/ready', { signal }),
  // Data migration: export all Data-DB tables (call while still on the OLD database, before switching),
  // then import after the switch + restart. Used by the DB-switch migration guard so data isn't lost.
  // The body is the backup file itself and is handed over unparsed, since it can run to hundreds of
  // megabytes. Its first member is `exportedAt` and its last is `omittedInlineMedia`, the inline
  // media payloads the export budget refused: non-zero means the rows are all there but some of
  // their media is not, a state a restored archive cannot express, since the omitted marker is the
  // same one media skipped on the way in gets.
  exportData: (includePluginSecrets = false) =>
    requestBlob(includePluginSecrets ? '/infra/export-data?includePluginSecrets=true' : '/infra/export-data'),
  // 200 contract includes the orphan-engine reconciliation result (restartRequired / notices /
  // stopped+failed ids). 409 has several causes and the error's `code` distinguishes them:
  // IMPORT_WOULD_ORPHAN_ENGINES (live engines exist for sessions the backup would remove; the
  // message lists them) is the only one the caller retries with stopOrphans=true to stop those
  // engines inside the request. IMPORT_ALREADY_RUNNING (another restore is in flight) and
  // IMPORT_NESTED_TRANSACTION (another transaction holds the connection) leave nothing to retry.
  // 503 IMPORT_STOPPED: the gateway stopped during a SQLite restore and rolled it back.
  // force is deliberately NOT exposed: it leaves the engines writing into the restored tables until
  // a restart — the window stopOrphans exists to close.
  importData: (tables: Record<string, unknown[]>, options?: { stopOrphans?: boolean }) =>
    request<{
      imported: boolean;
      counts?: Record<string, number>;
      message?: string;
      warnings?: string[];
      notices?: string[];
      restartRequired?: boolean;
      orphanedEngines?: string[];
      stoppedOrphanEngines?: string[];
      failedOrphanEngines?: string[];
    }>('/infra/import-data', {
      method: 'POST',
      body: JSON.stringify({ tables, ...options }),
    }),
};

// =============================================================================
// Plugin Types
// =============================================================================

/** Field definition within a plugin's config schema (mirrors the backend PluginConfigField). */
export interface PluginConfigField {
  // 'textarea' is a multi-line string; a field with `enum` renders as a <select>.
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'textarea';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  required?: boolean;
  secret?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  items?: PluginConfigField; // array element schema; array-of-rows when items.type === 'object'
  properties?: Record<string, PluginConfigField>; // nested-object fields
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigField>;
}

export interface PluginI18nText {
  title?: string;
  description?: string;
}
export interface PluginI18nLocale {
  name?: string;
  description?: string;
  config?: Record<string, PluginI18nText>;
}
export type PluginI18n = Record<string, PluginI18nLocale>;

export interface Plugin {
  id: string;
  name: string;
  version: string;
  type: 'engine' | 'storage' | 'queue' | 'auth' | 'extension';
  description?: string;
  author?: string;
  status: 'installed' | 'enabled' | 'disabled' | 'error';
  config: Record<string, unknown>;
  builtIn: boolean;
  provides: string[];
  /** Whether this plugin can host provisioned ingress instances (drives the Instances tab). */
  ingressCapable: boolean;
  /** Declared config fields, when the plugin exposes a schema (drives the dashboard config form). */
  configSchema?: PluginConfigSchema;
  /** When set, the plugin ships a sandboxed-iframe config editor (preferred over configSchema). */
  configUi?: { entry: string; height?: number };
  /** Whether the plugin is scoped to specific sessions (false = global, always runs). */
  sessionScoped: boolean;
  /** Sessions the plugin is activated for; ['*'] = all numbers. */
  activeSessions: string[];
  /** Per-session config overrides, keyed by sessionId (secrets redacted per slice). */
  sessionConfig?: Record<string, Record<string, unknown>>;
  loadedAt?: string;
  enabledAt?: string;
  error?: string;
  i18n?: PluginI18n;
}

export interface Engine {
  id: string;
  name: string;
  enabled: boolean;
  features: string[];
  /** Underlying engine library (e.g. whatsapp-web.js 1.34.7), distinct from the adapter version. */
  library?: { name: string; version: string };
}

/** A remote catalog entry annotated with this instance's install state. */
export interface CatalogPlugin {
  id: string;
  name: string;
  version: string;
  type?: string;
  status?: string;
  description?: string;
  author?: string;
  license?: string;
  keywords?: string[];
  minOpenWAVersion?: string;
  testedOpenWAVersion?: string;
  homepage?: string;
  download?: string;
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
  i18n?: PluginI18n;
}

// =============================================================================
// Plugins API
// =============================================================================

export const pluginsApi = {
  list: () => request<Plugin[]>('/plugins'),
  get: (id: string) => request<Plugin>(`/plugins/${enc(id)}`),
  enable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${enc(id)}/enable`, {
      method: 'POST',
    }),
  disable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${enc(id)}/disable`, {
      method: 'POST',
    }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    request<{ success: boolean; message: string }>(`/plugins/${enc(id)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  /** Set which sessions a session-scoped plugin is activated for (['*'] = all). */
  setSessions: (id: string, sessions: string[]) =>
    request<Plugin>(`/plugins/${enc(id)}/sessions`, { method: 'PUT', body: JSON.stringify({ sessions }) }),
  /** Set (or clear, with an empty object) a plugin's config override for one session. */
  updateSessionConfig: (id: string, sessionId: string, config: Record<string, unknown>) =>
    request<{ success: boolean; message: string }>(`/plugins/${enc(id)}/config/${enc(sessionId)}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  healthCheck: (id: string) => request<{ healthy: boolean; message?: string }>(`/plugins/${enc(id)}/health`),
  install: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Plugin>('/plugins/install', { method: 'POST', body: form });
  },
  installFromUrl: (url: string) =>
    request<Plugin>('/plugins/install-url', { method: 'POST', body: JSON.stringify({ url }) }),
  updateFromUrl: (id: string, url: string) =>
    request<Plugin>(`/plugins/${enc(id)}/update`, { method: 'POST', body: JSON.stringify({ url }) }),
  catalog: () => request<CatalogPlugin[]>('/plugins/catalog'),
  /** Fetch a plugin's sandboxed config-UI entry HTML (the API key stays here, in the parent). */
  getConfigUi: (id: string) => requestText(`/plugins/${enc(id)}/config-ui`),
  uninstall: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${enc(id)}`, { method: 'DELETE' }),
  getEngines: () => request<Engine[]>('/infra/engines'),
  getCurrentEngine: () => request<{ engineType: string }>('/infra/engines/current'),
};

// =============================================================================
// Plugin instances API (Integration Fabric provisioning; mirrors src/modules/integration)
// =============================================================================

export interface IngressUrl {
  route: string;
  url: string;
}

export interface InstanceView {
  id: string;
  pluginId: string;
  instanceId: string;
  sessionScope: string | null;
  secret: string; // '***' on reads; plaintext once on create/regenerate
  verifyToken: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  ingressUrls: IngressUrl[];
}

export type MintedInstance = InstanceView; // same shape; `secret` carries the plaintext once

export interface CreateInstanceInput {
  instanceId: string;
  sessionScope?: string;
  verifyToken?: string;
  /** Provider-fixed webhook secret (e.g. Chatwoot's). Omit to auto-generate one (shown once). */
  secret?: string;
  config?: Record<string, unknown>;
}

export interface UpdateInstanceInput {
  enabled?: boolean;
  /** null resets a scoped instance to all sessions; omit to leave the scope unchanged. */
  sessionScope?: string | null;
  config?: Record<string, unknown>;
}

export const pluginInstancesApi = {
  list: (pluginId: string) => request<InstanceView[]>(`/integration/plugins/${enc(pluginId)}/instances`),
  create: (pluginId: string, body: CreateInstanceInput) =>
    request<MintedInstance>(`/integration/plugins/${enc(pluginId)}/instances`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  regenerateSecret: (pluginId: string, instanceId: string) =>
    request<MintedInstance>(`/integration/plugins/${enc(pluginId)}/instances/${enc(instanceId)}/regenerate-secret`, {
      method: 'POST',
    }),
  update: (pluginId: string, instanceId: string, body: UpdateInstanceInput) =>
    request<InstanceView>(`/integration/plugins/${enc(pluginId)}/instances/${enc(instanceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (pluginId: string, instanceId: string) =>
    request<void>(`/integration/plugins/${enc(pluginId)}/instances/${enc(instanceId)}`, { method: 'DELETE' }),
};

// =============================================================================
// Statistics API (mirrors src/modules/stats)
// =============================================================================

export type StatsPeriod = '24h' | '7d' | '30d';

export interface OverviewStats {
  sessions: { active: number; total: number; byStatus: Record<string, number> };
  messages: { sent: number; received: number; failed: number; today: { sent: number; received: number } };
}

export interface MessageTimeSeriesPoint {
  timestamp: string;
  sent: number;
  received: number;
}

export interface MessageStats {
  timeSeries: MessageTimeSeriesPoint[];
  byType: Record<string, number>;
  bySession: Array<{ sessionId: string; name: string; sent: number; received: number }>;
  topChats: Array<{ chatId: string; chatName?: string | null; messageCount: number }>;
}

export const statsApi = {
  getOverview: () => request<OverviewStats>('/stats/overview'),
  getMessages: (period: StatsPeriod) => request<MessageStats>(`/stats/messages?period=${enc(period)}`),
};
