// API Service Layer for OpenWA Dashboard
// Centralized API client with TypeScript types

import { warnIfInsecureHttpUrl } from '../utils/urlSecurity';

// Resolve the API base URL. By default this is the same-origin relative path '/api',
// correct when the dashboard and API are served from the same origin (the default
// single-container setup). For a split-origin deployment (dashboard hosted separately
// from the API), set VITE_API_URL at build time to the API ORIGIN — e.g.
// `VITE_API_URL=https://gateway.example.com` — and the '/api' prefix is appended here.
// Previously VITE_API_URL was documented but never read, so the dashboard always called
// same-origin '/api' and a split deployment failed with "Invalid API Key" (#91).
// Exported so direct fetches (e.g. auth/validate in Login.tsx / App.tsx) honor VITE_API_URL
// too — otherwise split-origin deployments break. Empty VITE_API_URL → '/api'.
const API_ORIGIN = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
export const API_BASE_URL = `${API_ORIGIN}/api`;
// Warn (not refuse — would break dev + TLS-terminating-proxy) when the API origin is an
// insecure http:// URL pointing at a non-localhost host (API keys sent in cleartext).
if (API_ORIGIN) warnIfInsecureHttpUrl(API_ORIGIN, 'VITE_API_URL');

// =============================================================================
// Types
// =============================================================================

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
   * Optional only because a dashboard can be served by a gateway that predates the field.
   */
  engineLoaded?: boolean;
  phone?: string | null;
  pushName?: string | null;
  lastActive?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Human-readable reason carried while the status is 'failed' (terminal failure) or
   * 'action_required' (operator must intervene, e.g. acknowledge an onboarding modal). */
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
 * and `proxy_block` refuse the connection itself and so cannot.
 */
export interface AccountRestriction {
  kind: 'reachout_timelock' | 'tos_block' | 'proxy_block';
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
  memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
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
  secret?: string;
  createdAt: string;
  updatedAt: string;
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

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  role: 'admin' | 'operator' | 'viewer';
  allowedIps?: string[];
  allowedSessions?: string[];
  isActive: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  usageCount: number;
  createdAt: string;
  apiKey?: string; // Only returned on creation
}

export interface AuditLog {
  id: string;
  action: string;
  severity: 'info' | 'warn' | 'error';
  apiKeyId?: string;
  apiKeyName?: string;
  sessionId?: string;
  sessionName?: string;
  ipAddress?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  errorMessage?: string;
  createdAt: string;
}

export interface MessageResponse {
  messageId: string;
  timestamp: number;
}

// Mirrors the backend engine ChatKind (dashboard cannot import wa-id.ts).
export type ChatKind = 'individual' | 'group' | 'channel' | 'status' | 'broadcast' | 'unknown';

// Chat summary returned by GET /sessions/:id/chats (mirrors the backend ChatSummary).
export interface Chat {
  id: string;
  name: string;
  isGroup: boolean;
  kind: ChatKind;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
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
  metadata?: {
    media?: { mimetype: string; filename?: string; data?: string; omitted?: boolean; sizeBytes?: number };
    quotedMessage?: { id: string; body: string };
    reactions?: Record<string, string>;
    call?: { video: boolean; missed: boolean };
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
  type: string;
  timestamp: number;
  fromMe?: boolean;
  media?: { mimetype: string; filename?: string; data?: string };
  /** Sender in a group: `from` is the group JID, so this participant WID is the real poster. */
  author?: string;
  /** Best-effort sender contact (sync cache); its name labels the poster in a group thread. */
  contact?: { id?: string; name?: string; pushName?: string };
}

// Mirrors the backend engine Channel / ChannelMessage (GET /sessions/:id/channels[/:id/messages]).
export interface Channel {
  id: string;
  name: string;
  subscriberCount?: number;
  inviteCode?: string;
  verified?: boolean;
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

// Minimal contact type for the recipient picker; the backend GET /sessions/:id/contacts
// returns a Contact array; fields beyond id are optional.
export interface Contact {
  id: string;
  name?: string;
  pushName?: string;
  number?: string;
}

export interface SendMediaPayload {
  base64?: string;
  url?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
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

/** GET batch/:batchId shape; the cancel endpoint returns the same minus results/timestamps. */
export interface BatchStatusResponse {
  batchId: string;
  status: BatchStatus;
  progress: BatchProgress;
  results?: BatchMessageResult[];
  startedAt?: string;
  completedAt?: string;
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

export interface InfraStatus {
  // `builtIn` = OpenWA's own bundled container is actually running and backing this service (live),
  // not just the saved intent — falls back to the saved flag when Docker is unavailable. (#488)
  database: { connected: boolean; type: string; host: string; builtIn: boolean };
  redis: { enabled: boolean; connected: boolean; host: string; port: number; builtIn: boolean };
  queue: {
    enabled: boolean;
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: { type: 'local' | 's3'; path?: string; bucket?: string; builtIn: boolean; s3Available?: boolean };
  engine: {
    type: string;
    headless: boolean;
    // whatsapp-web.js only: the actual WhatsApp Web build in use (distinct from the library version)
    // and how it was chosen. (#488)
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
  redis: { enabled: boolean; builtIn: boolean; host: string; port: string; passwordSet: boolean };
  queue: { enabled: boolean };
  storage: {
    type: 'local' | 's3';
    builtIn: boolean;
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
    type: 'sqlite' | 'postgres';
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
    type: 'local' | 's3';
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

export interface Settings {
  general: { apiBaseUrl: string; autoReconnect: boolean; debugMode: boolean };
  api: { rateLimit: number; rateLimitWindow: number; enableDocs: boolean };
  notifications: { emailEnabled: boolean; notificationEmail: string; webhookAlerts: boolean };
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
  direction: string;
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

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Get API key from sessionStorage for authentication
  const apiKey = sessionStorage.getItem('openwa_api_key');

  // For FormData (file uploads) let the browser set multipart/form-data + boundary itself.
  const isFormData = options.body instanceof FormData;
  const headers: HeadersInit = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    // The stored API key is invalid/expired/revoked — clear it and return to login
    // so the user isn't stuck on a dashboard that 401s every request.
    sessionStorage.removeItem('openwa_api_key');
    if (typeof window !== 'undefined') {
      window.location.assign('/');
      // The page is navigating away — halt this request's promise chain so callers neither
      // throw the generic error below (flashing a toast) nor receive an undefined payload.
      return new Promise<T>(() => {});
    }
  }

  if (!response.ok) {
    // On a non-JSON body (e.g. a reverse-proxy 502/503 HTML page) fall through to `HTTP <status>`
    // rather than statusText: the status code is what the toast connection-lost de-dup matches on,
    // and statusText is empty over HTTP/2 anyway.
    const error = await response.json().catch(() => ({}));
    // Carry the HTTP status on the Error (message unchanged, so the toast de-dup still matches) so
    // callers can tell apart a permission 403 from a real server 5xx instead of guessing from text.
    // Carry the machine `code` too: the gateway's stable codes (SESSION_LOGOUT_INCOMPLETE,
    // SESSION_NAME_TEARDOWN_PENDING, …) drive specific recovery UI, and a reverse-proxy 502 that
    // never reached the gateway carries no code at all — that distinction is exactly what the unlink
    // classifier keys on instead of fragile message heuristics.
    const err = new Error(error.message || `HTTP ${response.status}`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = response.status;
    if (typeof error.code === 'string') err.code = error.code;
    throw err;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

/** Like {@link request} but returns the raw response text — e.g. a plugin's HTML config-UI bundle. */
async function requestText(endpoint: string): Promise<string> {
  const apiKey = sessionStorage.getItem('openwa_api_key');
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    headers: { ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
  });

  if (response.status === 401) {
    sessionStorage.removeItem('openwa_api_key');
    if (typeof window !== 'undefined') {
      window.location.assign('/');
      return new Promise<string>(() => {});
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.text();
}

/** Like {@link request} but returns a Blob — e.g. for status media downloads. */
async function requestBlob(endpoint: string): Promise<Blob> {
  const url = `${API_BASE_URL}${endpoint}`;

  // Get API key from sessionStorage for authentication
  const apiKey = sessionStorage.getItem('openwa_api_key');

  const headers: HeadersInit = {
    ...(apiKey ? { 'X-API-Key': apiKey } : {}),
  };

  const response = await fetch(url, { headers });

  if (response.status === 401) {
    // The stored API key is invalid/expired/revoked — clear it and return to login
    sessionStorage.removeItem('openwa_api_key');
    if (typeof window !== 'undefined') {
      window.location.assign('/');
      // Halt this request's promise chain so callers neither throw nor receive an undefined payload.
      return new Promise<Blob>(() => {});
    }
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const err = new Error(error.message || `HTTP ${response.status}`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  return response.blob();
}

// =============================================================================
// Session API
// =============================================================================

export const sessionApi = {
  list: () => request<Session[]>('/sessions'),
  get: (id: string) => request<Session>(`/sessions/${id}`),
  create: (name: string) =>
    request<Session>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  delete: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  start: (id: string) => request<Session>(`/sessions/${id}/start`, { method: 'POST' }),
  stop: (id: string) => request<Session>(`/sessions/${id}/stop`, { method: 'POST' }),
  logout: (id: string) => request<Session>(`/sessions/${id}/logout`, { method: 'POST' }),
  forceKill: (id: string) => request<Session>(`/sessions/${id}/force-kill`, { method: 'POST' }),
  getQR: (id: string) => request<{ qrCode: string; status: string }>(`/sessions/${id}/qr`),
  requestPairingCode: (id: string, phoneNumber: string) =>
    request<{ pairingCode: string; status: string }>(`/sessions/${id}/pairing-code`, {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    }),
  getStats: () => request<SessionStats>('/sessions/stats/overview'),
  getGroups: (id: string) =>
    request<{ id: string; name: string; linkedParentJID?: string | null }[]>(`/sessions/${id}/groups`),
  getChats: (id: string) => request<Chat[]>(`/sessions/${id}/chats`),
  markChatRead: (id: string, chatId: string) =>
    request<{ success: boolean }>(`/sessions/${id}/chats/read`, {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    }),
  markChatUnread: (id: string, chatId: string) =>
    request<{ success: boolean }>(`/sessions/${id}/chats/unread`, {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    }),
  getChatMessages: (id: string, chatId: string, limit = 100) =>
    request<{ messages: ChatMessage[]; total: number }>(
      `/sessions/${id}/messages?chatId=${encodeURIComponent(chatId)}&limit=${limit}`,
    ),
  // Live history straight from WhatsApp (bypasses the DB) — backfills a thread the gateway never
  // captured, e.g. a freshly paired session whose persisted store is still empty.
  // includeMedia downloads the media payload (base64) for history messages so stickers/images/
  // video/voice render instead of collapsing to an empty timestamp-only bubble.
  getChatHistory: (id: string, chatId: string, limit = 100, includeMedia = false) =>
    request<EngineHistoryMessage[]>(
      `/sessions/${id}/messages/${encodeURIComponent(chatId)}/history?limit=${limit}${
        includeMedia ? '&includeMedia=true' : ''
      }`,
    ),
  getSubscribedChannels: (id: string) => request<Channel[]>(`/sessions/${id}/channels`),
  getChannelMessages: (id: string, channelId: string, limit = 50) =>
    request<ChannelMessage[]>(`/sessions/${id}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`),
  getContactStatuses: (id: string) => request<{ statuses: StatusUpdate[] }>(`/sessions/${id}/status`),
  getStatusMediaBlob: (id: string, statusId: string) =>
    requestBlob(`/sessions/${id}/status/${encodeURIComponent(statusId)}/media`),
  postTextStatus: (
    id: string,
    text: string,
    recipients?: string[],
    extra?: { backgroundColor?: string; font?: number },
  ) =>
    request(`/sessions/${id}/status/send-text`, {
      method: 'POST',
      body: JSON.stringify({ text, recipients, ...extra }),
    }),
  postImageStatus: (
    id: string,
    image: { url?: string; base64?: string; mimetype?: string },
    recipients?: string[],
    caption?: string,
  ) =>
    request(`/sessions/${id}/status/send-image`, {
      method: 'POST',
      body: JSON.stringify({ image, recipients, caption }),
    }),
};

// =============================================================================
// Webhook API
// =============================================================================

export const webhookApi = {
  listBySession: (sessionId: string) => request<Webhook[]>(`/sessions/${sessionId}/webhooks`),
  listAll: () => request<Webhook[]>('/webhooks'),
  get: (sessionId: string, id: string) => request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`),
  create: (sessionId: string, data: { url: string; events: string[]; filters?: WebhookFilters | null }) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<Webhook>) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/webhooks/${id}`, { method: 'DELETE' }),
  test: (sessionId: string, id: string) =>
    request<{ success: boolean; statusCode?: number; error?: string }>(`/sessions/${sessionId}/webhooks/${id}/test`, {
      method: 'POST',
    }),
};

// =============================================================================
// Template API
// =============================================================================

export const templateApi = {
  list: (sessionId: string) => request<MessageTemplate[]>(`/sessions/${sessionId}/templates`),
  get: (sessionId: string, id: string) => request<MessageTemplate>(`/sessions/${sessionId}/templates/${id}`),
  create: (sessionId: string, data: TemplatePayload) =>
    request<MessageTemplate>(`/sessions/${sessionId}/templates`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<TemplatePayload>) =>
    request<MessageTemplate>(`/sessions/${sessionId}/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/templates/${id}`, { method: 'DELETE' }),
};

// =============================================================================
// Contact API
// =============================================================================

export interface CheckNumberResponse {
  number: string;
  exists: boolean;
  /** Engine-canonical WhatsApp id for the number (e.g. `…@c.us` or `…@lid`), or null if unregistered. */
  whatsappId: string | null;
}

export interface ProfilePictureResponse {
  /** Signed CDN URL for the contact/group picture, or null when hidden / unavailable. */
  url: string | null;
}

export const contactApi = {
  list: (sessionId: string) => request<Contact[]>(`/sessions/${sessionId}/contacts`),
  checkNumber: (sessionId: string, number: string) =>
    request<CheckNumberResponse>(`/sessions/${sessionId}/contacts/check/${encodeURIComponent(number)}`),
  // Returns the contact/group profile picture URL. Both engines return null when the user hid their
  // picture or has none. The URL is a signed WhatsApp CDN link that expires in a few hours, so the
  // dashboard caches it for an hour (see useProfilePicture) and re-fetches on expiry.
  profilePicture: (sessionId: string, contactId: string) =>
    request<ProfilePictureResponse>(`/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/profile-picture`),
  // Best-effort resolution of a contact id (e.g. an @lid privacy id) to its phone number (MSISDN
  // digits), or null when the engine can't map it. Cached a day by useResolvedPhone.
  resolvePhone: (sessionId: string, contactId: string) =>
    request<{ contactId: string; phone: string | null }>(
      `/sessions/${sessionId}/contacts/${encodeURIComponent(contactId)}/phone`,
    ),
  // Batch-resolve profile picture URLs for a whole sidebar in ONE request — the per-chat burst of
  // parallel single fetches exhausts the per-IP throttle (429s). Engine lookups run 3 at a time
  // server-side; ids beyond the backend's 50-id cap are dropped client-side too.
  profilePictures: (sessionId: string, contactIds: string[]) =>
    request<{ pictures: Record<string, string | null> }>(
      `/sessions/${sessionId}/contacts/profile-pictures?ids=${contactIds
        .slice(0, 50)
        .map(encodeURIComponent)
        .join(',')}`,
    ),
};

// =============================================================================
// API Key API
// =============================================================================

export const apiKeyApi = {
  list: () => request<ApiKey[]>('/auth/api-keys'),
  get: (id: string) => request<ApiKey>(`/auth/api-keys/${id}`),
  create: (data: {
    name: string;
    role: string;
    allowedIps?: string[];
    allowedSessions?: string[];
    expiresAt?: string;
  }) =>
    request<ApiKey>('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<ApiKey>) =>
    request<ApiKey>(`/auth/api-keys/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/auth/api-keys/${id}`, { method: 'DELETE' }),
  revoke: (id: string) => request<ApiKey>(`/auth/api-keys/${id}/revoke`, { method: 'POST' }),
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
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-text`, {
      method: 'POST',
      body: JSON.stringify({ chatId, text }),
    }),
  sendImage: (sessionId: string, chatId: string, url: string, caption?: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-image`, {
      method: 'POST',
      body: JSON.stringify({ chatId, url, caption }),
    }),
  sendVideo: (sessionId: string, chatId: string, url: string, caption?: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-video`, {
      method: 'POST',
      body: JSON.stringify({ chatId, url, caption }),
    }),
  sendAudio: (sessionId: string, chatId: string, url: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-audio`, {
      method: 'POST',
      body: JSON.stringify({ chatId, url }),
    }),
  sendDocument: (sessionId: string, chatId: string, url: string, filename?: string) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-document`, {
      method: 'POST',
      body: JSON.stringify({ chatId, url, filename }),
    }),
  sendMedia: (
    sessionId: string,
    chatId: string,
    mediaType: 'image' | 'video' | 'audio' | 'document',
    payload: SendMediaPayload,
  ) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-${mediaType}`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...payload }),
    }),
  sendLocation: (sessionId: string, data: SendLocationPayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-location`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sendContact: (sessionId: string, data: SendContactPayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-contact`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Stickers take the same media body as the other send-* endpoints (base64 XOR url + mimetype).
  sendSticker: (sessionId: string, chatId: string, payload: SendMediaPayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-sticker`, {
      method: 'POST',
      body: JSON.stringify({ chatId, ...payload }),
    }),
  sendPoll: (sessionId: string, data: SendPollPayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-poll`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  forward: (sessionId: string, data: ForwardMessagePayload) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/forward`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  // Async batch: returns 202 immediately; poll getBatchStatus until a terminal status.
  sendBulk: (sessionId: string, data: SendBulkPayload) =>
    request<BulkBatchResponse>(`/sessions/${sessionId}/messages/send-bulk`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getBatchStatus: (sessionId: string, batchId: string) =>
    request<BatchStatusResponse>(`/sessions/${sessionId}/messages/batch/${encodeURIComponent(batchId)}`),
  cancelBatch: (sessionId: string, batchId: string) =>
    request<BatchStatusResponse>(`/sessions/${sessionId}/messages/batch/${encodeURIComponent(batchId)}/cancel`, {
      method: 'POST',
    }),
  reply: (sessionId: string, data: { chatId: string; quotedMessageId: string; text: string }) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/reply`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  react: (sessionId: string, data: { chatId: string; messageId: string; emoji: string }) =>
    request<void>(`/sessions/${sessionId}/messages/react`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sendTemplate: (
    sessionId: string,
    data: { chatId: string; templateId?: string; templateName?: string; variables?: Record<string, string> },
  ) =>
    request<MessageResponse>(`/sessions/${sessionId}/messages/send-template`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, data: { chatId: string; messageId: string; forEveryone?: boolean }) =>
    request<void>(`/sessions/${sessionId}/messages/delete`, {
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
  ready: () => request<HealthStatus>('/health/ready'),
};

export const infraApi = {
  getStatus: () => request<InfraStatus>('/infra/status'),
  getConfig: () => request<SavedConfig>('/infra/config'),
  updateConfig: (config: Partial<InfraStatus>) =>
    request<InfraStatus>('/infra/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  saveConfig: (config: SaveConfigPayload) =>
    request<{ message: string; saved: boolean; envPath: string; profiles: string[] }>('/infra/config', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  restart: (profiles?: string[], profilesToRemove?: string[]) =>
    request<{
      message: string;
      restarting: boolean;
      profiles: string[];
      profilesToRemove: string[];
      estimatedTime: number;
    }>('/infra/restart', {
      method: 'POST',
      body: JSON.stringify({ profiles: profiles || [], profilesToRemove: profilesToRemove || [] }),
    }),
  // Readiness, not the plain /infra/health ping. The restart poll must not be able to latch onto the
  // process it just asked to shut down: /infra/health answers 200 for the whole drain and teardown,
  // while /health/ready reports 503 as soon as draining starts and stays 503 until both databases
  // answer. Public (no API key), like /infra/health.
  healthCheck: () => request<{ status: 'ok' | 'error'; details: Record<string, { status: string }> }>('/health/ready'),
  // Data migration: export all Data-DB tables (call while still on the OLD database, before switching),
  // then import after the switch + restart. Used by the DB-switch migration guard so data isn't lost.
  exportData: () =>
    request<{
      exportedAt: string;
      dataDbType: string;
      tables: Record<string, unknown[]>;
      counts: Record<string, number>;
    }>('/infra/export-data'),
  // 200 contract includes the orphan-engine reconciliation result (restartRequired / notices /
  // stopped+failed ids). 409 has several causes and the error's `code` distinguishes them:
  // IMPORT_WOULD_ORPHAN_ENGINES (live engines exist for sessions the backup would remove; the
  // message lists them) is the only one the caller retries with stopOrphans=true to stop those
  // engines inside the request. IMPORT_ALREADY_RUNNING (another restore is in flight) and
  // IMPORT_NESTED_TRANSACTION (another transaction holds the connection) leave nothing to retry.
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
  get: (id: string) => request<Plugin>(`/plugins/${id}`),
  enable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/enable`, {
      method: 'POST',
    }),
  disable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/disable`, {
      method: 'POST',
    }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  /** Set which sessions a session-scoped plugin is activated for (['*'] = all). */
  setSessions: (id: string, sessions: string[]) =>
    request<Plugin>(`/plugins/${id}/sessions`, { method: 'PUT', body: JSON.stringify({ sessions }) }),
  /** Set (or clear, with an empty object) a plugin's config override for one session. */
  updateSessionConfig: (id: string, sessionId: string, config: Record<string, unknown>) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/config/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  healthCheck: (id: string) => request<{ healthy: boolean; message?: string }>(`/plugins/${id}/health`),
  install: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Plugin>('/plugins/install', { method: 'POST', body: form });
  },
  installFromUrl: (url: string) =>
    request<Plugin>('/plugins/install-url', { method: 'POST', body: JSON.stringify({ url }) }),
  updateFromUrl: (id: string, url: string) =>
    request<Plugin>(`/plugins/${id}/update`, { method: 'POST', body: JSON.stringify({ url }) }),
  catalog: () => request<CatalogPlugin[]>('/plugins/catalog'),
  /** Fetch a plugin's sandboxed config-UI entry HTML (the API key stays here, in the parent). */
  getConfigUi: (id: string) => requestText(`/plugins/${id}/config-ui`),
  uninstall: (id: string) => request<{ success: boolean; message: string }>(`/plugins/${id}`, { method: 'DELETE' }),
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
  sessionScope?: string;
  config?: Record<string, unknown>;
}

export const pluginInstancesApi = {
  list: (pluginId: string) => request<InstanceView[]>(`/integration/plugins/${pluginId}/instances`),
  create: (pluginId: string, body: CreateInstanceInput) =>
    request<MintedInstance>(`/integration/plugins/${pluginId}/instances`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  regenerateSecret: (pluginId: string, instanceId: string) =>
    request<MintedInstance>(`/integration/plugins/${pluginId}/instances/${instanceId}/regenerate-secret`, {
      method: 'POST',
    }),
  update: (pluginId: string, instanceId: string, body: UpdateInstanceInput) =>
    request<InstanceView>(`/integration/plugins/${pluginId}/instances/${instanceId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (pluginId: string, instanceId: string) =>
    request<void>(`/integration/plugins/${pluginId}/instances/${instanceId}`, { method: 'DELETE' }),
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
  getMessages: (period: StatsPeriod) => request<MessageStats>(`/stats/messages?period=${period}`),
};
