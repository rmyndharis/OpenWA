import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../hooks';
import { PluginCircuitBreaker } from '../hooks/plugin-circuit-breaker.service';
import { withTimeout } from '../hooks/with-timeout';
import {
  PluginManifest,
  PluginInstance,
  PluginStatus,
  PluginContext,
  IPlugin,
  PluginType,
  PluginLogger,
  PluginPermission,
} from './plugin.interfaces';
import { PluginStorageService } from './plugin-storage.service';
import { PluginPermissionDeniedError } from './exceptions/plugin-permission-denied.error';

@Injectable()
export class PluginLoaderService implements OnModuleInit {
  private readonly logger = createLogger('PluginLoaderService');
  private readonly plugins = new Map<string, PluginInstance>();
  private readonly pluginsDir: string;
  private readonly lifecycleTimeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    private readonly pluginStorage: PluginStorageService,
    private readonly breaker: PluginCircuitBreaker,
  ) {
    this.pluginsDir = this.configService.get<string>('plugins.dir') ?? './plugins';
    this.lifecycleTimeoutMs = this.configService.get<number>('plugins.lifecycleTimeoutMs') ?? 10000;
    this.breaker.configure(this.configService.get<number>('plugins.circuitBreakerThreshold') ?? 5);
    this.hookManager.configure(this.configService.get<number>('plugins.hookTimeoutMs') ?? 5000);
  }

  onModuleInit(): void {
    // Load built-in plugins first (synchronous registration)
    this.loadBuiltInPlugins();

    // Then load user plugins if directory exists
    if (fs.existsSync(this.pluginsDir)) {
      this.loadPluginsFromDirectory(this.pluginsDir);
    }

    this.logger.log(`Loaded ${this.plugins.size} plugins`, {
      action: 'plugins_loaded',
      count: this.plugins.size,
    });

    // Hook handlers live in-process and cannot be shared via Redis. In a
    // cluster, hooks only behave consistently if every node loads the same
    // plugin set — i.e. PLUGINS_DIR must be backed by shared storage.
    if (this.configService.get<boolean>('cluster.enabled') && this.plugins.size > 0) {
      this.logger.warn(
        `Cluster mode: ${this.plugins.size} plugins loaded from '${this.pluginsDir}'. ` +
          'Ensure PLUGINS_DIR is shared storage so every node loads identical hooks.',
        { action: 'cluster_plugins_warning' },
      );
    }
  }

  private loadBuiltInPlugins(): void {
    // Built-in plugins are registered programmatically
    // This will be used by Phase 4 to register engine plugins
    this.logger.debug('Built-in plugins loading point (Phase 4)', {
      action: 'builtin_plugins_init',
    });
  }

  private loadPluginsFromDirectory(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = path.join(dir, entry.name);
      const manifestPath = path.join(pluginPath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        this.logger.warn(`Plugin ${entry.name} missing manifest.json`, {
          pluginPath,
          action: 'manifest_missing',
        });
        continue;
      }

      try {
        this.loadPlugin(pluginPath);
      } catch (error) {
        this.logger.error(
          `Failed to load plugin ${entry.name}`,
          error instanceof Error ? error.message : String(error),
          { pluginPath, action: 'plugin_load_failed' },
        );
      }
    }
  }

  loadPlugin(pluginPath: string): PluginInstance {
    const manifestPath = path.join(pluginPath, 'manifest.json');
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent) as PluginManifest;

    // Validate manifest
    if (!manifest.id || !manifest.name || !manifest.version || !manifest.type || !manifest.main) {
      throw new Error(`Invalid manifest: missing required fields`);
    }

    // Check if plugin already loaded
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin ${manifest.id} is already loaded`);
    }

    // Load stored config
    const storedConfig = this.pluginStorage.getPluginConfig(manifest.id);

    const pluginInstance: PluginInstance = {
      manifest,
      status: PluginStatus.INSTALLED,
      config: storedConfig ?? {},
      instance: null,
      loadedAt: new Date(),
    };

    this.plugins.set(manifest.id, pluginInstance);

    this.logger.log(`Plugin loaded: ${manifest.name} v${manifest.version}`, {
      pluginId: manifest.id,
      type: manifest.type,
      action: 'plugin_loaded',
    });

    return pluginInstance;
  }

  async enablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    if (plugin.status === PluginStatus.ENABLED) {
      return; // Already enabled
    }

    try {
      // Create plugin context
      const context = this.createPluginContext(plugin);

      // Load the plugin instance if not already loaded
      if (!plugin.instance) {
        const mainPath = this.resolvePluginMainPath(pluginId, plugin.manifest.main);
        // Dynamic require for user plugins (path validated above to prevent traversal)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pluginModule = require(mainPath) as { default?: new () => IPlugin };
        if (pluginModule.default) {
          plugin.instance = new pluginModule.default();
        } else {
          throw new Error(`Plugin ${pluginId} does not export a default class`);
        }
      }

      // Call lifecycle hooks
      if (plugin.instance.onLoad) {
        await this.runLifecycle(pluginId, 'onLoad', () => plugin.instance!.onLoad!(context));
      }

      if (plugin.instance.onEnable) {
        await this.runLifecycle(pluginId, 'onEnable', () => plugin.instance!.onEnable!(context));
      }

      plugin.status = PluginStatus.ENABLED;
      plugin.enabledAt = new Date();
      plugin.error = undefined;

      // Persist status
      this.pluginStorage.setPluginStatus(pluginId, PluginStatus.ENABLED);

      this.logger.log(`Plugin enabled: ${plugin.manifest.name}`, {
        pluginId,
        action: 'plugin_enabled',
      });
    } catch (error) {
      plugin.status = PluginStatus.ERROR;
      plugin.error = error instanceof Error ? error.message : String(error);

      this.pluginStorage.setPluginStatus(pluginId, PluginStatus.ERROR);

      throw error;
    }
  }

  async disablePlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    if (plugin.status !== PluginStatus.ENABLED) {
      return; // Not enabled
    }

    try {
      const context = this.createPluginContext(plugin);

      if (plugin.instance?.onDisable) {
        await this.runLifecycle(pluginId, 'onDisable', () => plugin.instance!.onDisable!(context));
      }

      // Unregister all hooks for this plugin
      this.hookManager.unregisterPlugin(pluginId);

      plugin.status = PluginStatus.DISABLED;

      this.pluginStorage.setPluginStatus(pluginId, PluginStatus.DISABLED);

      this.logger.log(`Plugin disabled: ${plugin.manifest.name}`, {
        pluginId,
        action: 'plugin_disabled',
      });
    } catch (error) {
      plugin.status = PluginStatus.ERROR;
      plugin.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    // Disable first if enabled
    if (plugin.status === PluginStatus.ENABLED) {
      await this.disablePlugin(pluginId);
    }

    // Call onUnload
    if (plugin.instance?.onUnload) {
      const context = this.createPluginContext(plugin);
      await this.runLifecycle(pluginId, 'onUnload', () => plugin.instance!.onUnload!(context));
    }

    this.plugins.delete(pluginId);

    this.logger.log(`Plugin unloaded: ${plugin.manifest.name}`, {
      pluginId,
      action: 'plugin_unloaded',
    });
  }

  updatePluginConfig(pluginId: string, config: Record<string, unknown>): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    plugin.config = { ...plugin.config, ...config };

    // Persist config
    this.pluginStorage.setPluginConfig(pluginId, plugin.config);

    // Notify plugin of config change (async, fire and forget)
    if (plugin.instance?.onConfigChange && plugin.status === PluginStatus.ENABLED) {
      const context = this.createPluginContext(plugin);
      void this.runLifecycle(pluginId, 'onConfigChange', () =>
        plugin.instance!.onConfigChange!(context, plugin.config),
      ).catch(error => {
        this.logger.error(
          `Plugin ${pluginId} onConfigChange failed`,
          error instanceof Error ? error.message : String(error),
          { pluginId, action: 'plugin_config_change_failed' },
        );
      });
    }

    this.logger.debug(`Plugin config updated: ${pluginId}`, {
      pluginId,
      action: 'plugin_config_updated',
    });
  }

  /**
   * Resolve the absolute path to a plugin's entry module, guaranteeing the
   * resolved path stays inside that plugin's own directory.
   *
   * `manifest.main` comes from an on-disk, potentially attacker-controlled
   * JSON file. Passing it unchecked to require() allows path traversal
   * (e.g. "../../../etc/evil.js") and arbitrary code execution. We resolve
   * against the plugin root and reject anything that escapes it.
   */
  private resolvePluginMainPath(pluginId: string, main: string): string {
    const pluginRoot = path.resolve(this.pluginsDir, pluginId);
    const resolved = path.resolve(pluginRoot, main);

    // Containment check: resolved must equal pluginRoot or be a descendant.
    // Compare with a trailing separator to avoid sibling-prefix bypass
    // (e.g. "/plugins/foo-evil" vs root "/plugins/foo").
    const rootWithSep = pluginRoot.endsWith(path.sep) ? pluginRoot : pluginRoot + path.sep;
    if (resolved !== pluginRoot && !resolved.startsWith(rootWithSep)) {
      throw new Error(
        `Plugin ${pluginId} manifest.main "${main}" resolves outside the plugin directory; refusing to load`,
      );
    }

    return resolved;
  }

  /**
   * Run a plugin lifecycle method under a timeout, feeding the breaker.
   * Lifecycle and hook failures share one per-plugin failure budget by design:
   * a plugin misbehaving in either path counts toward the same trip threshold.
   */
  private async runLifecycle(pluginId: string, label: string, fn: () => Promise<void>): Promise<void> {
    if (this.breaker.isTripped(pluginId)) {
      throw new Error(`Plugin ${pluginId} is disabled by the circuit breaker`);
    }
    try {
      await withTimeout(fn(), this.lifecycleTimeoutMs, `${pluginId}:${label}`);
      this.breaker.recordSuccess(pluginId);
    } catch (error) {
      const justTripped = this.breaker.recordFailure(pluginId);
      if (justTripped) {
        this.logger.warn(`Plugin ${pluginId} tripped the circuit breaker; removing its hooks`);
        this.hookManager.unregisterPlugin(pluginId);
      }
      throw error;
    }
  }

  private createPluginContext(plugin: PluginInstance): PluginContext {
    const pluginId = plugin.manifest.id;
    const declared = plugin.manifest.permissions;
    // Absent permissions => permissive (all granted) + warning. Present => strict.
    const has = (p: PluginPermission): boolean => declared === undefined || declared.includes(p);
    if (declared === undefined) {
      this.logger.warn(`Plugin ${pluginId} declares no permissions; granting all (declare 'permissions' in manifest)`, {
        pluginId,
        action: 'plugin_permissions_absent',
      });
    }
    // Audit-only capabilities (not runtime-enforced).
    const auditOnly = (['net', 'fs:read', 'fs:write'] as PluginPermission[]).filter(p => declared?.includes(p));
    if (auditOnly.length) {
      this.logger.log(`Plugin ${pluginId} declares audit-only capabilities: ${auditOnly.join(', ')}`, {
        pluginId,
        action: 'plugin_permissions_audit',
      });
    }

    // Secret redaction: collect config values for keys marked secret.
    const secretValues = Object.entries(plugin.manifest.configSchema?.properties ?? {})
      .filter(([, schema]) => schema.secret)
      .map(([key]) => plugin.config[key])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const redact = (msg: string): string => secretValues.reduce((acc, secret) => acc.split(secret).join('***'), msg);
    const redactMeta = (meta?: Record<string, unknown>): Record<string, unknown> | undefined => {
      if (!meta || secretValues.length === 0) return meta;
      const walk = (val: unknown): unknown => {
        if (typeof val === 'string') return redact(val);
        if (Array.isArray(val)) return val.map(walk);
        if (val && typeof val === 'object') {
          return Object.fromEntries(Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
        }
        return val;
      };
      return walk(meta) as Record<string, unknown>;
    };

    const pluginLogger: PluginLogger = {
      log: (message, meta) => this.logger.log(`[${pluginId}] ${redact(message)}`, { ...redactMeta(meta), pluginId }),
      debug: (message, meta) =>
        this.logger.debug(`[${pluginId}] ${redact(message)}`, { ...redactMeta(meta), pluginId }),
      warn: (message, meta) => this.logger.warn(`[${pluginId}] ${redact(message)}`, { ...redactMeta(meta), pluginId }),
      error: (message, error, meta) =>
        this.logger.error(
          `[${pluginId}] ${redact(message)}`,
          redact(error instanceof Error ? error.message : String(error)),
          { ...redactMeta(meta), pluginId },
        ),
    };

    // Storage gated by 'storage' permission.
    const storage = has('storage')
      ? this.pluginStorage.createPluginStorage(pluginId)
      : {
          get: () => Promise.reject(new PluginPermissionDeniedError(pluginId, 'storage')),
          set: () => Promise.reject(new PluginPermissionDeniedError(pluginId, 'storage')),
          delete: () => Promise.reject(new PluginPermissionDeniedError(pluginId, 'storage')),
          list: () => Promise.reject(new PluginPermissionDeniedError(pluginId, 'storage')),
        };

    const context: PluginContext = {
      pluginId,
      manifest: plugin.manifest,
      config: Object.freeze({ ...plugin.config }),
      logger: pluginLogger,
      storage,
      registerHook: (event, handler, priority) => {
        if (!has('hooks')) {
          this.logger.warn(`Plugin ${pluginId} called registerHook without 'hooks' permission`, {
            pluginId,
            action: 'plugin_hook_denied',
          });
          return;
        }
        this.hookManager.register(pluginId, event, handler, priority);
      },
      getService: <T>(): T | undefined => {
        if (!has('services')) {
          this.logger.warn(`Plugin ${pluginId} requested a service without 'services' permission`, {
            pluginId,
            action: 'plugin_service_denied',
          });
          return undefined;
        }
        // Service registry not yet implemented — returns undefined even when granted.
      },
    };

    return Object.freeze(context);
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  getPlugin(pluginId: string): PluginInstance | undefined {
    return this.plugins.get(pluginId);
  }

  getAllPlugins(): PluginInstance[] {
    return Array.from(this.plugins.values());
  }

  getPluginsByType(type: PluginType): PluginInstance[] {
    return this.getAllPlugins().filter(p => p.manifest.type === type);
  }

  getEnabledPlugins(): PluginInstance[] {
    return this.getAllPlugins().filter(p => p.status === PluginStatus.ENABLED);
  }

  isPluginEnabled(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    return plugin?.status === PluginStatus.ENABLED;
  }

  // ============================================================================
  // Built-in Plugin Registration (for Phase 4)
  // ============================================================================

  registerBuiltInPlugin(manifest: PluginManifest, instance: IPlugin): void {
    const pluginInstance: PluginInstance = {
      manifest,
      status: PluginStatus.INSTALLED,
      config: {},
      instance,
      loadedAt: new Date(),
    };

    this.plugins.set(manifest.id, pluginInstance);

    this.logger.debug(`Built-in plugin registered: ${manifest.name}`, {
      pluginId: manifest.id,
      action: 'builtin_plugin_registered',
    });
  }
}
