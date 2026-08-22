import type { WAMessage } from '@whiskeysockets/baileys';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';

/**
 * Persistence boundary for the Baileys engine's message store. The adapter depends on this narrow
 * interface (not the concrete Nest service) so it stays unit-testable with a fake.
 */
export interface BaileysMessageStore {
  /** Persist a message (idempotent on the same id) so it can be referenced by reply/forward/react/delete. */
  put(sessionId: string, msg: WAMessage): Promise<void>;
  /** Look up a previously-seen message by its id, or null. */
  getMessage(sessionId: string, messageId: string): Promise<WAMessage | null>;
  /** Remove all stored messages for a session (called on logout). */
  clearSession(sessionId: string): Promise<void>;
}

/**
 * Persistence boundary for Baileys authentication state — the credentials and Signal keys that
 * `useMultiFileAuthState` writes to local disk. Backing them with a shared database instead is what
 * makes a session PORTABLE: any node can start it without the auth directory following it around.
 * A dumb string K/V on purpose: (de)serialization (BufferJSON, proto revival) stays adapter-side in
 * `useDatabaseAuthState`, so the store never needs the Baileys library.
 */
export interface BaileysAuthStateStore {
  /** Values for the given ids of one key type, keyed by id; absent ids are simply missing. */
  read(sessionName: string, keyType: string, keyIds: string[]): Promise<Record<string, string>>;
  /** Upsert (value string) or delete (value null) entries — one batch, atomically where the dialect allows. */
  write(sessionName: string, entries: Array<{ keyType: string; keyId: string; value: string | null }>): Promise<void>;
  /** Whether stored credentials exist (drives the one-shot disk import on first database-mode start). */
  hasCreds(sessionName: string): Promise<boolean>;
  /** Remove every row of a session (terminal logout / session delete). */
  clear(sessionName: string): Promise<void>;
}

/**
 * Per-call construction config for {@link BaileysAdapter}. Engine-neutral fields come from the
 * factory; `authDir` is the base multi-file auth directory from the opaque `engine.baileys.*` blob
 * (the adapter appends the session id to isolate each session).
 */
export interface BaileysAdapterConfig {
  /** Session NAME — keys the on-disk auth directory and LID-mapping provenance. */
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
  /** Database-backed auth state (see {@link BaileysAuthStateStore}); required for authStore='database'. */
  authStateStore?: BaileysAuthStateStore;
  /** Where auth state lives: 'file' (multi-file dir, the default) or 'database' (portable sessions). */
  authStore?: 'file' | 'database';
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
