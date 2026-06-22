/**
 * Plugin System Interfaces
 * Defines the contract for OpenWA plugins
 */

import { HookManager, HookEvent, HookHandler } from '../hooks';
import type { MessageResponseDto } from '../../modules/message/dto';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

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
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'array' | 'object';
      title?: string;
      description?: string;
      default?: unknown;
      enum?: unknown[];
      required?: boolean;
      secret?: boolean; // For sensitive values like API keys
    }
  >;
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
} as const;
export type PluginCapabilityPermission = (typeof PluginCapabilityPermission)[keyof typeof PluginCapabilityPermission];

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

  // Curated write surface — routes through MessageService (persistence preserved).
  messages: PluginMessagingCapability;

  // Read-only, scoped engine queries.
  engine: PluginEngineReadCapability;
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
}
