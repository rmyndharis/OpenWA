/**
 * Plugin System Interfaces
 * Defines the contract for OpenWA plugins
 */

import { HookManager, HookEvent, HookHandler } from '../hooks';
import type { MessageResponseDto } from '../../modules/message/dto';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { PluginNetRequestInit, PluginNetResponse } from './plugin-net';
import type { HandoverState } from '../../modules/integration/entities/conversation-mapping.entity';
import type { WebhookRequest, WebhookResponse, WebhookHandler } from './sandbox/worker-webhooks';

// Re-export the ingress webhook types on the public SDK surface so plugin authors can type their
// handler without importing from sandbox internals.
export type { WebhookRequest, WebhookResponse, WebhookHandler };

// ============================================================================
// Plugin Types
// ============================================================================

export enum PluginType {
  ENGINE = 'engine', // WhatsApp engine (whatsapp-web.js, baileys, etc.)
  STORAGE = 'storage', // Storage backends (local, S3, GCS, etc.)
  QUEUE = 'queue', // Queue systems (Redis, RabbitMQ, etc.)
  AUTH = 'auth', // Authentication providers
  EXTENSION = 'extension', // General extensions (auto-reply, scheduler, etc.)
}

export enum PluginStatus {
  INSTALLED = 'installed',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
  ERROR = 'error',
}

// ============================================================================
// Plugin Manifest
// ============================================================================

export interface PluginManifest {
  id: string; // Unique identifier (e.g., 'whatsapp-web.js', 'auto-reply')
  name: string; // Display name
  version: string; // Semver
  type: PluginType;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;

  // Entry point
  main: string; // Relative path to main file

  // Dependencies
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;

  // Configuration schema (optional, for UI generation)
  configSchema?: PluginConfigSchema;

  // Optional sandboxed-iframe config editor. `entry` is a plugin-relative path to a self-contained
  // HTML file (inline JS/CSS — a sandboxed opaque-origin iframe can't load subresources). Served by
  // the host via the authenticated GET /plugins/:id/config-ui and injected as an iframe `srcdoc`; the
  // editor exchanges config over a postMessage bridge (the API key never reaches the iframe). When
  // present, the dashboard prefers it over the declarative `configSchema` form.
  configUi?: { entry: string; height?: number };

  // Hooks this plugin listens to
  hooks?: HookEvent[];

  // Features provided by this plugin
  provides?: string[];

  // Required features from other plugins
  requires?: string[];

  // Capability permissions this plugin declares; the loader enforces them at the capability
  // boundary (see PluginCapabilityPermission). A capability call whose permission is not declared
  // here is denied with a PluginCapabilityError. Absent / empty = no capability access.
  permissions?: string[];

  // Session ids this plugin may act on, or ['*']. Absent = ['*'] (all). Enforced by the
  // capability facade. Static (manifest) by design: editing plugin config cannot widen scope.
  sessions?: string[];

  // Whether the plugin is scoped to specific sessions (default true). A session-scoped plugin only
  // receives hook events for the sessions an operator has activated it for (see activeSessions); a
  // global plugin (false) always runs, with no per-number notion (e.g. a metrics logger).
  sessionScoped?: boolean;

  // Outbound-HTTP host allowlist for `ctx.net.fetch` (requires the `net:fetch` permission). Each
  // entry is `host:port` (exact) or a bare `host` (any port); `'*'` allows any public host. Absent /
  // empty = deny all. `allowConfigHosts` additionally admits the host of each named config key (e.g. an
  // operator-set base URL), resolved at fetch time. The SSRF guard still blocks internal IPs regardless.
  net?: { allow?: string[]; allowConfigHosts?: string[] };

  // Localized dashboard text (name/description/config field titles) per locale code. English is the
  // base manifest + fallback. Dashboard-only; does not affect runtime behavior.
  i18n?: PluginI18n;

  // Integration SDK major.minor the plugin was authored against (e.g. '1' or '1.2'). Only the major
  // is enforced — see SUPPORTED_SDK_MAJOR / validateIngressManifest. Absent = treated as '1'.
  sdkVersion?: string;

  // Inbound webhook routes this plugin claims (requires the `webhook:ingress` permission). Validated
  // by validateIngressManifest; not yet wired into the loader (see that function's doc comment).
  ingress?: PluginIngressRoute[];
}

/** Localized overrides for a plugin's dashboard-facing text, per locale (dashboard i18n). */
export interface PluginI18nText {
  title?: string;
  description?: string;
}
export interface PluginI18nLocale {
  name?: string;
  description?: string;
  /** Keyed by a TOP-LEVEL configSchema.properties key; only title/description are localized. */
  config?: Record<string, PluginI18nText>;
}
/** Keyed by a dashboard locale code (e.g. "es", "zh-CN"). Untranslated entries fall back to English. */
export type PluginI18n = Record<string, PluginI18nLocale>;

/**
 * One field in a plugin's config schema. Recursive: an `object` field nests `properties`, an `array`
 * field describes its element with `items` (array-of-rows when `items.type === 'object'`). The host
 * renders this into an authenticated form; the plugin still reads `ctx.config` defensively.
 */
export interface PluginConfigField {
  // 'textarea' is a string rendered multi-line; a field with `enum` renders as a <select>.
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'textarea';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[]; // when present (any scalar type), the field renders as a <select>
  required?: boolean;
  secret?: boolean; // sensitive value (e.g. API key): masked on read, preserved on an unchanged write
  // Validation hints, surfaced as HTML input attributes (advisory — not hard-enforced server-side):
  min?: number; // number: value bound; string/textarea: minLength; array: min rows
  max?: number; // number: value bound; string/textarea: maxLength; array: max rows
  pattern?: string; // string/textarea: HTML validation regex
  // Composite kinds:
  items?: PluginConfigField; // array element schema; array-of-rows when items.type === 'object'
  properties?: Record<string, PluginConfigField>; // nested-object fields (type: 'object')
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigField>;
}

// ============================================================================
// Plugin Capability
// ============================================================================

/**
 * Capability permissions a plugin declares in its manifest `permissions` and that the loader
 * enforces at the capability boundary. A plugin may only use a capability whose permission it
 * declares; an undeclared (or missing-permission) plugin is denied with a PluginCapabilityError.
 */
export const PluginCapabilityPermission = {
  /** `ctx.messages.*` — send / reply on a session. */
  MESSAGES_SEND: 'messages:send',
  /** `ctx.engine.*` — read-only engine queries (group info, contacts, chats, number check). */
  ENGINE_READ: 'engine:read',
  /** `ctx.net.fetch` — SSRF-guarded outbound HTTP, scoped to the manifest `net.allow` host list. */
  NET_FETCH: 'net:fetch',
  /** `ctx.registerWebhook` — claim an inbound ingress route. Loader-enforced; cannot be widened by config. */
  WEBHOOK_INGRESS: 'webhook:ingress',
  /** `ctx.conversations.send` — normalized outbound send translated to MessageService. */
  CONVERSATION_SEND: 'conversation:send',
} as const;
export type PluginCapabilityPermission = (typeof PluginCapabilityPermission)[keyof typeof PluginCapabilityPermission];

// ============================================================================
// Integration SDK v1 — inbound webhook ingress + normalized outbound send
// ============================================================================

/** How an inbound webhook's authenticity is established before the plugin sees it. */
export interface IngressSignatureSpec {
  scheme: 'hmac-sha256' | 'shared-secret' | 'none';
  header?: string;
  // Template over which the HMAC is computed. `{rawBody}` `{timestamp}` `{id}` placeholders.
  contentTemplate?: string;
  encoding?: 'hex' | 'base64';
  prefix?: string;
  timestampHeader?: string;
  toleranceSec?: number; // when present, must be > 0 (see validateIngressManifest)
  dedupHeader?: string;
}

/** Provider webhook-verification challenge (e.g. a GET handshake on route registration). */
export interface IngressChallengeSpec {
  method: 'GET';
  tokenParam: string;
  echoParam: string;
}

/** One inbound webhook route a plugin claims. Requires the `webhook:ingress` permission. */
export interface PluginIngressRoute {
  route: string; // host prefixes it; the plugin never binds a port
  mode: 'async' | 'sync-reply';
  signature: IngressSignatureSpec;
  challenge?: IngressChallengeSpec;
  verify: 'core' | 'self';
  maxBodyBytes: number;
  // Optional: where the provider's conversation id lives, so the host can compute a per-conversation
  // ordering key (P1). Absent => the P1 lock falls back to per-instance serialization. The host never
  // needs to understand the provider's schema beyond this one pointer.
  conversationId?: { header?: string; jsonPointer?: string };
}

// Normalized outbound envelope for ctx.conversations.send (POJO across the wire).
export interface ConversationSendEnvelope {
  sessionId?: string;
  instanceId?: string;
  chatId?: string;
  type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'voice' | 'location';
  text?: string;
  mediaUrl?: string;
  replyTo?: string;
  source?: { provider: string; externalConversationId: string };
}

/** Integration SDK major version this host supports. A plugin whose `sdkVersion` major differs is refused. */
export const SUPPORTED_SDK_MAJOR = 1;

/**
 * Validates a manifest's `ingress` declarations: SDK major compatibility, the `webhook:ingress`
 * permission, route uniqueness, and that a declared `toleranceSec` is usable (> 0 — a replay window
 * of zero or less would make the tolerance check a no-op). A manifest with no `ingress` entries is a
 * no-op. Pure validation — not yet called from the plugin loader (wiring lands in a later task).
 */
export function validateIngressManifest(manifest: PluginManifest): void {
  if (!manifest.ingress?.length) return; // no ingress declared → nothing to validate
  const declaredMajor = Number.parseInt((manifest.sdkVersion ?? '1').split('.')[0], 10);
  if (!Number.isFinite(declaredMajor) || declaredMajor !== SUPPORTED_SDK_MAJOR) {
    throw new Error(
      `Plugin ${manifest.id}: SDK major ${manifest.sdkVersion} is not supported by this host (supports ${SUPPORTED_SDK_MAJOR})`,
    );
  }
  const perms = manifest.permissions ?? [];
  if (!perms.includes(PluginCapabilityPermission.WEBHOOK_INGRESS)) {
    throw new Error(`Plugin ${manifest.id}: declares ingress routes but is missing the 'webhook:ingress' permission`);
  }
  const seen = new Set<string>();
  for (const r of manifest.ingress) {
    if (!r.route || seen.has(r.route)) {
      throw new Error(`Plugin ${manifest.id}: duplicate or empty ingress route '${r.route}'`);
    }
    seen.add(r.route);
    if (r.signature.toleranceSec !== undefined && r.signature.toleranceSec <= 0) {
      throw new Error(
        `Plugin ${manifest.id}: route '${r.route}' toleranceSec must be > 0 (a replay guard would be a no-op)`,
      );
    }
  }
}

/**
 * Thrown by a plugin capability when a call is rejected (missing permission, out-of-scope session,
 * unstarted session, etc.). Gives plugins a predictable failure instead of a raw TypeError.
 */
export class PluginCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCapabilityError';
  }
}

export interface PluginMessagingCapability {
  sendText(sessionId: string, chatId: string, text: string): Promise<MessageResponseDto>;
  reply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<MessageResponseDto>;
}

export interface PluginEngineReadCapability {
  getGroupInfo(sessionId: string, groupId: string): ReturnType<IWhatsAppEngine['getGroupInfo']>;
  getContacts(sessionId: string): ReturnType<IWhatsAppEngine['getContacts']>;
  getContactById(sessionId: string, contactId: string): ReturnType<IWhatsAppEngine['getContactById']>;
  checkNumberExists(sessionId: string, phone: string): ReturnType<IWhatsAppEngine['checkNumberExists']>;
  getChats(sessionId: string): ReturnType<IWhatsAppEngine['getChats']>;
  /** Recent messages for a chat (both directions), for history backfill. `limit` is clamped host-side. */
  getChatHistory(
    sessionId: string,
    chatId: string,
    limit?: number,
    includeMedia?: boolean,
  ): ReturnType<IWhatsAppEngine['getChatHistory']>;
}

/** Outbound HTTP for a plugin — always through the host SSRF guard, scoped to `manifest.net.allow`. */
export interface PluginNetCapability {
  fetch(url: string, init?: PluginNetRequestInit): Promise<PluginNetResponse>;
}

/** Normalized outbound send for a plugin — translated host-side to MessageService.sendText/reply. */
export interface PluginConversationsCapability {
  send(env: ConversationSendEnvelope): Promise<unknown>;
}

/**
 * Flip a mapped conversation's handover state. Reuses the `conversation:send` permission — flipping
 * handover is part of owning the conversation, not a distinct capability grant.
 */
export interface PluginHandoverCapability {
  set(key: { sessionId: string; chatId: string; instanceId: string }, state: HandoverState): Promise<unknown>;
}

/**
 * Plugin-facing conversation mapping: create/read the WA-chat <-> provider-conversation link an adapter
 * needs so handover.set and conversation.send({source}) can resolve. Reuses the `conversation:send`
 * permission — owning the mapping is part of owning the conversation.
 */
export interface PluginMappingsCapability {
  upsert(key: { sessionId: string; chatId: string; instanceId: string }, providerConversationId: string): Promise<void>;
  get(key: {
    sessionId: string;
    chatId: string;
    instanceId: string;
  }): Promise<{ providerConversationId: string; handoverState: HandoverState } | null>;
  getByProvider(
    instanceId: string,
    providerConversationId: string,
  ): Promise<{ sessionId: string; chatId: string; handoverState: HandoverState } | null>;
}

// ============================================================================
// Plugin Context (passed to plugin on initialization)
// ============================================================================

export interface PluginContext {
  // Plugin info
  pluginId: string;
  manifest: PluginManifest;

  // Configuration
  config: Record<string, unknown>;

  // Hook system
  hookManager: HookManager;

  // Logger instance for this plugin
  logger: PluginLogger;

  // Storage for plugin data
  storage: PluginStorage;

  // Register a hook handler
  registerHook: (event: HookEvent, handler: HookHandler, priority?: number) => void;

  // Claim an inbound ingress webhook route (requires the `webhook:ingress` permission). Delivered only
  // to sandboxed plugins via the ingress pipeline; in-process built-ins cannot receive ingress.
  registerWebhook: (route: string, handler: WebhookHandler) => void;

  // Curated write surface — routes through MessageService (persistence preserved).
  messages: PluginMessagingCapability;

  // Read-only, scoped engine queries.
  engine: PluginEngineReadCapability;

  // SSRF-guarded outbound HTTP, scoped to the manifest `net.allow` host list.
  net: PluginNetCapability;

  // Normalized outbound send, translated to MessageService. Requires `conversation:send`.
  conversations: PluginConversationsCapability;

  // Flip a mapped conversation's bot/human/closed handover state. Requires `conversation:send`.
  handover: PluginHandoverCapability;

  // Create/read the WA-chat <-> provider-conversation mapping. Requires `conversation:send`.
  mappings: PluginMappingsCapability;
}

export interface PluginLogger {
  log: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, error?: unknown, meta?: Record<string, unknown>) => void;
}

export interface PluginStorage {
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: <T = unknown>(key: string, value: T) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (prefix?: string) => Promise<string[]>;
}

// ============================================================================
// Plugin Interface (what plugins must implement)
// ============================================================================

export interface IPlugin {
  // Lifecycle hooks
  onLoad?: (context: PluginContext) => Promise<void>;
  onEnable?: (context: PluginContext) => Promise<void>;
  onDisable?: (context: PluginContext) => Promise<void>;
  onUnload?: (context: PluginContext) => Promise<void>;

  // Configuration change handler
  onConfigChange?: (context: PluginContext, newConfig: Record<string, unknown>) => Promise<void>;

  // Health check (for dashboard monitoring)
  healthCheck?: () => Promise<{ healthy: boolean; message?: string }>;
}

// ============================================================================
// Engine Plugin Interface (extends IPlugin for engine-specific methods)
// ============================================================================

export interface IEnginePlugin extends IPlugin {
  type: PluginType.ENGINE;

  // Engine factory method
  createEngine: (config: Record<string, unknown>) => unknown;

  // Get supported features
  getFeatures: () => string[];

  // Underlying engine library name + version (e.g. { name: 'whatsapp-web.js', version: '1.34.7' }) —
  // distinct from the adapter/plugin's own manifest version. Optional: an engine may not report it.
  getEngineLibrary?: () => { name: string; version: string };
}

// ============================================================================
// Plugin Instance (runtime representation)
// ============================================================================

export interface PluginInstance {
  manifest: PluginManifest;
  status: PluginStatus;
  config: Record<string, unknown>;
  instance: IPlugin | null;
  error?: string;
  loadedAt?: Date;
  enabledAt?: Date;
  // Sessions a session-scoped plugin is activated for; ['*'] = all. Defaulted to ['*'] on enable.
  // Ignored for a global (sessionScoped:false) plugin. Persisted on the registry entry.
  activeSessions?: string[];
  // Per-session config overrides, keyed by sessionId. The config a hook sees for session S is the
  // override shallow-merged over `config` (the '*' base) — see resolvePluginConfig. Absent = no
  // overrides (every session gets the base). Persisted on the registry entry.
  sessionConfig?: Record<string, Record<string, unknown>>;
  // First-party built-ins (engines, bundled extensions) run in-process; plugins loaded from the
  // plugins directory are untrusted and run sandboxed in a worker. `false` => sandboxed.
  builtIn?: boolean;
}

// ============================================================================
// Plugin Registry Entry (for storage)
// ============================================================================

export interface PluginRegistryEntry {
  id: string;
  type: PluginType;
  name: string;
  version: string;
  status: PluginStatus;
  config: Record<string, unknown>;
  builtIn: boolean; // True for bundled plugins
  installedAt: Date;
  updatedAt: Date;
  // Sessions a session-scoped plugin is activated for; ['*'] = all. Absent = not yet set (treated
  // as ['*'] on enable).
  activeSessions?: string[];
  // Per-session config overrides (keyed by sessionId), merged over `config` per session at hook time.
  sessionConfig?: Record<string, Record<string, unknown>>;
}
