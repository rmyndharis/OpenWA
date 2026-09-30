import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../common/services/logger.service';
import {
  PluginInstance,
  PluginManifest,
  PluginStatus,
  validateIngressManifest,
  warnUnauthenticatedIngressRoutes,
  warnUnsignedTimestampRoutes,
} from './plugin.interfaces';
import { validatePluginManifest } from './plugin-manifest';
import { PluginStorageService } from './plugin-storage.service';
import { seedConfigDefaults } from './config-defaults.util';
import { resolvePluginMainPath, pluginUpdateStagingDirName } from './plugin-paths';

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

/**
 * The boot-scan half of the plugin runtime: find plugin packages on disk (the configured plugins dir
 * plus the legacy compatibility tree), validate each manifest against the install contract, and
 * populate the loader's plugin registry — the Map, passed by reference, that the loader, the sandbox
 * bridge and the capability surface all read.
 *
 * Split out of PluginLoaderService so the loader reads as the public facade while disk discovery —
 * crash recovery for interrupted updates, ghost pruning, registry reconciliation — is reviewed on its
 * own. A plain class, not a Nest provider: the loader constructs it in its constructor (the same
 * pattern as PluginSandboxBridge / PluginCapabilityContext), so the loader's public constructor
 * signature — which specs build directly — is unchanged.
 */
export class PluginPackageScanner {
  constructor(
    // The LOADER's logger, deliberately — scan lines carry the PluginLoaderService tag, and that
    // context is operator-visible. Creating a second logger here would silently retag every boot
    // log line the moment this moved.
    private readonly logger: ReturnType<typeof createLogger>,
    private readonly configService: ConfigService,
    private readonly pluginStorage: PluginStorageService,
    private readonly pluginsDir: string,
    /**
     * The package dir OpenWA defaulted to before it moved under <dataDir>, scanned as a compatibility
     * fallback; null when PLUGINS_DIR names a directory explicitly.
     */
    private readonly legacyPluginsDir: string | null,
    // The LOADER's plugin registry, passed BY REFERENCE: mutations here are visible to the loader
    // and to every collaborator that shares the same map.
    private readonly plugins: Map<string, PluginInstance>,
  ) {}

  /**
   * The loader's onModuleInit: load built-in plugins (programmatic registration point), then every
   * user plugin package found on disk — the configured directory first, the legacy tree in addition —
   * and report registry entries whose code the scan did not find.
   */
  scanAtBoot(): void {
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
    // required string fields, id format + reserved ids, extension-only type, a `main` that cannot
    // escape the plugin dir, and no minOpenWAVersion floor above the running host. Otherwise a
    // manifest the installer would have rejected loads anyway and only fails (or worse, runs
    // unexpected code) at enable time.
    validatePluginManifest(manifest);

    // Anchor `main` inside THIS on-disk directory: the lexical check above is forward-slash only,
    // so a platform-separator escape (e.g. Windows-style `..\x`) would slip past it — resolve and
    // re-check containment here. Parity with install's in-archive check: the entry must exist as a
    // file, or the plugin loads "successfully" and only blows up when someone enables it.
    const mainPath = resolvePluginMainPath(path.dirname(pluginPath), path.basename(pluginPath), manifest.main);
    if (!fs.existsSync(mainPath) || !fs.statSync(mainPath).isFile()) {
      throw new Error(`Plugin ${manifest.id}: main file not found in the plugin directory: ${manifest.main}`);
    }

    // Reject a malformed ingress declaration (every check is listed on validateIngressManifest) at
    // load time instead of letting it silently load and become provisionable. No-op for plugins that
    // declare no ingress.
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
      // The directory this package was actually found in, which is not necessarily
      // <plugins.dir>/<id> — the legacy directory is scanned too. Recorded here because this is the
      // only point that knows it; every later write against the package reads it back.
      packageDir: path.resolve(pluginPath),
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
  ensureRegistryEntry(manifest: PluginManifest, builtIn: boolean): void {
    // Reconcile the persisted entry with the freshly-loaded runtime: loading never runs the plugin, so
    // the entry's status is (re)set to INSTALLED to match the runtime. Enabling is a separate step that
    // runs the lifecycle — at bootstrap for a plugin the operator had enabled (see
    // PluginLoaderService.onApplicationBootstrap), or on an explicit ADMIN action. The operator's
    // persisted config and enable decision are preserved so settings/secrets and the decision itself
    // survive. Best-effort: saveRegistry swallows fs errors, so a disk failure never turns a load
    // into a 500.
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
}
