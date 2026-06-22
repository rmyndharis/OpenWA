import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../hooks';
import {
  PluginCapabilityError,
  PluginCapabilityPermission,
  PluginEngineReadCapability,
  PluginManifest,
  PluginMessagingCapability,
  PluginInstance,
  PluginStatus,
  PluginContext,
  IPlugin,
  PluginType,
  PluginLogger,
} from './plugin.interfaces';
import { PluginStorageService } from './plugin-storage.service';
import type { MessageService } from '../../modules/message/message.service';
import type { SessionService } from '../../modules/session/session.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * Resolve a plugin's `main` entry to an absolute path, asserting it stays inside
 * <pluginsDir>/<pluginId>. `main` comes from a user-supplied manifest, so a
 * value like '../../etc/passwd' (or an absolute path) must be rejected BEFORE require().
 */
export function resolvePluginMainPath(pluginsDir: string, pluginId: string, main: string): string {
  const base = path.resolve(pluginsDir, pluginId);
  const mainPath = path.resolve(base, main);
  if (mainPath !== base && !mainPath.startsWith(base + path.sep)) {
    throw new Error(`Plugin ${pluginId} main path escapes the plugin directory`);
  }
  return mainPath;
}

@Injectable()
export class PluginLoaderService implements OnModuleInit {
  private readonly logger = createLogger('PluginLoaderService');
  private readonly plugins = new Map<string, PluginInstance>();
  private readonly pluginsDir: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    private readonly pluginStorage: PluginStorageService,
    // Resolves MessageService/SessionService lazily inside capability verbs. ModuleRef is used
    // instead of constructor injection to avoid the provider cycle
    // PluginLoaderService -> SessionService -> EngineFactory -> PluginLoaderService.
    private readonly moduleRef: ModuleRef,
  ) {
    this.pluginsDir = this.configService.get<string>('plugins.dir') ?? './plugins';
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

    // Load any persisted config so an operator's settings survive a restart.
    const storedConfig = this.pluginStorage.getPluginConfig(manifest.id) ?? {};

    const pluginInstance: PluginInstance = {
      manifest,
      status: PluginStatus.INSTALLED,
      config: storedConfig,
      instance: null,
      loadedAt: new Date(),
    };

    this.plugins.set(manifest.id, pluginInstance);

    // Ensure a registry entry exists so later enable/disable/config writes persist.
    this.ensureRegistryEntry(manifest, false);

    this.logger.log(`Plugin loaded: ${manifest.name} v${manifest.version}`, {
      pluginId: manifest.id,
      type: manifest.type,
      action: 'plugin_loaded',
    });

    return pluginInstance;
  }

  /**
   * Ensure a freshly-loaded plugin has a persisted registry entry, so later enable/disable/config
   * writes (which only update an EXISTING entry) actually persist instead of silently no-op'ing.
   * Creates a complete INSTALLED entry when none exists; an existing entry's persisted status/config
   * is left untouched. Best-effort (saveRegistry swallows fs errors, so a disk failure never turns a
   * load into a 500). Does NOT enable or run the plugin — boot never auto-executes plugin code.
   */
  private ensureRegistryEntry(manifest: PluginManifest, builtIn: boolean): void {
    // Reconcile the persisted entry with the freshly-loaded runtime: the runtime always loads
    // INSTALLED and is never auto-enabled on boot (enabling must stay an explicit ADMIN action that
    // runs the lifecycle), so the entry's status is (re)set to INSTALLED to match — a previously
    // enabled plugin must be re-enabled after a restart. The operator's persisted config is preserved
    // so secrets/settings survive. Best-effort: saveRegistry swallows fs errors, so a disk failure
    // never turns a load into a 500.
    const existing = this.pluginStorage.getPluginEntry(manifest.id);
    this.pluginStorage.setPluginEntry({
      id: manifest.id,
      type: manifest.type,
      name: manifest.name,
      version: manifest.version,
      status: PluginStatus.INSTALLED,
      config: existing?.config ?? {},
      builtIn,
      installedAt: existing?.installedAt ?? new Date(),
      updatedAt: new Date(),
    });
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
        // Containment guard: reject a manifest.main that escapes the plugin dir.
        const mainPath = resolvePluginMainPath(this.pluginsDir, pluginId, plugin.manifest.main);
        // Dynamic require for user plugins
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
        await plugin.instance.onLoad(context);
      }

      if (plugin.instance.onEnable) {
        await plugin.instance.onEnable(context);
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
        await plugin.instance.onDisable(context);
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
      await plugin.instance.onUnload(context);
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
      void plugin.instance.onConfigChange(context, plugin.config);
    }

    this.logger.debug(`Plugin config updated: ${pluginId}`, {
      pluginId,
      action: 'plugin_config_updated',
    });
  }

  /**
   * Resolve MessageService at call time via a lazy require so plugin-loader creates NO top-level
   * module-load edge to message.service. A static import closes the cycle
   * plugin-loader -> message -> session -> engine.factory -> core/plugins barrel -> plugin-loader,
   * which corrupts MessageService's constructor paramtype metadata (SessionService -> undefined) at boot.
   */
  private getMessageService(): MessageService {
    const mod =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../modules/message/message.service') as typeof import('../../modules/message/message.service');
    return this.moduleRef.get(mod.MessageService, { strict: false });
  }

  private getSessionService(): SessionService {
    const mod =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../modules/session/session.service') as typeof import('../../modules/session/session.service');
    return this.moduleRef.get(mod.SessionService, { strict: false });
  }

  /**
   * Enforce a plugin's declared manifest permissions at the capability boundary. A plugin may only
   * use a capability whose permission string it declares in `manifest.permissions`; anything else
   * (including a manifest with no permissions) is denied. Runs first in each capability verb so a
   * missing grant fails fast and uniformly as a PluginCapabilityError.
   */
  private assertPermission(manifest: PluginManifest, permission: PluginCapabilityPermission): void {
    if (!(manifest.permissions ?? []).includes(permission)) {
      throw new PluginCapabilityError(
        `Plugin ${manifest.id} is missing the '${permission}' permission required for this capability`,
      );
    }
  }

  /**
   * Enforce a plugin's manifest session scope. Runs BEFORE any engine/message resolution —
   * sessionId is supplied by the plugin, so this is the security boundary. Absent = ['*'].
   */
  private assertSessionAllowed(manifest: PluginManifest, sessionId: string): void {
    const allowed = manifest.sessions ?? ['*'];
    if (!allowed.includes('*') && !allowed.includes(sessionId)) {
      throw new PluginCapabilityError(`Plugin ${manifest.id} is not permitted to act on session ${sessionId}`);
    }
  }

  /**
   * Scope-check, then resolve the live engine for a session. getEngine returns undefined for an
   * unknown OR unstarted session (no throw), so guard it into a defined PluginCapabilityError.
   * A present-but-not-READY engine throws EngineNotReadyError from the adapter on use (→ 409).
   */
  private resolveEngine(manifest: PluginManifest, sessionId: string): IWhatsAppEngine {
    this.assertSessionAllowed(manifest, sessionId);
    const engine = this.getSessionService().getEngine(sessionId);
    if (!engine) {
      throw new PluginCapabilityError(`Session ${sessionId} has no active engine (unknown or not started)`);
    }
    return engine;
  }

  /** Engine read capabilities: require the `engine:read` permission, then resolve the live engine. */
  private resolveEngineRead(manifest: PluginManifest, sessionId: string): IWhatsAppEngine {
    this.assertPermission(manifest, PluginCapabilityPermission.ENGINE_READ);
    return this.resolveEngine(manifest, sessionId);
  }

  private createPluginContext(plugin: PluginInstance): PluginContext {
    const pluginLogger: PluginLogger = {
      log: (message, meta) =>
        this.logger.log(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
      debug: (message, meta) =>
        this.logger.debug(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
      warn: (message, meta) =>
        this.logger.warn(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
      error: (message, error, meta) =>
        this.logger.error(
          `[${plugin.manifest.id}] ${message}`,
          error instanceof Error ? error.message : String(error),
          { ...meta, pluginId: plugin.manifest.id },
        ),
    };

    return {
      pluginId: plugin.manifest.id,
      manifest: plugin.manifest,
      config: plugin.config,
      hookManager: this.hookManager,
      logger: pluginLogger,
      storage: this.pluginStorage.createPluginStorage(plugin.manifest.id),
      registerHook: (event, handler, priority) => {
        this.hookManager.register(plugin.manifest.id, event, handler, priority);
      },
      messages: {
        sendText: async (sessionId, chatId, text) => {
          // Validate permission + scope + that the session has a live engine BEFORE MessageService
          // persists a pending row: a missing grant / dead session must fail with
          // PluginCapabilityError, not a raw TypeError + orphaned row. resolveEngine also runs
          // assertSessionAllowed.
          this.assertPermission(plugin.manifest, PluginCapabilityPermission.MESSAGES_SEND);
          this.resolveEngine(plugin.manifest, sessionId);
          return this.getMessageService().sendText(sessionId, { chatId, text });
        },
        reply: async (sessionId, chatId, quotedMessageId, text) => {
          this.assertPermission(plugin.manifest, PluginCapabilityPermission.MESSAGES_SEND);
          this.resolveEngine(plugin.manifest, sessionId);
          return this.getMessageService().reply(sessionId, { chatId, quotedMessageId, text });
        },
      } satisfies PluginMessagingCapability,
      engine: {
        getGroupInfo: async (sessionId, groupId) =>
          this.resolveEngineRead(plugin.manifest, sessionId).getGroupInfo(groupId),
        getContacts: async sessionId => this.resolveEngineRead(plugin.manifest, sessionId).getContacts(),
        getContactById: async (sessionId, contactId) =>
          this.resolveEngineRead(plugin.manifest, sessionId).getContactById(contactId),
        checkNumberExists: async (sessionId, phone) =>
          this.resolveEngineRead(plugin.manifest, sessionId).checkNumberExists(phone),
        getChats: async sessionId => this.resolveEngineRead(plugin.manifest, sessionId).getChats(),
      } satisfies PluginEngineReadCapability,
    };
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

  registerBuiltInPlugin(manifest: PluginManifest, instance: IPlugin, config: Record<string, unknown> = {}): void {
    // Merge: env-derived defaults stay live each boot (so a changed .env wins), while an operator's
    // persisted overrides win for the keys they actually set. Engine config is wholly env-derived
    // (no persisted overrides), so it is never frozen to a first-boot snapshot.
    const effectiveConfig = { ...config, ...(this.pluginStorage.getPluginConfig(manifest.id) ?? {}) };

    const pluginInstance: PluginInstance = {
      manifest,
      status: PluginStatus.INSTALLED,
      config: effectiveConfig,
      instance,
      loadedAt: new Date(),
    };

    this.plugins.set(manifest.id, pluginInstance);

    // Ensure a registry entry exists so later enable/disable/config writes persist.
    this.ensureRegistryEntry(manifest, true);

    this.logger.debug(`Built-in plugin registered: ${manifest.name}`, {
      pluginId: manifest.id,
      action: 'builtin_plugin_registered',
    });
  }
}
