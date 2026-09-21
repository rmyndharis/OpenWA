import { Injectable, OnApplicationBootstrap, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import * as path from 'path';
import { DEFAULT_PLUGINS_DIR } from '../../config/configuration';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../hooks';
import {
  IPlugin,
  PluginInstance,
  PluginManifest,
  PluginRegistryEntry,
  PluginStatus,
  PluginType,
} from './plugin.interfaces';
import { PluginStorageService } from './plugin-storage.service';
import { PluginHostServices } from './plugin-host-services';
import { PluginCapabilityContext } from './plugin-capability-context';
import { PluginSandboxBridge } from './plugin-sandbox-bridge';
import { PluginPackageScanner } from './plugin-package-scanner';
import { PluginLifecycle } from './plugin-lifecycle';
import { PluginUninstaller } from './plugin-uninstaller';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { WorkerThreadChannel } from './sandbox/worker-thread-channel';
import { PluginLogLevel } from './sandbox/protocol';
import { resolvePluginMainPath } from './plugin-paths';
import type { IngressJobData } from '../../modules/queue/processors/ingress.processor';

// The shared path/containment helpers stay re-exported from this module: the feature-side installer
// (PluginsService) and the specs import them from here / from the core barrel.
export {
  resolvePluginMainPath,
  resolvePluginEntryPath,
  pluginUpdateStagingDirName,
  pluginUpdateBackupDirName,
} from './plugin-paths';

/** Default per-plugin heap cap for the sandbox worker; an OOM terminates the worker, not the host. */
const SANDBOX_MAX_OLD_GEN_MB = 256;

/**
 * Max concurrent worker-initiated capability calls per sandboxed plugin. A burst beyond this is rejected
 * (the plugin sees a thrown Error) rather than amplified into unbounded host-side sends/fetches/writes.
 */
const SANDBOX_MAX_INFLIGHT_CAPS = 32;

/**
 * Host-side budget for ONE worker-initiated capability call. A plugin whose calls hang would otherwise
 * hold all SANDBOX_MAX_INFLIGHT_CAPS slots forever (self-DoS). On timeout the worker gets an error and
 * the slot frees; the late-settling host work is only WARN-logged (see PluginWorkerHost.withCapTimeout —
 * a bound, not an atomicity guarantee). Default; plugins.capTimeoutMs (PLUGIN_CAP_TIMEOUT_MS) overrides.
 */
const SANDBOX_CAP_TIMEOUT_MS = 30000;

/**
 * Host process.env keys an untrusted plugin worker is allowed to see. Everything else — secrets like
 * API_MASTER_KEY, API_KEY_PEPPER, the DATABASE_/REDIS_ vars, DOCKER_HOST — is withheld. The worker is
 * a thread, so it needs no PATH to start and require() resolves via module paths, not env.
 */
const SANDBOX_ENV_ALLOWLIST = ['NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'TZ'] as const;

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

/**
 * The public facade of the plugin runtime. Every consumer — the REST surface, the installer, the
 * engine factory, the ingress pipeline — keeps calling this class; the jobs behind the surface are
 * collocated collaborators constructed below, each owning one job and sharing the loader's registry
 * Maps BY REFERENCE (so the specs that poke them on the loader and the collaborators see one map):
 *
 * - {@link PluginPackageScanner} — boot scan/registry: find packages on disk, validate manifests,
 *   recover interrupted updates, keep the persisted registry entries honest.
 * - {@link PluginLifecycle} — enable/disable/unload, config + per-session activation writes,
 *   programmatic built-in registration.
 * - {@link PluginUninstaller} — full removal of an installed user plugin.
 * - {@link PluginCapabilityContext} — the capability surface handed to plugins.
 * - {@link PluginSandboxBridge} — the sandboxed-worker IPC bridge (spawn/teardown, relay, health,
 *   ingress dispatch). The loader keeps only the protected worker-host factory seam the bridge
 *   calls back through, so spec subclasses can still inject fakes.
 *
 * What remains HERE is the facade itself: the Nest lifecycle hooks, the registry reads, and the
 * delegation to each collaborator.
 */
@Injectable()
export class PluginLoaderService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('PluginLoaderService');
  private readonly plugins = new Map<string, PluginInstance>();
  // Live worker host per enabled sandboxed (untrusted) plugin. Built-ins are not in here.
  private readonly sandboxHosts = new Map<string, PluginWorkerHost>();
  // Last hook-handler error each sandboxed plugin's worker reported, surfaced via checkPluginHealth so a
  // hook that keeps throwing is visible to the operator. Scoped to ONE worker generation: cleared when a
  // generation starts (enableSandboxed) and when one is deliberately ended (disablePlugin). Clearing at
  // the start is what makes it hold for a crash or a failed enable, neither of which runs a disable.
  private readonly lastSandboxHookError = new Map<string, { event: string; error: string; at: Date }>();
  private readonly pluginsDir: string;
  /**
   * The package dir OpenWA defaulted to before it moved under <dataDir>. Scanned as a compatibility
   * fallback so a host that installed plugins there keeps loading them; null when PLUGINS_DIR names a
   * directory explicitly, and null for a ConfigService that carries no app config (unit tests).
   */
  private readonly legacyPluginsDir: string | null;
  /** Resolves the host service ports at call time; see PluginHostServices for why it is not ctor-injected. */
  private readonly hostServices: PluginHostServices;
  /** Owns the capability surface handed to plugins — permissions, session scope, engine resolution. */
  private readonly capabilities: PluginCapabilityContext;
  /** Owns the sandboxed-worker IPC bridge — enable/teardown, hook/log relay, health + webhook dispatch. */
  private readonly sandboxBridge: PluginSandboxBridge;
  /** Owns the boot scan/registry job — package discovery, manifest validation, crash recovery. */
  private readonly scanner: PluginPackageScanner;
  /** Owns the runtime job — enable/disable/unload, config + session activation writes, built-in registration. */
  private readonly lifecycle: PluginLifecycle;
  /** Owns the removal job — uninstall of an installed user plugin. */
  private readonly uninstaller: PluginUninstaller;

  constructor(
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    private readonly pluginStorage: PluginStorageService,
    // Handed straight to PluginHostServices below, which owns the reasoning: ModuleRef rather than
    // constructor injection avoids the provider cycle
    // PluginLoaderService -> SessionService -> SessionEngineLifecycle -> EngineFactory -> PluginLoaderService.
    private readonly moduleRef: ModuleRef,
    // Shared lid->phone table (EngineModule is @Global and exports it). Optional so the many unit tests
    // that construct this service with the 4 prior args still compile; when absent, canonicalChatId
    // degrades to identity (no @lid resolution).
    @Optional() private readonly lidMappingStore?: LidMappingStoreService,
  ) {
    // Same default the `plugins.dir` key is built from, so this fallback cannot drift away from the
    // tree PluginStorageService keeps the registry and each plugin's ctx.storage in.
    this.pluginsDir = this.configService.get<string>('plugins.dir') ?? DEFAULT_PLUGINS_DIR;
    this.legacyPluginsDir = this.configService.get<string>('plugins.legacyDir') ?? null;
    this.hostServices = new PluginHostServices(this.moduleRef);
    this.capabilities = new PluginCapabilityContext(
      this.logger,
      this.hostServices,
      this.hookManager,
      this.pluginStorage,
      this.lidMappingStore,
    );
    this.sandboxBridge = new PluginSandboxBridge(
      this.logger,
      this.hookManager,
      this.capabilities,
      this.hostServices,
      this.configService,
      this.pluginStorage,
      // Shared BY REFERENCE: specs poke these Maps on the loader via casts, so the bridge and the
      // loader must see one and the same map, not two copies.
      this.plugins,
      this.sandboxHosts,
      this.lastSandboxHookError,
      this.pluginsDir,
      // A closure, not a method reference: virtual dispatch keeps a subclass's createSandboxHost
      // override (the sandbox specs' worker-host seam) in effect through the bridge.
      (
        capDispatcher,
        onHookSubscribe,
        onWebhookSubscribe,
        onLog,
        runWithHookGuard,
        onSearchProviderRegister,
        onWorkerExit,
      ) =>
        this.createSandboxHost(
          capDispatcher,
          onHookSubscribe,
          onWebhookSubscribe,
          onLog,
          runWithHookGuard,
          onSearchProviderRegister,
          onWorkerExit,
        ),
      // Exported from this module (specs import it here); passed so the bridge never imports back.
      resolvePluginMainPath,
    );
    this.scanner = new PluginPackageScanner(
      this.logger,
      this.configService,
      this.pluginStorage,
      this.pluginsDir,
      this.legacyPluginsDir,
      // Shared BY REFERENCE, like the bridge's maps: the loader's registry reads below and the
      // scanner's writes are one and the same map.
      this.plugins,
    );
    this.lifecycle = new PluginLifecycle(
      this.logger,
      this.configService,
      this.hookManager,
      this.pluginStorage,
      this.capabilities,
      this.sandboxBridge,
      this.hostServices,
      (manifest, builtIn) => this.scanner.ensureRegistryEntry(manifest, builtIn),
      this.plugins,
      this.sandboxHosts,
      this.lastSandboxHookError,
      this.pluginsDir,
    );
    this.uninstaller = new PluginUninstaller(this.logger, this.plugins, this.pluginStorage, this.pluginsDir, pluginId =>
      this.lifecycle.unloadPlugin(pluginId),
    );
  }

  onModuleInit(): void {
    if (process.env.OPENAPI_EXPORT === 'true') return;
    this.scanner.scanAtBoot();
  }

  /**
   * Re-enable the plugins the operator had enabled (#856). `status` cannot carry that across a restart
   * — it describes the runtime, and loading never runs a plugin — so the decision is read from the
   * separately persisted `enabledByOperator`. Without this, every restart (an upgrade, a host reboot, a
   * Docker restart policy) silently switched off every extension, and a relay simply stopped relaying.
   *
   * Runs at bootstrap rather than in onModuleInit so the rest of the app is wired before any plugin
   * code executes. Built-ins are skipped: an engine is enabled by EngineFactory against the configured
   * engine.type, and enabling a non-active engine here would be rejected anyway.
   *
   * Best-effort and sequential, like the shutdown teardown: a plugin that cannot come back is logged
   * and left in ERROR, and never holds up the gateway.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.OPENAPI_EXPORT === 'true') return;
    const restorable = this.getAllPlugins().filter(
      p => !p.builtIn && this.pluginStorage.getPluginEntry(p.manifest.id)?.enabledByOperator === true,
    );
    for (const plugin of restorable) {
      const pluginId = plugin.manifest.id;
      try {
        await this.enablePlugin(pluginId);
      } catch (error) {
        this.logger.error(
          `Failed to restore plugin ${pluginId} on startup; it stays disabled until re-enabled`,
          error instanceof Error ? error.message : String(error),
          { pluginId, action: 'plugin_restore_failed' },
        );
      }
    }
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

  /**
   * Record that the operator wants this plugin on (or off), so bootstrap can restore it (#856).
   *
   * Call this ONLY from an operator-facing action. In particular it must never be called from
   * disablePlugin: onModuleDestroy disables every running plugin during a graceful shutdown, and
   * treating that as "the operator turned it off" would erase the decision on the way out — which is
   * the very bug this exists to fix, just moved somewhere harder to see.
   */
  setOperatorEnabled(pluginId: string, enabled: boolean): void {
    this.pluginStorage.setPluginEnabledByOperator(pluginId, enabled);
  }

  /**
   * The persisted registry entry for a plugin id, whether or not its code is currently loaded. Lets a
   * caller distinguish "installed but not loaded" — which still owns config, storage and the
   * `enabledByOperator` decision — from an id the gateway has genuinely never seen.
   */
  getRegistryEntry(pluginId: string): PluginRegistryEntry | undefined {
    return this.pluginStorage.getPluginEntry(pluginId);
  }

  getAllRegistryEntries(): PluginRegistryEntry[] {
    return this.pluginStorage.getAllEntries();
  }

  loadPlugin(pluginPath: string): PluginInstance {
    return this.scanner.loadPlugin(pluginPath);
  }

  enablePlugin(pluginId: string): Promise<void> {
    return this.lifecycle.enablePlugin(pluginId);
  }

  disablePlugin(pluginId: string, opts?: { unload?: boolean }): Promise<void> {
    return this.lifecycle.disablePlugin(pluginId, opts);
  }

  unloadPlugin(pluginId: string): Promise<void> {
    return this.lifecycle.unloadPlugin(pluginId);
  }

  /** Absolute path of the directory user plugins are loaded from (used by install/uninstall). */
  getPluginsDir(): string {
    return this.pluginsDir;
  }

  /**
   * Absolute path of a plugin's own package directory — the tree its code was loaded from.
   *
   * Every operation that acts on the package (enable, uninstall, update, config UI) must use this
   * rather than <plugins.dir>/<id>: the loader also scans the legacy plugins directory, so those are
   * not the same path for a plugin a host has not migrated yet. Falls back to the configured
   * location for an id that is not loaded, which is what a fresh install wants.
   */
  getPluginPackageDir(pluginId: string): string {
    return this.plugins.get(pluginId)?.packageDir ?? path.join(this.pluginsDir, pluginId);
  }

  /** Whether a plugin is a first-party built-in (engine / bundled extension) vs an installed user plugin. */
  isBuiltIn(pluginId: string): boolean {
    return this.pluginStorage.getPluginEntry(pluginId)?.builtIn ?? false;
  }

  uninstallPlugin(pluginId: string): Promise<void> {
    return this.uninstaller.uninstallPlugin(pluginId);
  }

  updatePluginConfig(pluginId: string, config: Record<string, unknown>): void {
    this.lifecycle.updatePluginConfig(pluginId, config);
  }

  setPluginSessions(pluginId: string, sessions: string[]): PluginInstance {
    return this.lifecycle.setPluginSessions(pluginId, sessions);
  }

  setPluginSessionConfig(pluginId: string, sessionId: string, config: Record<string, unknown>): PluginInstance {
    return this.lifecycle.setPluginSessionConfig(pluginId, sessionId, config);
  }

  /** Health across both tiers; the sandbox-routing implementation lives in PluginSandboxBridge. */
  checkPluginHealth(pluginId: string): Promise<{ healthy: boolean; message?: string }> {
    return this.sandboxBridge.checkPluginHealth(pluginId);
  }

  /**
   * Ingress dispatch into the plugin's live sandbox worker; implemented by PluginSandboxBridge.
   * The public contract (callers: IngressProcessor, IngressEnqueueService) is unchanged.
   */
  dispatchWebhookForInstance(d: IngressJobData): Promise<void> {
    return this.sandboxBridge.dispatchWebhookForInstance(d);
  }

  /**
   * Build a worker host for a sandboxed (untrusted) plugin. Overridable so tests can inject a fake
   * instead of spawning a real OS thread. Production loads the compiled worker bootstrap from dist.
   */
  protected createSandboxHost(
    capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
    onHookSubscribe?: (event: string, priority?: number) => void,
    onWebhookSubscribe?: (route: string) => void,
    onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
    runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
    onSearchProviderRegister?: () => void,
    onWorkerExit?: (code: number, intentional: boolean) => void,
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
      onWebhookSubscribe,
      onLog,
      runWithHookGuard,
      SANDBOX_MAX_INFLIGHT_CAPS,
      onSearchProviderRegister,
      onWorkerExit,
      this.configService.get<number>('plugins.capTimeoutMs') ?? SANDBOX_CAP_TIMEOUT_MS,
    );
  }

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

  registerBuiltInPlugin(manifest: PluginManifest, instance: IPlugin, config: Record<string, unknown> = {}): void {
    this.lifecycle.registerBuiltInPlugin(manifest, instance, config);
  }
}
