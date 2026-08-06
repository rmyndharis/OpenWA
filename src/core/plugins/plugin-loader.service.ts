import { Injectable, OnApplicationBootstrap, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PLUGINS_DIR } from '../../config/configuration';
import { createLogger } from '../../common/services/logger.service';
import { HookManager } from '../hooks';
import {
  PluginManifest,
  PluginInstance,
  PluginRegistryEntry,
  PluginStatus,
  IPlugin,
  PluginType,
  validateIngressManifest,
  warnUnauthenticatedIngressRoutes,
  warnUnsignedTimestampRoutes,
} from './plugin.interfaces';
import { validatePluginManifest } from './plugin-manifest';
import { PluginStorageService } from './plugin-storage.service';
import { seedConfigDefaults } from './config-defaults.util';
import { PluginHostServices } from './plugin-host-services';
import { PluginCapabilityContext } from './plugin-capability-context';
import { PluginSandboxBridge } from './plugin-sandbox-bridge';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { WorkerThreadChannel } from './sandbox/worker-thread-channel';
import { PluginLogLevel } from './sandbox/protocol';
import { unregisterPluginSearchProvider } from './search-provider-registration.util';
import type { IngressJobData } from '../../modules/queue/processors/ingress.processor';

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
 * Sibling directory names an in-place plugin update stages into / backs up to (see
 * PluginsService.updatePackageInner). Dot-prefixed so the boot directory scan skips them, and placed
 * inside the plugins dir so the swap renames stay on one filesystem (EXDEV-safe). The loader's
 * boot-time reconciler (recoverInterruptedUpdates) keys off these exact names.
 */
export function pluginUpdateStagingDirName(pluginId: string): string {
  return `.${pluginId}.new`;
}
export function pluginUpdateBackupDirName(pluginId: string): string {
  return `.${pluginId}.bak`;
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

// Plugin ids whose bundled-extension code was permanently removed (v0.7 — superseded by the
// marketplace chat-flow / group-translate; also reserved in plugin-installer). A leftover
// directory without a manifest marks them as deleted on disk, so the stale registry entry (which
// still reports them installed/enabled) is pruned on boot. Scoped to these known ids so a
// temporarily-unreadable plugin dir (e.g. an unmounted volume) never loses its persisted config.
const LEGACY_REMOVED_PLUGIN_IDS = new Set(['auto-reply', 'translation']);

/**
 * Whether `dir` holds at least one loadable plugin package — a non-dot subdirectory with a manifest.
 * Existence of the directory, or of subdirectories in it, proves nothing: <dataDir>/plugins is also
 * where the registry and every plugin's ctx.storage live, so it is routinely full of directories that
 * hold only `key-*.json` state. Unreadable or missing counts as "no packages": this only ever decides
 * whether to scan a fallback location, never whether to delete anything.
 */
function hasPluginPackages(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some(
        entry =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          fs.existsSync(path.join(dir, entry.name, 'manifest.json')),
      );
  } catch {
    return false;
  }
}

@Injectable()
export class PluginLoaderService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('PluginLoaderService');
  private readonly plugins = new Map<string, PluginInstance>();
  /** Plugin ids whose enable() is in flight — a synchronous lock so concurrent enables can't double-run. */
  private readonly enabling = new Set<string>();
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
  /** Resolves host services at call time; see PluginHostServices for why it is not constructor-injected. */
  private readonly hostServices: PluginHostServices;
  /** Owns the capability surface handed to plugins — permissions, session scope, engine resolution. */
  private readonly capabilities: PluginCapabilityContext;
  /** Owns the sandboxed-worker IPC bridge — enable/teardown, hook/log relay, health + webhook dispatch. */
  private readonly sandboxBridge: PluginSandboxBridge;

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
      // Exported above (specs import it from this module); passed so the bridge never imports back.
      resolvePluginMainPath,
    );
  }

  onModuleInit(): void {
    // Load built-in plugins first (synchronous registration)
    this.loadBuiltInPlugins();

    // Then load user plugins if directory exists
    if (fs.existsSync(this.pluginsDir)) {
      this.loadPluginsFromDirectory(this.pluginsDir);
    }

    // COMPATIBILITY PATH — hosts that installed plugins before the package dir moved under <dataDir>.
    // Their code sits in the old ./plugins, which was self-consistent while the loader and the
    // installer both used that default, so changing the default must not take those plugins away.
    // Scanned in ADDITION to the configured dir rather than instead of it, so a host part-way through
    // migrating keeps both halves; the configured copy loads first and wins any duplicate id. Never
    // runs when PLUGINS_DIR is set (legacyDir is null then). Keyed on finding a real plugin package,
    // not on the directory existing: <dataDir>/plugins/<id> doubles as the plugin's ctx.storage dir,
    // so directories with no code in them are routine.
    if (this.legacyPluginsDir && hasPluginPackages(this.legacyPluginsDir)) {
      this.logger.warn(
        `Loading plugins from the legacy directory ${this.legacyPluginsDir}: the default moved to ` +
          `${this.pluginsDir}, where the plugin registry and every new install already are. Move them ` +
          `(mv ${this.legacyPluginsDir}/* ${this.pluginsDir}/) or keep the old location by setting ` +
          `PLUGINS_DIR=${this.legacyPluginsDir}. In Docker this matters: a directory outside the data ` +
          `volume is destroyed on the next container recreate.`,
        { action: 'plugins_legacy_dir', legacyDir: this.legacyPluginsDir, pluginsDir: this.pluginsDir },
      );
      this.loadPluginsFromDirectory(this.legacyPluginsDir);
    }

    this.logger.log(`Loaded ${this.plugins.size} plugins`, {
      action: 'plugins_loaded',
      count: this.plugins.size,
    });

    this.warnOnRegistryEntriesWithoutCode();
  }

  /**
   * Report installed plugins the registry knows about but the scan did not find. Without this, the
   * two halves of an install drifting apart is invisible: the boot logs "Loaded 0 plugins" — exactly
   * what a host with nothing installed logs — while the dashboard, which reads the registry, lists
   * every plugin as installed and enabled. Naming the directory that was actually scanned is what
   * makes the divergence self-diagnosing.
   *
   * Built-ins are excluded: they are registered programmatically at bootstrap (after this runs) and
   * never have a package directory at all.
   */
  private warnOnRegistryEntriesWithoutCode(): void {
    const orphaned = this.pluginStorage.getAllEntries().filter(e => !e.builtIn && !this.plugins.has(e.id));
    if (orphaned.length === 0) return;

    const missingDir = fs.existsSync(this.pluginsDir) ? '' : ' (that directory does not exist)';
    this.logger.warn(
      `The plugin registry lists ${orphaned.length} installed plugin(s) with no loaded code in ` +
        `${this.pluginsDir}${missingDir}: ${orphaned.map(e => e.id).join(', ')}. Their config and stored ` +
        `data are intact — reinstall them, or set PLUGINS_DIR to the directory that holds their code.`,
      { action: 'plugin_registry_without_code', count: orphaned.length, pluginsDir: this.pluginsDir },
    );
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

  private loadBuiltInPlugins(): void {
    // Built-in plugins are registered programmatically
    // This will be used by Phase 4 to register engine plugins
    this.logger.debug('Built-in plugins loading point (Phase 4)', {
      action: 'builtin_plugins_init',
    });
  }

  private loadPluginsFromDirectory(dir: string): void {
    // Reconcile any interrupted-update leftovers BEFORE scanning, so a crash mid-swap can't make a
    // plugin silently vanish while its registry entry still claims it is installed.
    this.recoverInterruptedUpdates(dir);

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip non-directories and dot-prefixed dirs (e.g. a crash-leftover `.<id>.bak` update backup or
      // `.<id>.new` staging tree), so a half-finished update can't be re-loaded as a duplicate-id
      // plugin on the next boot. recoverInterruptedUpdates has already reconciled them by this point.
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      // Already loaded by an earlier scan. Only reachable through the legacy-directory compatibility
      // scan, where the same package can sit in both trees: the copy in the configured dir wins, and
      // re-loading it would throw "already loaded" — which the catch below would persist as ERROR on
      // a perfectly healthy plugin.
      if (this.plugins.has(entry.name)) {
        this.logger.debug(`Skipped ${entry.name} in ${dir}: already loaded from another plugin directory`, {
          pluginId: entry.name,
          action: 'plugin_duplicate_dir_skipped',
        });
        continue;
      }

      const pluginPath = path.join(dir, entry.name);
      const manifestPath = path.join(pluginPath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        if (LEGACY_REMOVED_PLUGIN_IDS.has(entry.name)) {
          this.logger.warn(
            `Skipped ${entry.name}: not a plugin (no manifest.json). Delete the directory to silence this, ` +
              `or add a manifest.json if it is meant to load.`,
            { pluginPath, action: 'manifest_missing' },
          );
          this.pluginStorage.deletePluginEntry(entry.name);
          this.logger.log(`Pruned stale registry entry for removed built-in plugin: ${entry.name}`, {
            action: 'registry_ghost_pruned',
          });
          continue;
        }

        // A manifest-less directory here means one of three different things, which used to log
        // identically: <dataDir>/plugins/<id> is BOTH the package dir and the plugin's ctx.storage
        // dir, so a built-in that persists anything owns a manifest-less directory on every healthy
        // boot, while an installed plugin whose code is gone (a container recreate that took the
        // image layer with it) leaves a directory that looks exactly the same — state still in it.
        // The registry is what tells them apart, so consult it rather than logging one wording for
        // the routine case, the data-loss case, and a directory an operator simply dropped in here.
        const registryEntry = this.pluginStorage.getPluginEntry(entry.name);
        if (registryEntry?.builtIn) {
          this.logger.debug(`Skipped ${entry.name}: built-in plugin storage, not a package directory`, {
            pluginPath,
            pluginId: entry.name,
            action: 'builtin_storage_dir_skipped',
          });
        } else if (registryEntry) {
          this.logger.warn(
            `Plugin ${entry.name} is installed but its code is missing from ${pluginPath} (no manifest.json) ` +
              `while its stored data is still there. Reinstall it — its config and stored data are kept. ` +
              `Plugin code kept outside the data volume does not survive a container recreate.`,
            { pluginPath, pluginId: entry.name, action: 'plugin_code_missing' },
          );
        } else {
          // Operators do drop unrelated directories in here, and this fires on every boot for each one.
          // The old bare "missing manifest.json" wording read like an internal fault — #981's reporter
          // pasted it into an unrelated session bug as evidence. Say what was skipped and what to do.
          this.logger.warn(
            `Skipped ${entry.name}: not a plugin (no manifest.json). Delete the directory to silence this, ` +
              `or add a manifest.json if it is meant to load.`,
            { pluginPath, action: 'manifest_missing' },
          );
        }
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
        // The runtime just dropped this plugin, but a registry entry from a previous successful
        // load still claims it installed/enabled — reconcile the persisted state to ERROR so the
        // mismatch surfaces instead of silently persisting. The entry itself (operator config,
        // enabledByOperator) is preserved: fix the manifest/main and the next boot loads and
        // re-enables it (ensureRegistryEntry resets the status on a successful load). No-op when
        // no entry exists (a hand-placed dir that never loaded).
        this.pluginStorage.setPluginStatus(entry.name, PluginStatus.ERROR);
      }
    }
  }

  /**
   * Crash recovery for in-place updates (see PluginsService.updatePackageInner). An update stages the
   * new tree at `.<id>.new`, then swaps with two renames (live → `.<id>.bak`, staging → live). Both
   * siblings are dot-prefixed, so the scan above skips them — but without reconciliation a crash
   * BETWEEN the renames loses the live dir and the plugin silently vanishes from the runtime while
   * its registry entry still claims it is installed. Reconcile before scanning:
   *  - live dir missing + `.<id>.bak` present → the swap was interrupted: restore the backup as the
   *    live dir (the previous version comes back; the update never touched the registry entry or the
   *    operator's config, so nothing else needs repairing).
   *  - live dir present + `.<id>.bak` present → the swap completed but the process died before the
   *    backup cleanup: drop the backup.
   *  - `.<id>.new` present → staging from an interrupted/failed update; the live install (if any)
   *    was never swapped: drop it.
   * Best-effort: a reconciliation failure is logged and left for the next boot rather than aborting
   * plugin loading entirely.
   */
  private recoverInterruptedUpdates(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = /^\.(.+)\.(?:bak|new)$/.exec(entry.name);
      if (!match) continue;
      const pluginId = match[1];
      const leftover = path.join(dir, entry.name);
      const liveDir = path.join(dir, pluginId);
      try {
        if (entry.name === pluginUpdateStagingDirName(pluginId)) {
          fs.rmSync(leftover, { recursive: true, force: true });
          this.logger.warn(`Dropped stale update staging for plugin ${pluginId}`, {
            pluginId,
            action: 'plugin_update_staging_pruned',
          });
        } else if (!fs.existsSync(liveDir)) {
          fs.renameSync(leftover, liveDir);
          this.logger.warn(
            `Restored plugin ${pluginId} from its update backup — a previous update was interrupted mid-swap`,
            { pluginId, action: 'plugin_update_backup_restored' },
          );
        } else {
          fs.rmSync(leftover, { recursive: true, force: true });
          this.logger.warn(`Dropped stale update backup for plugin ${pluginId}`, {
            pluginId,
            action: 'plugin_update_backup_pruned',
          });
        }
      } catch (error) {
        this.logger.error(
          `Failed to reconcile the interrupted-update leftover ${entry.name}`,
          error instanceof Error ? error.message : String(error),
          { pluginId, action: 'plugin_update_recovery_failed' },
        );
      }
    }
  }

  loadPlugin(pluginPath: string): PluginInstance {
    const manifestPath = path.join(pluginPath, 'manifest.json');
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent) as unknown;

    // Boot-time validation is the SAME validation install runs (parsePluginPackage): a hand-placed
    // or crash-leftover directory must satisfy the install contract too — plain-object shape,
    // required string fields, id format + reserved ids, extension-only type, and a `main` that
    // cannot escape the plugin dir. Otherwise a manifest the installer would have rejected loads
    // anyway and only fails (or worse, runs unexpected code) at enable time.
    validatePluginManifest(manifest);

    // Anchor `main` inside THIS on-disk directory: the lexical check above is forward-slash only,
    // so a platform-separator escape (e.g. Windows-style `..\x`) would slip past it — resolve and
    // re-check containment here. Parity with install's in-archive check: the entry must exist as a
    // file, or the plugin loads "successfully" and only blows up when someone enables it.
    const mainPath = resolvePluginMainPath(path.dirname(pluginPath), path.basename(pluginPath), manifest.main);
    if (!fs.existsSync(mainPath) || !fs.statSync(mainPath).isFile()) {
      throw new Error(`Plugin ${manifest.id}: main file not found in the plugin directory: ${manifest.main}`);
    }

    // Reject a malformed ingress declaration (SDK-major mismatch, missing webhook:ingress permission,
    // duplicate/empty routes, non-positive toleranceSec) at load time instead of letting it silently
    // load and become provisionable. No-op for plugins that declare no ingress. A route declaring
    // signature.scheme 'none' is rejected unless the operator opted in via ALLOW_UNSIGNED_INGRESS=true.
    validateIngressManifest(manifest, this.configService.get<boolean>('ingress.allowUnsigned', false));

    // Surface a loud warning for any ingress route that skips signature verification — a scheme:'none'
    // route is a fully-unauthenticated public endpoint that can trigger WhatsApp sends. Only reachable
    // when the operator opted in (otherwise validateIngressManifest above rejected it); the warning
    // reminds them to front the URL with a network/reverse-proxy ACL.
    warnUnauthenticatedIngressRoutes(manifest, this.logger);

    // Same loud-warning treatment for an hmac route whose declared timestamp is not bound into the
    // signature: freshness is enforced, but an unsigned timestamp lets a replay mint a fresh one.
    warnUnsignedTimestampRoutes(manifest, this.logger);

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
      // Seed schema-declared defaults under the stored config, so a defaulted field is never
      // missing when the plugin later runs (explicit values are never overwritten).
      config: seedConfigDefaults(manifest.configSchema, storedConfig),
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
    // Reconcile the persisted entry with the freshly-loaded runtime: loading never runs the plugin, so
    // the entry's status is (re)set to INSTALLED to match the runtime. Enabling is a separate step that
    // runs the lifecycle — at bootstrap for a plugin the operator had enabled (see
    // onApplicationBootstrap), or on an explicit ADMIN action. The operator's persisted config and
    // enable decision are preserved so settings/secrets and the decision itself survive. Best-effort:
    // saveRegistry swallows fs errors, so a disk failure never turns a load into a 500.
    const existing = this.pluginStorage.getPluginEntry(manifest.id);
    // The operator's standing enable decision (#856). `status` below is deliberately reset, so intent
    // has to live in its own field or a restart loses it. A pre-#856 row has no such field: adopt it
    // from a status of ENABLED, which can only have been written by an explicit enable since the last
    // boot (every boot rewrites the status to INSTALLED), so it is a faithful record of the intent.
    const enabledByOperator = existing?.enabledByOperator ?? existing?.status === PluginStatus.ENABLED;
    this.pluginStorage.setPluginEntry({
      id: manifest.id,
      type: manifest.type,
      name: manifest.name,
      version: manifest.version,
      status: PluginStatus.INSTALLED,
      // The operator's persisted config survives, with schema-declared defaults seeded under it so
      // the persisted entry matches the seeded runtime config (see loadPlugin).
      config: seedConfigDefaults(manifest.configSchema, existing?.config ?? {}),
      builtIn,
      installedAt: existing?.installedAt ?? new Date(),
      updatedAt: new Date(),
      // setPluginEntry REPLACES the entry, so the operator's per-session activation + config must be
      // carried over or every boot wipes them from disk (lost after the second restart).
      activeSessions: existing?.activeSessions,
      sessionConfig: existing?.sessionConfig,
      enabledByOperator,
    });
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
        await this.sandboxBridge.enableSandboxed(pluginId, plugin);
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

    if (plugin.status !== PluginStatus.ENABLED) {
      return; // Not enabled
    }

    try {
      const host = this.sandboxHosts.get(pluginId);
      if (host) {
        await this.sandboxBridge.teardownSandboxed(pluginId, host, opts);
      } else {
        const context = this.capabilities.createPluginContext(plugin);
        if (plugin.instance?.onDisable) {
          await plugin.instance.onDisable(context);
        }
      }

      // Unregister all hooks for this plugin
      this.hookManager.unregisterPlugin(pluginId);
      // Drop the plugin's search-provider entry (if any) so queries don't route to a terminated worker.
      unregisterPluginSearchProvider(this.hostServices.getSearchRegistry(), pluginId);

      plugin.status = PluginStatus.DISABLED;

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

    // Disable first if enabled. `unload: true` so a SANDBOXED plugin also gets its onUnload hook:
    // disable terminates the worker thread, which would otherwise make onUnload unreachable. An
    // in-process plugin's onUnload runs below instead (its instance survives disable). A sandboxed
    // plugin that is already disabled has no live worker left to notify — its resources were
    // released when the worker terminated, so there is nothing to clean up.
    if (plugin.status === PluginStatus.ENABLED) {
      await this.disablePlugin(pluginId, { unload: true });
    }

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

    // Drop the plugin's ctx.storage data dir. Under shipped defaults it lives INSIDE the package
    // dir (already gone above), but a split-dir deployment (PLUGINS_DIR outside the data dir) would
    // otherwise leak <dataDir>/plugins/<id> — persisted secrets included — on every uninstall.
    // Best-effort, and strictly that one plugin's directory.
    this.pluginStorage.deletePluginData(pluginId);

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
        const context = this.capabilities.createPluginContext(plugin);
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

  /** Built-in (trusted) enable: require + run the lifecycle in-process with the live capability context. */
  private async enableInProcess(pluginId: string, plugin: PluginInstance): Promise<void> {
    const context = this.capabilities.createPluginContext(plugin);

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
