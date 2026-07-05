import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../common/services/logger.service';
import { isPathWithin, isSafeStorageKey } from '../../common/utils/path-safety';
import { PluginStatus, PluginStorage, PluginRegistryEntry } from './plugin.interfaces';

/** Unique-per-write counter so concurrent writes to the same key don't collide on the temp file. */
let tmpWriteSeq = 0;

/**
 * Write to a sibling temp file then atomically rename it into place. POSIX rename is atomic on the
 * same filesystem, so a crash (SIGKILL/OOM) mid-write can never leave a truncated/corrupt target —
 * a reader sees either the old complete file or the new complete file, never a partial one.
 */
function atomicWriteFileSync(filePath: string, data: string, options?: { mode?: number }): void {
  const tmp = `${filePath}.${process.pid}.${tmpWriteSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
}

const ENCODED_KEY_PREFIX = 'key-';

function encodeStorageKey(key: string): string {
  return (
    ENCODED_KEY_PREFIX +
    Buffer.from(key, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  );
}

function decodeStorageFileName(stem: string): string | null {
  if (!stem.startsWith(ENCODED_KEY_PREFIX)) return null;
  const encoded = stem.slice(ENCODED_KEY_PREFIX.length);
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    // Only accept it as one of our base64url-encoded names if it round-trips exactly. A literal legacy
    // filename that merely starts with `key-` would otherwise be mis-decoded into a garbage key.
    return encodeStorageKey(decoded) === stem ? decoded : null;
  } catch {
    return null;
  }
}

@Injectable()
export class PluginStorageService {
  private readonly logger = createLogger('PluginStorageService');
  private readonly dataDir: string;
  private readonly registryPath: string;
  private registry: Map<string, PluginRegistryEntry> = new Map();

  constructor(private readonly configService: ConfigService) {
    this.dataDir = this.configService.get<string>('dataDir') ?? './data';
    this.registryPath = path.join(this.dataDir, 'plugins', 'registry.json');
    this.loadRegistry();
  }

  private loadRegistry(): void {
    try {
      if (fs.existsSync(this.registryPath)) {
        const content = fs.readFileSync(this.registryPath, 'utf-8');
        const entries = JSON.parse(content) as PluginRegistryEntry[];
        this.registry = new Map(entries.map(e => [e.id, e]));
        this.logger.debug(`Loaded ${this.registry.size} plugins from registry`, {
          action: 'registry_loaded',
        });
      }
    } catch (error) {
      this.logger.error('Failed to load plugin registry', String(error), {
        action: 'registry_load_failed',
      });
    }
  }

  private saveRegistry(): void {
    try {
      const dir = path.dirname(this.registryPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const entries = Array.from(this.registry.values());
      // Owner-only: plugin config can hold secrets (e.g. an API key). writeFileSync's mode only
      // applies on CREATE, so chmod an already-existing, looser file too (best-effort).
      atomicWriteFileSync(this.registryPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
      try {
        fs.chmodSync(this.registryPath, 0o600);
      } catch {
        /* best-effort hardening */
      }
    } catch (error) {
      this.logger.error('Failed to save plugin registry', String(error), {
        action: 'registry_save_failed',
      });
    }
  }

  // ============================================================================
  // Registry Methods
  // ============================================================================

  getPluginEntry(pluginId: string): PluginRegistryEntry | undefined {
    return this.registry.get(pluginId);
  }

  setPluginEntry(entry: PluginRegistryEntry): void {
    entry.updatedAt = new Date();
    this.registry.set(entry.id, entry);
    this.saveRegistry();
  }

  deletePluginEntry(pluginId: string): void {
    this.registry.delete(pluginId);
    this.saveRegistry();
  }

  getAllEntries(): PluginRegistryEntry[] {
    return Array.from(this.registry.values());
  }

  // ============================================================================
  // Status Management
  // ============================================================================

  getPluginStatus(pluginId: string): PluginStatus | null {
    const entry = this.registry.get(pluginId);
    return entry?.status ?? null;
  }

  setPluginStatus(pluginId: string, status: PluginStatus): void {
    const entry = this.registry.get(pluginId);
    if (entry) {
      entry.status = status;
      entry.updatedAt = new Date();
      this.saveRegistry();
    }
  }

  // ============================================================================
  // Config Management
  // ============================================================================

  getPluginConfig(pluginId: string): Record<string, unknown> | null {
    const entry = this.registry.get(pluginId);
    return entry?.config ?? null;
  }

  setPluginConfig(pluginId: string, config: Record<string, unknown>): void {
    const entry = this.registry.get(pluginId);
    if (entry) {
      entry.config = config;
      entry.updatedAt = new Date();
      this.saveRegistry();
    }
  }

  getPluginSessions(pluginId: string): string[] | null {
    const entry = this.registry.get(pluginId);
    return entry?.activeSessions ?? null;
  }

  setPluginSessions(pluginId: string, sessions: string[]): void {
    const entry = this.registry.get(pluginId);
    if (entry) {
      entry.activeSessions = sessions;
      entry.updatedAt = new Date();
      this.saveRegistry();
    }
  }

  getPluginSessionConfig(pluginId: string): Record<string, Record<string, unknown>> | null {
    const entry = this.registry.get(pluginId);
    return entry?.sessionConfig ?? null;
  }

  setPluginSessionConfig(pluginId: string, sessionConfig: Record<string, Record<string, unknown>>): void {
    const entry = this.registry.get(pluginId);
    if (entry) {
      entry.sessionConfig = sessionConfig;
      entry.updatedAt = new Date();
      this.saveRegistry();
    }
  }

  // ============================================================================
  // Plugin Data Storage (sandboxed per-plugin storage)
  // ============================================================================

  createPluginStorage(pluginId: string): PluginStorage {
    const pluginDataDir = path.join(this.dataDir, 'plugins', pluginId);

    // Ensure directory exists. 0o700 (owner-only) because plugin storage holds the same class of
    // secret as the registry (OAuth/refresh tokens, webhook secrets a plugin persists) — mirror the
    // hardening saveRegistry already applies rather than inherit a group/other-readable umask default.
    if (!fs.existsSync(pluginDataDir)) {
      fs.mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
    }

    const logger = this.logger;

    // Containment: validate the logical key, then encode it to a filesystem-safe filename. This keeps
    // JID-style keys (`group:sess-1:12345@g.us`) portable on Windows while still rejecting traversal.
    const resolveKeyPath = (key: string): string | null => {
      if (!isSafeStorageKey(key)) return null;
      const fileName = `${encodeStorageKey(key)}.json`;
      return isPathWithin(pluginDataDir, fileName) ? path.join(pluginDataDir, fileName) : null;
    };

    // Backward compatibility for pre-encoded storage files (`state.json`). Reads/deletes consult it,
    // but new writes always use the encoded filename above.
    const resolveLegacyKeyPath = (key: string): string | null => {
      if (!isSafeStorageKey(key)) return null;
      const fileName = `${key}.json`;
      return isPathWithin(pluginDataDir, fileName) ? path.join(pluginDataDir, fileName) : null;
    };

    return {
      get: <T = unknown>(key: string): Promise<T | null> => {
        const filePath = resolveKeyPath(key);
        if (!filePath) {
          logger.warn(`Refusing to read plugin data with an unsafe key: ${pluginId}/${key}`);
          return Promise.resolve(null);
        }
        try {
          const legacyPath = resolveLegacyKeyPath(key);
          const candidates = legacyPath && legacyPath !== filePath ? [filePath, legacyPath] : [filePath];
          for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
              const content = fs.readFileSync(candidate, 'utf-8');
              return Promise.resolve(JSON.parse(content) as T);
            }
          }
        } catch (error) {
          logger.error(`Failed to read plugin data: ${pluginId}/${key}`, String(error));
        }
        return Promise.resolve(null);
      },

      set: <T = unknown>(key: string, value: T): Promise<void> => {
        const filePath = resolveKeyPath(key);
        if (!filePath) {
          return Promise.reject(new Error(`Unsafe plugin storage key: ${key}`));
        }
        try {
          // 0o600 (owner-only): a plugin-persisted secret must not land in a group/other-readable file.
          // The mode on the temp write carries through the rename; chmod is a backstop if the target
          // pre-existed (writeFileSync mode only applies on create). Mirrors saveRegistry's hardening.
          atomicWriteFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
          fs.chmodSync(filePath, 0o600);
          // Migrate off any pre-encoding legacy file for this key so a stale copy can't shadow reads/lists.
          const legacyPath = resolveLegacyKeyPath(key);
          if (legacyPath && legacyPath !== filePath && fs.existsSync(legacyPath)) {
            fs.unlinkSync(legacyPath);
          }
          return Promise.resolve();
        } catch (error) {
          logger.error(`Failed to write plugin data: ${pluginId}/${key}`, String(error));
          return Promise.reject(new Error(error instanceof Error ? error.message : String(error)));
        }
      },

      delete: (key: string): Promise<void> => {
        const filePath = resolveKeyPath(key);
        if (!filePath) {
          return Promise.reject(new Error(`Unsafe plugin storage key: ${key}`));
        }
        try {
          const legacyPath = resolveLegacyKeyPath(key);
          const candidates = legacyPath && legacyPath !== filePath ? [filePath, legacyPath] : [filePath];
          for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
              fs.unlinkSync(candidate);
            }
          }
          return Promise.resolve();
        } catch (error) {
          logger.error(`Failed to delete plugin data: ${pluginId}/${key}`, String(error));
          return Promise.reject(new Error(error instanceof Error ? error.message : String(error)));
        }
      },

      list: (prefix?: string): Promise<string[]> => {
        try {
          const files = fs.readdirSync(pluginDataDir);
          let keys = Array.from(
            new Set(
              files
                .filter(f => f.endsWith('.json'))
                .map(f => f.slice(0, -'.json'.length))
                .map(stem => decodeStorageFileName(stem) ?? stem),
            ),
          );

          if (prefix) {
            keys = keys.filter(k => k.startsWith(prefix));
          }

          return Promise.resolve(keys);
        } catch (error) {
          logger.error(`Failed to list plugin data: ${pluginId}`, String(error));
          return Promise.resolve([]);
        }
      },
    };
  }
}
