import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../common/services/logger.service';
import { isPathWithin } from '../../common/utils/path-safety';
import { PluginStatus, PluginStorage, PluginRegistryEntry } from './plugin.interfaces';

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
      fs.writeFileSync(this.registryPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
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

  // ============================================================================
  // Plugin Data Storage (sandboxed per-plugin storage)
  // ============================================================================

  createPluginStorage(pluginId: string): PluginStorage {
    const pluginDataDir = path.join(this.dataDir, 'plugins', pluginId);

    // Ensure directory exists
    if (!fs.existsSync(pluginDataDir)) {
      fs.mkdirSync(pluginDataDir, { recursive: true });
    }

    const logger = this.logger;

    // Containment: a plugin storage key must resolve INSIDE its own sandbox dir. path.join normalizes
    // `..`, so a key like `../../x` would otherwise escape and clobber another plugin's data, the
    // registry, or .env.generated. Reject anything that escapes; JID chars (`:`,`@`,`.`,`-`) are fine.
    const resolveKeyPath = (key: string): string | null =>
      isPathWithin(pluginDataDir, `${key}.json`) ? path.join(pluginDataDir, `${key}.json`) : null;

    return {
      get: <T = unknown>(key: string): Promise<T | null> => {
        const filePath = resolveKeyPath(key);
        if (!filePath) {
          logger.warn(`Refusing to read plugin data with an unsafe key: ${pluginId}/${key}`);
          return Promise.resolve(null);
        }
        try {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            return Promise.resolve(JSON.parse(content) as T);
          }
        } catch (error) {
          logger.error(`Failed to read plugin data: ${pluginId}/${key}`, String(error));
        }
        return Promise.resolve(null);
      },

      set: <T = unknown>(key: string, value: T): Promise<void> => {
        const filePath = resolveKeyPath(key);
        if (!filePath) {
          return Promise.reject(new Error(`Unsafe plugin storage key (escapes sandbox): ${key}`));
        }
        try {
          fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
          return Promise.resolve();
        } catch (error) {
          logger.error(`Failed to write plugin data: ${pluginId}/${key}`, String(error));
          return Promise.reject(new Error(error instanceof Error ? error.message : String(error)));
        }
      },

      delete: (key: string): Promise<void> => {
        const filePath = resolveKeyPath(key);
        if (!filePath) {
          return Promise.reject(new Error(`Unsafe plugin storage key (escapes sandbox): ${key}`));
        }
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
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
          let keys = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

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
