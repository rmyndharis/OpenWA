import type { WAMessage } from '@whiskeysockets/baileys';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';
import type { ChatStateStore } from '../adapters/baileys-chat-state-store.service';

/**
 * Persistence boundary for the Baileys engine's message store. The adapter depends on this narrow
 * interface (not the concrete Nest service) so it stays unit-testable with a fake.
 */
export interface BaileysMessageStore {
  /** Persist a message (idempotent on the same id) so it can be referenced by reply/forward/react/delete. */
  put(sessionId: string, msg: WAMessage): Promise<void>;
  /** Look up a previously-seen message by its id, or null. */
  getMessage(sessionId: string, messageId: string): Promise<WAMessage | null>;
  /**
   * Look up many messages in one query. Ids the store has never seen are simply absent from the
   * result, so the caller cannot assume the order or the length matches its input.
   */
  getMessages(sessionId: string, messageIds: string[]): Promise<WAMessage[]>;
  /** Remove all stored messages for a session (called on logout). */
  clearSession(sessionId: string): Promise<void>;
}

/**
 * Per-call construction config for {@link BaileysAdapter}. Engine-neutral fields come from the
 * factory; `authDir` is the base multi-file auth directory from the opaque `engine.baileys.*` blob
 * (the adapter appends the session id to isolate each session).
 */
export interface BaileysAdapterConfig {
  /** Session UUID (Session.id) — keys the on-disk auth directory, chat state and LID provenance. */
  sessionId: string;
  /** Session UUID (Session.id) — keys the FK-bound baileys_stored_messages rows via messageStore. */
  dbSessionId: string;
  authDir: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
  /** Persisted store for reply/forward/react/delete. Provided by the plugin; the four ops require it. */
  messageStore?: BaileysMessageStore;
  /** Persisted, cross-session lid->phone resolution table. Backs lid resolution beyond the in-memory map. */
  lidMappingStore?: LidMappingStore;
  /** Persisted per-session mute/archive/pin, so those chat fields survive a reconnect Baileys cannot resync. */
  chatStateStore?: ChatStateStore;
}

/**
 * The minimal pino-compatible logger Baileys' `makeWASocket` expects. Declared locally so we can
 * pass a fully silent logger without taking a direct `pino` dependency.
 *
 * Matches the Baileys `ILogger` contract: each log method receives `(obj: unknown, msg?: string)`.
 */
export interface BaileysLogger {
  level: string;
  child: (bindings: Record<string, unknown>) => BaileysLogger;
  trace: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}
