import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../hooks';
import { IPlugin, PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { PluginStorageService, type RegistryWriteOptions } from './plugin-storage.service';
import { PluginHostServices } from './plugin-host-services';
import { PluginCapabilityContext } from './plugin-capability-context';
import { PluginSandboxBridge } from './plugin-sandbox-bridge';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { unregisterPluginSearchProvider } from './search-provider-registration.util';
import { resolvePluginMainPath } from './plugin-paths';
import { assertNotUninstalling } from './plugin-uninstaller';
import {
  deepMerge,
  redirectedHostKeys,
  restorableConfig,
  sanitizeSessionConfigsForBaseRedirect,
} from './plugin-activation';

/** Env-derived base config registered for each built-in PluginInstance, readable by config write helpers. */
const builtInBaseByPlugin = new WeakMap<PluginInstance, Record<string, unknown>>();

/** WeakRefs to live PluginLifecycle instances so durable async config updates resolve their owner without leaking. */
const activeLifecycles = new Set<WeakRef<PluginLifecycle>>();

/**
 * Thrown when persisting secret-stripping updates to `plugin_instances` fails before a base-host
 * redirect commits to registry.json, so the redirect aborts rather than persisting a split state.
 */
export class PluginInstanceSanitizationError extends Error {
  constructor(pluginId: string, cause: unknown) {
    super(
      `Failed to sanitize plugin instances for ${pluginId} before redirecting base host: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'PluginInstanceSanitizationError';
  }
}

/** Return the env-derived base config of a registered built-in plugin, or undefined for extensions. */
export function getBuiltInBaseConfig(plugin: PluginInstance): Record<string, unknown> | undefined {
  return builtInBaseByPlugin.get(plugin);
}

/**
 * Apply a base config update durably through the plugin's owning PluginLifecycle: any persisted
 * `plugin_instances` rows inheriting a redirected host key are sanitized in the database BEFORE
 * registry.json is written. Returns `false` when `plugin` does not belong to a live PluginLifecycle
 * (for example, in unit tests using a mocked PluginLoaderService).
 */
export async function updatePluginConfigDurable(
  plugin: PluginInstance,
  config: Record<string, unknown>,
  opts?: RegistryWriteOptions,
): Promise<boolean> {
  for (const ref of activeLifecycles) {
    const lifecycle = ref.deref();
    if (!lifecycle) {
      activeLifecycles.delete(ref);
      continue;
    }
    if (lifecycle.ownsPlugin(plugin)) {
      await lifecycle.updatePluginConfigDurable(plugin.manifest.id, config, opts);
      return true;
    }
  }
  return false;
}

/**
 * The runtime half of the plugin loader: everything that happens to a plugin AFTER the boot scan has
 * registered it — enable/disable/unload (routing untrusted plugins into the sandbox bridge, trusted
 * built-ins in-process), operator config and per-session activation writes, and programmatic
 * built-in registration.
 *
 * Split out of PluginLoaderService so the loader reads as the public facade while the lifecycle
 * state machine — status transitions, the enable concurrency lock, failure cleanup — is reviewed on
 * its own. A plain class, not a Nest provider: the loader constructs it in its constructor (the same
 * pattern as PluginSandboxBridge / PluginCapabilityContext), so the loader's public constructor
 * signature — which specs build directly — is unchanged.
 */
export class PluginLifecycle {
  /** Plugin ids whose enable() is in flight — a synchronous lock so concurrent enables can't double-run. */
  private readonly enabling = new Set<string>();
  /** In-flight disables by plugin id, so a concurrent disable joins the running teardown. */
  private readonly disabling = new Map<string, Promise<void>>();
  /** The env-derived config each built-in was registered with, under the operator's stored keys. */
  private readonly builtInBase = new Map<string, Record<string, unknown>>();

  constructor(
    // The LOADER's logger, deliberately — lifecycle lines carry the PluginLoaderService tag, and
    // that context is operator-visible. Creating a second logger here would silently retag every
    // enable/disable log line the moment this moved.
    private readonly logger: ReturnType<typeof createLogger>,
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    private readonly pluginStorage: PluginStorageService,
    /** Owns the capability surface handed to plugins — permissions, session scope, engine resolution. */
    private readonly capabilities: PluginCapabilityContext,
    /** Owns the sandboxed-worker IPC bridge — enable/teardown, hook/log relay, health + webhook dispatch. */
    private readonly sandboxBridge: PluginSandboxBridge,
    /** Resolves the host service ports; see PluginHostServices for why it is not constructor-injected. */
    private readonly hostServices: PluginHostServices,
    /** The scanner's registry-entry writer, for programmatic built-in registration. */
    private readonly ensureRegistryEntry: (manifest: PluginManifest, builtIn: boolean) => void,
    // The LOADER's registry + sandbox state, passed BY REFERENCE (see the class doc): mutations here
    // are visible to the loader, the bridge, and to the specs that poke these Maps on the loader.
    private readonly plugins: Map<string, PluginInstance>,
    private readonly sandboxHosts: Map<string, PluginWorkerHost>,
    private readonly lastSandboxHookError: Map<string, { event: string; error: string; at: Date }>,
    private readonly pluginsDir: string,
  ) {
    activeLifecycles.add(new WeakRef(this));
  }

  /** Whether this lifecycle's plugin registry map holds `plugin` by identity. */
  ownsPlugin(plugin: PluginInstance): boolean {
    return this.plugins.get(plugin.manifest.id) === plugin;
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
    const retainPriorShims =
      plugin.builtIn === false && plugin.status === PluginStatus.ERROR && this.hookManager.isPreEgressFailClosed();
    const priorHookIds = retainPriorShims ? this.hookManager.getPluginHookIds(pluginId) : new Set<string>();

    try {
      if (plugin.builtIn === false) {
        await this.sandboxBridge.enableSandboxed(pluginId, plugin, {
          preserveExistingHooks: priorHookIds.size > 0,
        });
      } else {
        await this.enableInProcess(pluginId, plugin);
      }

      plugin.status = PluginStatus.ENABLED;
      plugin.enabledAt = new Date();
      plugin.error = undefined;
      if (priorHookIds.size > 0) {
        this.hookManager.unregisterPluginHookIds(pluginId, priorHookIds);
      }

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

      // Drop any partial hooks registered during the failed attempt while keeping fail-closed
      // shims that were already retained for an ERROR plugin before this attempt began.
      this.hookManager.unregisterPluginHooksNotIn(pluginId, priorHookIds);

      throw error;
    } finally {
      this.enabling.delete(pluginId);
    }
  }

  /**
   * Disable an enabled plugin (best-effort force-teardown for sandboxed ones). `opts.unload` is set
   * ONLY by the unload path (uninstall / in-place update): it additionally dispatches the plugin's
   * onUnload hook. A plain disable (REST / shutdown teardown) deliberately does NOT fire onUnload —
   * disable is reversible and its cleanup hook is onDisable, while onUnload means "removed from the
   * runtime". (For a sandboxed plugin the worker thread does die on disable, but terminate() itself
   * releases its timers/sockets; the hook contract stays: onUnload only on unload.)
   */
  async disablePlugin(pluginId: string, opts?: { unload?: boolean }): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }

    if (plugin.status !== PluginStatus.ENABLED && plugin.status !== PluginStatus.ERROR) {
      return; // Not enabled or errored
    }

    // Status flips to DISABLED only after the teardown awaits, so a second disable arriving meanwhile
    // (shutdown overlapping a REST disable, an uninstall or an update unload) would pass the check
    // above and run onDisable again. Join the teardown already in flight instead. An unload that joins a plain
    // disable of a sandboxed plugin gets no onUnload, the same as unloading one already disabled.
    const inFlight = this.disabling.get(pluginId);
    if (inFlight) {
      return inFlight;
    }
    const disabling = this.teardown(pluginId, plugin, opts).finally(() => this.disabling.delete(pluginId));
    this.disabling.set(pluginId, disabling);
    return disabling;
  }

  private async teardown(pluginId: string, plugin: PluginInstance, opts?: { unload?: boolean }): Promise<void> {
    const wasEnabled = plugin.status === PluginStatus.ENABLED;
    try {
      const host = this.sandboxHosts.get(pluginId);
      if (host) {
        await this.sandboxBridge.teardownSandboxed(pluginId, host, opts);
      } else if (wasEnabled) {
        const context = this.capabilities.createPluginContext(plugin);
        if (plugin.instance?.onDisable) {
          await plugin.instance.onDisable(context);
        }
      }

      // Unregister all hooks for this plugin (including any pre-egress shims retained in ERROR)
      this.hookManager.unregisterPlugin(pluginId);
      // Drop the plugin's search-provider entry (if any) so queries don't route to a terminated worker.
      unregisterPluginSearchProvider(this.hostServices.getSearchRegistryPort(), pluginId);

      plugin.status = PluginStatus.DISABLED;
      plugin.error = undefined;

      this.pluginStorage.setPluginStatus(pluginId, PluginStatus.DISABLED);
      // A fresh enable starts with a clean hook-error slate (the state is per runtime, not persisted).
      this.lastSandboxHookError.delete(pluginId);

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

    // Disable first if enabled or errored. `unload: true` so a SANDBOXED plugin also gets its
    // onUnload hook, and an ERROR plugin releases any retained fail-closed pre-egress shims.
    if (plugin.status === PluginStatus.ENABLED || plugin.status === PluginStatus.ERROR) {
      await this.disablePlugin(pluginId, { unload: true });
    }
    this.hookManager.unregisterPlugin(pluginId);

    // Call onUnload (in-process plugins; a sandboxed one received it above, before terminate)
    if (plugin.instance?.onUnload) {
      const context = this.capabilities.createPluginContext(plugin);
      await plugin.instance.onUnload(context);
    }

    this.plugins.delete(pluginId);

    this.logger.log(`Plugin unloaded: ${plugin.manifest.name}`, {
      pluginId,
      action: 'plugin_unloaded',
    });
  }

  private planConfigUpdate(plugin: PluginInstance, pluginId: string, config: Record<string, unknown>) {
    // Persist only the operator's keys on top of what was persisted before, not the effective merge:
    // a built-in's effective config carries its env-derived defaults, and storing those would freeze
    // them over later .env changes (see registerBuiltInPlugin). Persisted first: a write that must be stored
    // and cannot be throws here and leaves the running config as it was.
    // On a built-in a null at any depth removes the stored key, so the key goes back to its env-derived value; a
    // stored null would outrank .env on every boot. An extension plugin stores the null as sent.
    const base = this.builtInBase.get(pluginId);
    const previousEffective = plugin.config;
    const previous =
      restorableConfig(this.pluginStorage.getPluginConfig(pluginId) ?? {}, config, plugin.manifest, base, {
        nullRevertsToBeneath: Boolean(base),
      }) ?? {};
    const stored = base ? deepMerge(previous, config, true) : { ...previous, ...config };
    const current = restorableConfig(previousEffective, config, plugin.manifest) ?? {};
    const nextConfig = base
      ? deepMerge(restorableConfig(base, stored, plugin.manifest) ?? {}, stored)
      : { ...current, ...config };
    const redirected = redirectedHostKeys(previousEffective, nextConfig, plugin.manifest);
    const nextSessionConfig = sanitizeSessionConfigsForBaseRedirect(
      plugin.sessionConfig,
      previousEffective,
      nextConfig,
      plugin.manifest,
    );
    return { previousEffective, stored, nextConfig, redirected, nextSessionConfig };
  }

  private commitPlannedConfigUpdate(
    plugin: PluginInstance,
    pluginId: string,
    plan: ReturnType<PluginLifecycle['planConfigUpdate']>,
    opts?: RegistryWriteOptions,
  ): void {
    if (plan.nextSessionConfig !== undefined) {
      this.pluginStorage.setPluginConfigAndSessionConfig(pluginId, plan.stored, plan.nextSessionConfig, opts);
      plugin.sessionConfig = plan.nextSessionConfig;
    } else {
      this.pluginStorage.setPluginConfig(pluginId, plan.stored, opts);
    }
    plugin.config = plan.nextConfig;

    // Notify the running plugin of the config change (fire and forget). A sandboxed plugin's
    // onConfigChange lives in the worker (plugin.instance is null), so route it through the live worker
    // host so it refreshes ctx.config too; built-ins go through the in-process instance.
    if (plugin.status === PluginStatus.ENABLED) {
      const sandboxHost = this.sandboxHosts.get(pluginId);
      if (sandboxHost) {
        sandboxHost.sendConfigChange(plugin.config);
      } else if (plugin.instance?.onConfigChange) {
        const context = this.capabilities.createPluginContext(plugin);
        void plugin.instance.onConfigChange(context, plugin.config);
      }
    }

    this.logger.debug(`Plugin config updated: ${pluginId}`, {
      pluginId,
      action: 'plugin_config_updated',
    });
  }

  private getPluginInstancePortOrUndefined(): ReturnType<PluginHostServices['getPluginInstancePort']> | undefined {
    try {
      return this.hostServices.getPluginInstancePort();
    } catch {
      return undefined;
    }
  }

  updatePluginConfig(pluginId: string, config: Record<string, unknown>, opts?: RegistryWriteOptions): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    assertNotUninstalling(pluginId, plugin);

    const plan = this.planConfigUpdate(plugin, pluginId, config);
    this.commitPlannedConfigUpdate(plugin, pluginId, plan, opts);
    if (plan.redirected.length > 0) {
      this.sanitizeInstancesAfterBaseRedirect(pluginId, plan.previousEffective, plan.nextConfig, plugin.manifest);
    }
  }

  /**
   * Async durable counterpart to {@link updatePluginConfig}: sanitizes persisted `plugin_instances`
   * rows in the database BEFORE committing a redirected base host to registry.json so a DB failure
   * aborts cleanly and an immediate restart after return cannot resurrect stripped instance secrets.
   */
  async updatePluginConfigDurable(
    pluginId: string,
    config: Record<string, unknown>,
    opts?: RegistryWriteOptions,
  ): Promise<void> {
    let plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    assertNotUninstalling(pluginId, plugin);

    const sanitizedKeys = new Set<string>();
    let plan = this.planConfigUpdate(plugin, pluginId, config);
    while (plan.redirected.some(key => !sanitizedKeys.has(key))) {
      const port = this.getPluginInstancePortOrUndefined();
      if (!port?.sanitizeForBaseRedirect) break;
      try {
        await port.sanitizeForBaseRedirect(pluginId, plan.previousEffective, plan.nextConfig, plugin.manifest, {
          retryOnFailure: false,
        });
      } catch (error) {
        throw new PluginInstanceSanitizationError(pluginId, error);
      }
      for (const key of plan.redirected) sanitizedKeys.add(key);

      plugin = this.plugins.get(pluginId);
      if (!plugin) {
        throw new Error(`Plugin ${pluginId} not found`);
      }
      assertNotUninstalling(pluginId, plugin);
      plan = this.planConfigUpdate(plugin, pluginId, config);
    }

    this.commitPlannedConfigUpdate(plugin, pluginId, plan, opts);
  }

  /**
   * Strip secrets from persisted plugin_instances rows that inherit a redirected base host key for
   * synchronous callers. PluginInstanceService tracks the in-flight promise synchronously before
   * returning, so subsequent instance reads wait for it and retry fail-closed if the write fails.
   */
  private sanitizeInstancesAfterBaseRedirect(
    pluginId: string,
    previousBase: Record<string, unknown>,
    nextBase: Record<string, unknown>,
    manifest: PluginManifest,
  ): void {
    const port = this.getPluginInstancePortOrUndefined();
    if (!port?.sanitizeForBaseRedirect) return;
    void port.sanitizeForBaseRedirect(pluginId, previousBase, nextBase, manifest).catch((error: unknown) => {
      this.logger.warn(
        `Failed to sanitize plugin instances for ${pluginId} after base host redirect: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { pluginId, action: 'plugin_instance_redirect_sanitize_failed' },
      );
    });
  }

  /**
   * Set the sessions a session-scoped plugin is activated for. `['*']` = all numbers (system-wide),
   * an explicit list scopes it to those sessions, `[]` deactivates it everywhere. Takes effect on the
   * next hook event (the gate reads plugin.activeSessions live) and survives a restart.
   */
  setPluginSessions(pluginId: string, sessions: string[], opts?: RegistryWriteOptions): PluginInstance {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    assertNotUninstalling(pluginId, plugin);
    if (plugin.manifest.sessionScoped === false) {
      throw new Error(`Plugin ${pluginId} is global (not session-scoped) and cannot be activated per session`);
    }

    this.pluginStorage.setPluginSessions(pluginId, sessions, opts);
    plugin.activeSessions = sessions;

    this.logger.log(`Plugin active sessions updated: ${pluginId}`, {
      pluginId,
      action: 'plugin_sessions_updated',
      sessions,
    });
    return plugin;
  }

  /**
   * Set (or clear) a plugin's per-session config override for `sessionId`. Hooks for that session then
   * see the override deep-merged over the base via ctx.config (nested objects merge key by key; arrays
   * and scalars replace), applied on the next event (resolution reads plugin.sessionConfig live) and
   * persisted across restart. An empty override removes it (the session falls back to the base).
   * Global plugins have no per-session config.
   */
  setPluginSessionConfig(
    pluginId: string,
    sessionId: string,
    config: Record<string, unknown>,
    opts?: RegistryWriteOptions,
  ): PluginInstance {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error(`Plugin ${pluginId} not found`);
    }
    assertNotUninstalling(pluginId, plugin);
    if (plugin.manifest.sessionScoped === false) {
      throw new Error(`Plugin ${pluginId} is global (not session-scoped) and has no per-session config`);
    }

    const next = { ...(plugin.sessionConfig ?? {}) };
    if (config && Object.keys(config).length > 0) {
      next[sessionId] = config;
    } else {
      delete next[sessionId];
    }
    this.pluginStorage.setPluginSessionConfig(pluginId, next, opts);
    plugin.sessionConfig = next;

    this.logger.debug(`Plugin session config updated: ${pluginId}`, {
      pluginId,
      action: 'plugin_session_config_updated',
      sessionId,
    });
    return plugin;
  }

  /** Built-in (trusted) enable: require + run the lifecycle in-process with the live capability context. */
  private async enableInProcess(pluginId: string, plugin: PluginInstance): Promise<void> {
    const context = this.capabilities.createPluginContext(plugin);

    if (!plugin.instance) {
      // Containment guard: reject a manifest.main that escapes the plugin dir.
      // The configured root, not the package dir: this tier runs only for built-ins
      // (enablePlugin routes `builtIn === false` to the sandbox), and a built-in is registered
      // programmatically with no on-disk package, so the two resolve identically here.
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

  registerBuiltInPlugin(manifest: PluginManifest, instance: IPlugin, config: Record<string, unknown> = {}): void {
    // Merge: env-derived defaults stay live each boot (so a changed .env wins), while an operator's
    // persisted overrides win for the keys they actually set. Engine plugin config can carry such an
    // override too (PUT /api/plugins/:id/config), except the auth-dir bases, which EngineFactory
    // passes to every createEngine call from the env config.
    const stored = this.pluginStorage.getPluginConfig(manifest.id) ?? {};
    const effectiveConfig = deepMerge(restorableConfig(config, stored, manifest) ?? {}, stored);
    // Kept so a stored key the operator removes can fall back to it (updatePluginConfig).
    const baseCopy = { ...config };
    this.builtInBase.set(manifest.id, baseCopy);

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
    builtInBaseByPlugin.set(pluginInstance, baseCopy);

    this.plugins.set(manifest.id, pluginInstance);

    // Ensure a registry entry exists so later enable/disable/config writes persist.
    this.ensureRegistryEntry(manifest, true);

    this.logger.debug(`Built-in plugin registered: ${manifest.name}`, {
      pluginId: manifest.id,
      action: 'builtin_plugin_registered',
    });
  }
}
