import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../common/services/logger.service';
import { HookManager, HookEvent, KNOWN_HOOK_EVENTS, isKnownHookEvent } from '../hooks';
import {
  PluginCapabilityError,
  PluginCapabilityPermission,
  PluginEngineReadCapability,
  PluginManifest,
  PluginMessagingCapability,
  PluginNetCapability,
  PluginInstance,
  PluginStatus,
  PluginContext,
  IPlugin,
  PluginType,
  PluginLogger,
} from './plugin.interfaces';
import { isNetHostAllowed, performPluginFetch } from './plugin-net';
import { PluginStorageService } from './plugin-storage.service';
import { isPluginActiveForSession, resolvePluginConfig } from './plugin-activation';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { WorkerThreadChannel } from './sandbox/worker-thread-channel';
import { dispatchCapabilityVerb } from './sandbox/capability-router';
import { PluginLogLevel } from './sandbox/protocol';
import type { MessageService } from '../../modules/message/message.service';
import type { SessionService } from '../../modules/session/session.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';

/** Default per-plugin heap cap for the sandbox worker; an OOM terminates the worker, not the host. */
const SANDBOX_MAX_OLD_GEN_MB = 256;
/** Time budget for a sandboxed plugin's hook handler before the chain proceeds without it. */
const SANDBOX_HOOK_TIMEOUT_MS = 5000;
/** A sandboxed plugin's healthCheck must answer within this, else it's reported unhealthy (not hung). */
const SANDBOX_HEALTH_TIMEOUT_MS = 5000;
/**
 * A sandboxed plugin's load()/onLoad/onEnable/onDisable must complete within this, else the worker is
 * torn down and the operation fails — a wedged lifecycle can't hang the enable/disable request (and
 * the ADMIN HTTP call behind it) forever. Generous on purpose: a slow-but-valid onEnable that opens
 * connections should still finish well under it.
 */
const SANDBOX_LIFECYCLE_TIMEOUT_MS = 30000;

/**
 * Max concurrent worker-initiated capability calls per sandboxed plugin. A burst beyond this is rejected
 * (the plugin sees a thrown Error) rather than amplified into unbounded host-side sends/fetches/writes.
 */
const SANDBOX_MAX_INFLIGHT_CAPS = 32;

/**
 * Host process.env keys an untrusted plugin worker is allowed to see. Everything else — secrets like
 * API_MASTER_KEY, API_KEY_PEPPER, the DATABASE_/REDIS_ vars, DOCKER_HOST — is withheld. The worker is
 * a thread, so it needs no PATH to start and require() resolves via module paths, not env.
 */
const SANDBOX_ENV_ALLOWLIST = ['NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'TZ'] as const;

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

/**
 * Build the minimal, allowlisted env for an untrusted plugin worker so it never inherits host secrets.
 * Only {@link SANDBOX_ENV_ALLOWLIST} keys are forwarded (unset keys are omitted, not emitted as
 * `undefined`), and NODE_ENV defaults to 'production' when the host has none.
 */
export function buildSandboxWorkerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.NODE_ENV = source.NODE_ENV ?? 'production';
  return env;
}

@Injectable()
export class PluginLoaderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('PluginLoaderService');
  private readonly plugins = new Map<string, PluginInstance>();
  /** Plugin ids whose enable() is in flight — a synchronous lock so concurrent enables can't double-run. */
  private readonly enabling = new Set<string>();
  // Live worker host per enabled sandboxed (untrusted) plugin. Built-ins are not in here.
  private readonly sandboxHosts = new Map<string, PluginWorkerHost>();
  // Carries the firing event's sessionId across an in-process hook handler so ctx.config (a getter)
  // resolves the per-session slice. Per async call tree, so concurrent sessions don't cross over.
  private readonly hookSession = new AsyncLocalStorage<{ sessionId?: string }>();
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

  /**
   * Graceful shutdown (SIGTERM → app.close()): run onDisable for every enabled plugin so it can flush
   * buffers, close connections, and persist state. Previously onDisable only ran via the REST disable
   * and uninstall paths, so a normal restart/deploy/scale-down skipped it and stateful plugins lost
   * in-flight work. Best-effort and sequential: one plugin's failure must not block the others.
   */
  async onModuleDestroy(): Promise<void> {
    const enabled = this.getAllPlugins().filter(p => p.status === PluginStatus.ENABLED);
    for (const plugin of enabled) {
      try {
        await this.disablePlugin(plugin.manifest.id);
      } catch (error) {
        this.logger.error(
          `Failed to disable plugin ${plugin.manifest.id} during shutdown`,
          error instanceof Error ? error.message : String(error),
          { pluginId: plugin.manifest.id, action: 'plugin_shutdown_disable_failed' },
        );
      }
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
      // Skip non-directories and dot-prefixed dirs (e.g. a crash-leftover `.<id>.bak` update backup),
      // so a half-finished update can't be re-loaded as a duplicate-id plugin on the next boot.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

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

    // Load any persisted config + per-session activation + per-session config so an operator's choices
    // survive a restart.
    const storedConfig = this.pluginStorage.getPluginConfig(manifest.id) ?? {};
    const storedSessions = this.pluginStorage.getPluginSessions(manifest.id) ?? undefined;
    const storedSessionConfig = this.pluginStorage.getPluginSessionConfig(manifest.id) ?? undefined;

    const pluginInstance: PluginInstance = {
      manifest,
      status: PluginStatus.INSTALLED,
      config: storedConfig,
      instance: null,
      loadedAt: new Date(),
      builtIn: false,
      activeSessions: storedSessions,
      sessionConfig: storedSessionConfig,
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
      // setPluginEntry REPLACES the entry, so the operator's per-session activation + config must be
      // carried over or every boot wipes them from disk (lost after the second restart).
      activeSessions: existing?.activeSessions,
      sessionConfig: existing?.sessionConfig,
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

    // Engines are mutually exclusive and pinned to the deployment's engine.type config (the factory
    // reads that, not plugin status). Enabling a second engine at runtime would show two "active"
    // engines and desync the factory, so reject anything but the configured active engine.
    if (plugin.manifest.type === PluginType.ENGINE) {
      const activeEngine = this.configService.get<string>('engine.type') ?? 'whatsapp-web.js';
      if (pluginId !== activeEngine) {
        throw new Error(
          `Engine "${pluginId}" is not the active engine ("${activeEngine}"). Set engine.type and restart to switch engines.`,
        );
      }
    }

    // Concurrency guard: status flips to ENABLED only AFTER the awaits below, so two concurrent enable
    // calls would both pass the check above, both run onEnable, and both register the plugin's hooks
    // (duplicate side effects). Claim the enable synchronously here so a racing caller is rejected
    // before any await; released in finally.
    if (this.enabling.has(pluginId)) {
      throw new Error(`Plugin ${pluginId} is already being enabled`);
    }
    this.enabling.add(pluginId);

    try {
      if (plugin.builtIn === false) {
        await this.enableSandboxed(pluginId, plugin);
      } else {
        await this.enableInProcess(pluginId, plugin);
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

      // A plugin that subscribed hooks before its onLoad/onEnable threw would otherwise leave those
      // registrations live: a later successful enable re-registers them, so each event then dispatches
      // to the plugin once per failed attempt. Drop them here. Safe on this path only — an
      // already-enabled plugin returns early above, so the catch only runs for an enable that never
      // went live, which owns no hooks worth keeping. (Idempotent: no-ops when none were registered.)
      this.hookManager.unregisterPlugin(pluginId);

      throw error;
    } finally {
      this.enabling.delete(pluginId);
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
      const host = this.sandboxHosts.get(pluginId);
      if (host) {
        // Disable is a force-teardown: even if the plugin's onDisable hangs (now bounded) or throws,
        // we still kill the worker and drop the reference, so a misbehaving plugin can never block a
        // disable or leak its worker thread.
        try {
          await host.runLifecycle('onDisable', SANDBOX_LIFECYCLE_TIMEOUT_MS);
        } catch (error) {
          this.logger.warn(`Sandboxed plugin ${pluginId} onDisable failed during disable; terminating anyway`, {
            pluginId,
            action: 'sandbox_disable_lifecycle_failed',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await host.terminate().catch(() => undefined);
        this.sandboxHosts.delete(pluginId);
      } else {
        const context = this.createPluginContext(plugin);
        if (plugin.instance?.onDisable) {
          await plugin.instance.onDisable(context);
        }
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

  /** Absolute path of the directory user plugins are loaded from (used by install/uninstall). */
  getPluginsDir(): string {
    return this.pluginsDir;
  }

  /** Whether a plugin is a first-party built-in (engine / bundled extension) vs an installed user plugin. */
  isBuiltIn(pluginId: string): boolean {
    return this.pluginStorage.getPluginEntry(pluginId)?.builtIn ?? false;
  }

  /**
   * Fully remove an installed user plugin: disable + unload from the runtime, drop its persisted
   * registry entry, and delete its directory from disk. Built-ins (engines, bundled extensions) are
   * registered programmatically with no on-disk dir and must never be removable.
   */
  async uninstallPlugin(pluginId: string): Promise<void> {
    if (this.pluginStorage.getPluginEntry(pluginId)?.builtIn) {
      throw new Error(`Cannot uninstall built-in plugin ${pluginId}`);
    }

    if (this.plugins.has(pluginId)) {
      await this.unloadPlugin(pluginId);
    }
    this.pluginStorage.deletePluginEntry(pluginId);

    // Delete the plugin's directory, guarding against a traversal id escaping the plugins dir.
    const base = path.resolve(this.pluginsDir);
    const dir = path.resolve(base, pluginId);
    if (dir !== base && dir.startsWith(base + path.sep) && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    this.logger.log(`Plugin uninstalled: ${pluginId}`, { pluginId, action: 'plugin_uninstalled' });
  }

  updatePluginConfig(pluginId: string, config: Record<string, unknown>): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    plugin.config = { ...plugin.config, ...config };

    // Persist config
    this.pluginStorage.setPluginConfig(pluginId, plugin.config);

    // Notify the running plugin of the config change (fire and forget). A sandboxed plugin's
    // onConfigChange lives in the worker (plugin.instance is null), so route it through the live worker
    // host so it refreshes ctx.config too; built-ins go through the in-process instance.
    if (plugin.status === PluginStatus.ENABLED) {
      const sandboxHost = this.sandboxHosts.get(pluginId);
      if (sandboxHost) {
        sandboxHost.sendConfigChange(plugin.config);
      } else if (plugin.instance?.onConfigChange) {
        const context = this.createPluginContext(plugin);
        void plugin.instance.onConfigChange(context, plugin.config);
      }
    }

    this.logger.debug(`Plugin config updated: ${pluginId}`, {
      pluginId,
      action: 'plugin_config_updated',
    });
  }

  /**
   * Set the sessions a session-scoped plugin is activated for. `['*']` = all numbers (system-wide),
   * an explicit list scopes it to those sessions, `[]` deactivates it everywhere. Takes effect on the
   * next hook event (the gate reads plugin.activeSessions live) and survives a restart.
   */
  setPluginSessions(pluginId: string, sessions: string[]): PluginInstance {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    if (plugin.manifest.sessionScoped === false) {
      throw new Error(`Plugin ${pluginId} is global (not session-scoped) and cannot be activated per session`);
    }

    plugin.activeSessions = sessions;
    this.pluginStorage.setPluginSessions(pluginId, sessions);

    this.logger.log(`Plugin active sessions updated: ${pluginId}`, {
      pluginId,
      action: 'plugin_sessions_updated',
      sessions,
    });
    return plugin;
  }

  /**
   * Set (or clear) a plugin's per-session config override for `sessionId`. Hooks for that session then
   * see the override shallow-merged over the base via ctx.config — applied on the next event
   * (resolution reads plugin.sessionConfig live) and persisted across restart. An empty override
   * removes it (the session falls back to the base). Global plugins have no per-session config.
   */
  setPluginSessionConfig(pluginId: string, sessionId: string, config: Record<string, unknown>): PluginInstance {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    if (plugin.manifest.sessionScoped === false) {
      throw new Error(`Plugin ${pluginId} is global (not session-scoped) and has no per-session config`);
    }

    const next = { ...(plugin.sessionConfig ?? {}) };
    if (config && Object.keys(config).length > 0) {
      next[sessionId] = config;
    } else {
      delete next[sessionId];
    }
    plugin.sessionConfig = next;
    this.pluginStorage.setPluginSessionConfig(pluginId, next);

    this.logger.debug(`Plugin session config updated: ${pluginId}`, {
      pluginId,
      action: 'plugin_session_config_updated',
      sessionId,
    });
    return plugin;
  }

  /**
   * Run a plugin's healthCheck across both tiers. A sandboxed plugin's healthCheck lives in the worker
   * (plugin.instance is null), so route to the live worker host (time-bounded); built-ins use the
   * in-process instance. Returns the default "healthy" when the plugin implements no health check.
   */
  async checkPluginHealth(pluginId: string): Promise<{ healthy: boolean; message?: string }> {
    const sandboxHost = this.sandboxHosts.get(pluginId);
    if (sandboxHost) {
      return sandboxHost.healthCheck(SANDBOX_HEALTH_TIMEOUT_MS);
    }
    const plugin = this.plugins.get(pluginId);
    if (plugin?.instance?.healthCheck) {
      return plugin.instance.healthCheck();
    }
    return { healthy: true, message: 'Plugin does not implement health check' };
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

  /** Per-session activation gate: is this plugin currently activated for `sessionId`'s event? */
  private isHookActive(plugin: PluginInstance, sessionId: string | undefined): boolean {
    return isPluginActiveForSession(plugin.manifest.sessionScoped ?? true, plugin.activeSessions ?? ['*'], sessionId);
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

  /**
   * Build a worker host for a sandboxed (untrusted) plugin. Overridable so tests can inject a fake
   * instead of spawning a real OS thread. Production loads the compiled worker bootstrap from dist.
   */
  protected createSandboxHost(
    capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
    onHookSubscribe?: (event: string, priority?: number) => void,
    onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
    runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
  ): PluginWorkerHost {
    const workerEntry = path.join(__dirname, 'sandbox', 'worker-bootstrap.js');
    return new PluginWorkerHost(
      new WorkerThreadChannel({
        workerEntry,
        maxOldGenerationSizeMb: SANDBOX_MAX_OLD_GEN_MB,
        // Withhold host secrets: the worker gets a minimal allowlisted env, not a copy of process.env.
        env: buildSandboxWorkerEnv(),
      }),
      capDispatcher,
      onHookSubscribe,
      onLog,
      runWithHookGuard,
      SANDBOX_MAX_INFLIGHT_CAPS,
    );
  }

  /** Built-in (trusted) enable: require + run the lifecycle in-process with the live capability context. */
  private async enableInProcess(pluginId: string, plugin: PluginInstance): Promise<void> {
    const context = this.createPluginContext(plugin);

    if (!plugin.instance) {
      // Containment guard: reject a manifest.main that escapes the plugin dir.
      const mainPath = resolvePluginMainPath(this.pluginsDir, pluginId, plugin.manifest.main);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pluginModule = require(mainPath) as { default?: new () => IPlugin };
      if (pluginModule.default) {
        plugin.instance = new pluginModule.default();
      } else {
        throw new Error(`Plugin ${pluginId} does not export a default class`);
      }
    }

    if (plugin.instance.onLoad) {
      await plugin.instance.onLoad(context);
    }
    if (plugin.instance.onEnable) {
      await plugin.instance.onEnable(context);
    }
  }

  /**
   * Untrusted enable: load the plugin in an isolated worker and drive its lifecycle there. Capability
   * calls and hooks round-trip to the host, which enforces permission + session scope. A failure
   * tears the worker back down.
   */
  private async enableSandboxed(pluginId: string, plugin: PluginInstance): Promise<void> {
    // Containment guard: reject a manifest.main that escapes the plugin dir.
    const mainPath = resolvePluginMainPath(this.pluginsDir, pluginId, plugin.manifest.main);
    // The capability dispatcher runs a worker request through the SAME context an in-process plugin
    // gets, so permission + session-scope checks (assertPermission / assertSessionAllowed) apply
    // identically. The worker can only ask; the host is the gatekeeper.
    const context = this.createPluginContext(plugin);

    // When the worker subscribes to a hook, register a shim with the hook manager that dispatches the
    // event into the worker (time-bounded, so a wedged plugin can't stall the chain). The shim looks
    // the host up at fire time, so disabling the plugin (which removes it + unregisters hooks) stops it.
    // Harden the IPC boundary against an untrusted worker flooding the host hook registry. HookEvent is
    // a type-only union and the wire payload is an arbitrary string, so a hostile/buggy worker can post
    // 'hook-subscribe' with (a) the same event repeatedly and (b) unbounded fabricated event names
    // ('x:0','x:1',…). Without guards each call adds a live host-side registration (unbounded host-heap
    // growth + an O(n log n) re-sort). Three guards, all local to this enableSandboxed call (dropped on
    // disable): reject unknown events (bounds growth to the finite known set + drops events that can
    // never fire), dedup per event, and a belt-and-suspenders size cap.
    const subscribedEvents = new Set<HookEvent>();
    let unknownEventWarned = false;
    const onHookSubscribe = (event: string, priority?: number): void => {
      if (!isKnownHookEvent(event)) {
        if (!unknownEventWarned) {
          unknownEventWarned = true; // warn at most once per plugin so a flood isn't a log-flood vector
          this.logger.warn(`Sandboxed plugin ${pluginId} subscribed to an unknown hook event; ignoring`, {
            pluginId,
            event,
            action: 'sandbox_unknown_hook_event',
          });
        }
        return;
      }
      if (subscribedEvents.has(event)) return;
      if (subscribedEvents.size >= KNOWN_HOOK_EVENTS.size) return; // can't exceed the known set
      subscribedEvents.add(event);
      this.hookManager.register(
        pluginId,
        event,
        async hookCtx => {
          const liveHost = this.sandboxHosts.get(pluginId);
          if (!liveHost) return { continue: true };
          // Per-session activation gate: a session-scoped plugin only sees events for the sessions
          // it is activated for. Pass-through (don't dispatch into the worker) otherwise.
          if (!this.isHookActive(plugin, hookCtx.sessionId)) return { continue: true };
          return liveHost
            .dispatchHook({
              event,
              data: hookCtx.data,
              sessionId: hookCtx.sessionId,
              source: hookCtx.source,
              // The host resolves the per-session slice (real secrets — the worker is the plugin's
              // trusted execution context) and ships it; the worker exposes it as ctx.config.
              config: resolvePluginConfig(
                plugin.config,
                plugin.sessionConfig,
                hookCtx.sessionId,
                plugin.manifest.sessionScoped !== false,
              ),
              timeoutMs: SANDBOX_HOOK_TIMEOUT_MS,
              onTimeout: () =>
                this.logger.warn(`Sandboxed plugin ${pluginId} hook '${event}' timed out`, {
                  pluginId,
                  event,
                  action: 'sandbox_hook_timeout',
                }),
            })
            .then(result => ({ continue: result.continue, data: result.data }));
        },
        priority,
      );
    };

    // Route the worker plugin's ctx.logger.* calls to the same per-plugin logger an in-process plugin
    // uses, so sandboxed plugins log identically (prefixed + structured) instead of bare stdout.
    const onLog = (level: PluginLogLevel, message: string, meta?: Record<string, unknown>): void => {
      if (level === 'error') context.logger.error(message, undefined, meta);
      else context.logger[level](message, meta);
    };

    const host = this.createSandboxHost(
      (verb, args) => dispatchCapabilityVerb(context, verb, args),
      onHookSubscribe,
      onLog,
      // Re-establish the in-flight hook context for worker-initiated capability calls, so a sandboxed
      // plugin that sends from within a send hook can't loop the event back into itself unboundedly.
      (events, run) => this.hookManager.runInFlight(events as HookEvent[], run),
    );
    this.sandboxHosts.set(pluginId, host);
    try {
      await host.load(mainPath, { pluginId, config: plugin.config }, SANDBOX_LIFECYCLE_TIMEOUT_MS);
      await host.runLifecycle('onLoad', SANDBOX_LIFECYCLE_TIMEOUT_MS);
      await host.runLifecycle('onEnable', SANDBOX_LIFECYCLE_TIMEOUT_MS);
    } catch (error) {
      this.sandboxHosts.delete(pluginId);
      await host.terminate().catch(() => undefined);
      throw error;
    }
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

    const hookSession = this.hookSession;
    return {
      pluginId: plugin.manifest.id,
      manifest: plugin.manifest,
      // Per-session: inside a hook, returns the override merged over the base for the firing session;
      // outside a hook (lifecycle), the base config. A getter so it reflects live config edits too.
      get config() {
        return resolvePluginConfig(
          plugin.config,
          plugin.sessionConfig,
          hookSession.getStore()?.sessionId,
          plugin.manifest.sessionScoped !== false,
        );
      },
      hookManager: this.hookManager,
      logger: pluginLogger,
      storage: this.pluginStorage.createPluginStorage(plugin.manifest.id),
      registerHook: (event, handler, priority) => {
        // Wrap with the per-session activation gate so an in-process plugin only handles events for
        // the sessions it is activated for (mirrors the sandboxed shim), and scope the firing
        // sessionId so ctx.config resolves the right per-session slice for the handler.
        this.hookManager.register(
          plugin.manifest.id,
          event,
          async hookCtx => {
            if (!this.isHookActive(plugin, hookCtx.sessionId)) return { continue: true };
            return this.hookSession.run({ sessionId: hookCtx.sessionId }, () => handler(hookCtx));
          },
          priority,
        );
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
      net: {
        fetch: async (url, init) => {
          // Two gates: the declared permission, then the manifest host allowlist. The SSRF guard
          // inside performPluginFetch still blocks internal IPs even when the host is allowlisted.
          this.assertPermission(plugin.manifest, PluginCapabilityPermission.NET_FETCH);
          if (!isNetHostAllowed(plugin.manifest.net?.allow, url)) {
            throw new PluginCapabilityError(
              `Plugin ${plugin.manifest.id} may not fetch ${url} — add its host to the manifest net.allow list`,
            );
          }
          return performPluginFetch(url, init);
        },
      } satisfies PluginNetCapability,
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
      builtIn: true,
      // Read persisted per-session activation + config back into the runtime, like loadPlugin —
      // otherwise the delivery gate falls back to all-sessions/base-config after every restart for a
      // session-scoped built-in the operator had restricted.
      activeSessions: this.pluginStorage.getPluginSessions(manifest.id) ?? undefined,
      sessionConfig: this.pluginStorage.getPluginSessionConfig(manifest.id) ?? undefined,
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
