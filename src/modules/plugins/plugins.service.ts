import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { PluginLoaderService, PluginStatus, resolvePluginMainPath } from '../../core/plugins';
import type { PluginConfigSchema } from '../../core/plugins';
import { PluginDto } from './dto/plugin.dto';
import { redactSecretConfig, restoreSecretConfig } from './redact-config';
import { parsePluginPackage } from './plugin-installer';
import { fetchSafeBuffer } from './plugin-download';
import { annotateCatalog, CatalogEntry, CatalogPlugin } from './catalog';

/** Cap on the catalog JSON download (the catalog is small; this bounds a hostile response). */
const CATALOG_MAX_BYTES = 1 * 1024 * 1024;

@Injectable()
export class PluginsService {
  constructor(
    private readonly pluginLoader: PluginLoaderService,
    private readonly configService: ConfigService,
  ) {}

  // Serialize the directory/lifecycle-mutating operations (enable/disable/uninstall/update/install) for a
  // given plugin id so two of them on the SAME id can't interleave (e.g. enable racing uninstall, or two
  // updates racing on the backup dir). Mirrors the promise-chain serializer in session.service.ts.
  private readonly opChains = new Map<string, Promise<unknown>>();

  private serialize<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prior = this.opChains.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(op);
    this.opChains.set(id, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.opChains.get(id) === next) this.opChains.delete(id);
      });
    return next;
  }

  findAll(): PluginDto[] {
    const plugins = this.pluginLoader.getAllPlugins();

    return plugins.map(plugin => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      type: plugin.manifest.type,
      description: plugin.manifest.description,
      author: plugin.manifest.author,
      status: plugin.status,
      config: redactSecretConfig(plugin.config, plugin.manifest.configSchema),
      builtIn: this.pluginLoader.isBuiltIn(plugin.manifest.id),
      provides: plugin.manifest.provides ?? [],
      configSchema: plugin.manifest.configSchema,
      configUi: plugin.manifest.configUi,
      i18n: plugin.manifest.i18n,
      sessionConfig: this.redactSessionConfig(plugin.sessionConfig, plugin.manifest.configSchema),
      sessionScoped: plugin.manifest.sessionScoped !== false,
      activeSessions: plugin.activeSessions ?? ['*'],
      loadedAt: plugin.loadedAt?.toISOString(),
      enabledAt: plugin.enabledAt?.toISOString(),
      error: plugin.error,
    }));
  }

  findOne(id: string): PluginDto {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    return {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      type: plugin.manifest.type,
      description: plugin.manifest.description,
      author: plugin.manifest.author,
      status: plugin.status,
      config: redactSecretConfig(plugin.config, plugin.manifest.configSchema),
      builtIn: this.pluginLoader.isBuiltIn(plugin.manifest.id),
      provides: plugin.manifest.provides ?? [],
      configSchema: plugin.manifest.configSchema,
      configUi: plugin.manifest.configUi,
      i18n: plugin.manifest.i18n,
      sessionConfig: this.redactSessionConfig(plugin.sessionConfig, plugin.manifest.configSchema),
      sessionScoped: plugin.manifest.sessionScoped !== false,
      activeSessions: plugin.activeSessions ?? ['*'],
      loadedAt: plugin.loadedAt?.toISOString(),
      enabledAt: plugin.enabledAt?.toISOString(),
      error: plugin.error,
    };
  }

  enable(id: string): Promise<{ success: boolean; message: string }> {
    return this.serialize(id, () => this.enableInner(id));
  }

  private async enableInner(id: string): Promise<{ success: boolean; message: string }> {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    if (plugin.status === PluginStatus.ENABLED) {
      return { success: true, message: `Plugin ${id} is already enabled` };
    }

    try {
      await this.pluginLoader.enablePlugin(id);
      return { success: true, message: `Plugin ${id} enabled successfully` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  disable(id: string): Promise<{ success: boolean; message: string }> {
    return this.serialize(id, () => this.disableInner(id));
  }

  private async disableInner(id: string): Promise<{ success: boolean; message: string }> {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    if (plugin.status !== PluginStatus.ENABLED) {
      return { success: true, message: `Plugin ${id} is not enabled` };
    }

    try {
      await this.pluginLoader.disablePlugin(id);
      return { success: true, message: `Plugin ${id} disabled successfully` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  updateSessions(id: string, sessions: string[], allowedSessions?: string[] | null): PluginDto {
    const plugin = this.pluginLoader.getPlugin(id);
    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }
    // A session-restricted key (non-empty allowedSessions) may only activate the plugin for sessions
    // in its own scope — never '*' (all) or another tenant's session. An unrestricted key (null/empty)
    // is the normal dashboard/admin path and may activate for any session, including '*'.
    if (allowedSessions && allowedSessions.length > 0) {
      const outOfScope = sessions.filter(s => s === '*' || !allowedSessions.includes(s));
      if (outOfScope.length > 0) {
        throw new ForbiddenException(`API key not authorized for session(s): ${outOfScope.join(', ')}`);
      }
    }
    try {
      this.pluginLoader.setPluginSessions(id, sessions);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    return this.findOne(id);
  }

  updateConfig(id: string, config: Record<string, unknown>): { success: boolean; message: string } {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    try {
      // The dashboard PUTs the whole (redacted) config back, so a sentinel secret means "unchanged":
      // restore the stored value instead of overwriting the real secret with the mask.
      const merged = restoreSecretConfig(config, plugin.config, plugin.manifest.configSchema);
      this.pluginLoader.updatePluginConfig(id, merged);
      return { success: true, message: `Plugin ${id} configuration updated` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Set a plugin's per-session config override for `sessionId`. Like updateConfig, the dashboard PUTs
   * the whole (redacted) slice back, so a sentinel secret restores the stored per-session value. An
   * empty slice clears the override (the session falls back to the base config).
   */
  updateSessionConfig(
    id: string,
    sessionId: string,
    config: Record<string, unknown>,
  ): { success: boolean; message: string } {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }
    if (plugin.manifest.sessionScoped === false) {
      // A global plugin has no per-session config — reject with 400 (mirrors PUT /:id/sessions).
      throw new BadRequestException(`Plugin ${id} is global (not session-scoped) and has no per-session config`);
    }

    try {
      const existing = plugin.sessionConfig?.[sessionId];
      const merged = restoreSecretConfig(config, existing, plugin.manifest.configSchema);
      this.pluginLoader.setPluginSessionConfig(id, sessionId, merged);
      return { success: true, message: `Plugin ${id} configuration for session ${sessionId} updated` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Redact secrets in every per-session config slice for the DTO (mirrors the base config redaction). */
  private redactSessionConfig(
    sessionConfig: Record<string, Record<string, unknown>> | undefined,
    schema: PluginConfigSchema | undefined,
  ): Record<string, Record<string, unknown>> | undefined {
    if (!sessionConfig) return undefined;
    return Object.fromEntries(
      Object.entries(sessionConfig).map(([sid, cfg]) => [sid, redactSecretConfig(cfg, schema)]),
    );
  }

  /**
   * Read a plugin's sandboxed config-UI entry HTML (manifest `configUi.entry`). The dashboard fetches
   * this with the API key and injects it as an iframe `srcdoc`, so the file must be self-contained.
   * Path is escape-guarded against the plugin directory; the entry is plugin-author-supplied.
   */
  getConfigUiHtml(id: string): string {
    const plugin = this.pluginLoader.getPlugin(id);
    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }
    const entry = plugin.manifest.configUi?.entry;
    // `entry` is untrusted manifest JSON — a non-string (or escaping) value is treated as "no config
    // UI" (404), never a raw 500.
    if (!entry || typeof entry !== 'string') {
      throw new NotFoundException(`Plugin ${id} has no config UI`);
    }
    const base = path.resolve(this.pluginLoader.getPluginsDir(), id);
    let file: string;
    try {
      file = resolvePluginMainPath(this.pluginLoader.getPluginsDir(), id, entry);
    } catch {
      throw new NotFoundException(`Config UI entry not found for plugin ${id}`);
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new NotFoundException(`Config UI entry not found for plugin ${id}`);
    }
    // Defense-in-depth: the lexical guard above is symlink-blind; resolve links on BOTH the file and
    // the plugin dir (so a symlinked tmp root like macOS /var→/private/var doesn't false-positive) and
    // re-check containment before reading an arbitrary host file into the main process and serving it.
    const real = fs.realpathSync(file);
    const realBase = fs.realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      throw new NotFoundException(`Config UI entry not found for plugin ${id}`);
    }
    return fs.readFileSync(real, 'utf-8');
  }

  /** Install a plugin from an uploaded .zip: validate the package, write it to the plugins dir, and load it. */
  install(file?: { buffer?: Buffer }): PluginDto {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No plugin file uploaded');
    }

    const { manifest, entries } = parsePluginPackage(file.buffer);

    if (this.pluginLoader.getPlugin(manifest.id)) {
      throw new ConflictException(`Plugin "${manifest.id}" is already installed`);
    }
    const dir = path.join(this.pluginLoader.getPluginsDir(), manifest.id);
    if (fs.existsSync(dir)) {
      throw new ConflictException(`A plugin directory "${manifest.id}" already exists`);
    }

    // Write the validated entries then load; roll back the directory on any failure so a bad
    // package never leaves a half-installed plugin behind.
    try {
      for (const entry of entries) {
        const dest = path.join(dir, entry.relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.data);
      }
      this.pluginLoader.loadPlugin(dir);
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(
        `Failed to install plugin: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.findOne(manifest.id);
  }

  /**
   * Install a plugin from an HTTP(S) URL: download the .zip through the SSRF guard (host validated,
   * connection pinned, redirects refused, size-capped), then run the exact same validate-write-load
   * pipeline as an uploaded package. The downloaded buffer is treated as untrusted, identical to an upload.
   */
  async installFromUrl(url: string): Promise<PluginDto> {
    const maxBytes = this.configService.get<number>('plugins.downloadMaxBytes') ?? 5 * 1024 * 1024;
    let buffer: Buffer;
    try {
      buffer = await fetchSafeBuffer(url, { maxBytes });
    } catch (error) {
      throw new BadRequestException(
        `Failed to download plugin from URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Peek the id (the SSRF download stays outside the lock) so the install — which writes the plugin
    // directory — is serialized against any concurrent uninstall/update of the same id.
    const { manifest } = parsePluginPackage(buffer);
    return this.serialize(manifest.id, () => Promise.resolve(this.install({ buffer })));
  }

  /**
   * Fetch the configured remote catalog (a plugins.json array) through the SSRF guard and annotate each
   * entry with this instance's install state (installed / installedVersion / updateAvailable).
   */
  async getCatalog(): Promise<CatalogPlugin[]> {
    const url = this.configService.get<string>('plugins.catalogUrl');
    if (!url) return [];

    let raw: Buffer;
    try {
      raw = await fetchSafeBuffer(url, { maxBytes: CATALOG_MAX_BYTES });
    } catch (error) {
      throw new BadRequestException(
        `Failed to fetch plugin catalog: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let entries: CatalogEntry[];
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!Array.isArray(parsed)) throw new Error('catalog is not a JSON array');
      entries = parsed as CatalogEntry[];
    } catch (error) {
      throw new BadRequestException(
        `Invalid plugin catalog JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const installed = this.pluginLoader.getAllPlugins().map(p => ({ id: p.manifest.id, version: p.manifest.version }));
    return annotateCatalog(entries, installed);
  }

  /**
   * Update an installed plugin in place from a validated package buffer, preserving operator config and
   * the enabled state. The package id must match the installed id. Config survives because `unloadPlugin`
   * drops the plugin from memory but keeps its registry entry (config); `loadPlugin` re-reads it. The old
   * directory is backed up and restored if the swap or reload of the new version fails, so a bad update
   * never leaves the plugin broken.
   */
  updatePackage(id: string, buffer: Buffer): Promise<PluginDto> {
    return this.serialize(id, () => this.updatePackageInner(id, buffer));
  }

  private async updatePackageInner(id: string, buffer: Buffer): Promise<PluginDto> {
    const plugin = this.pluginLoader.getPlugin(id);
    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }
    if (this.pluginLoader.isBuiltIn(id)) {
      throw new BadRequestException(`Cannot update built-in plugin ${id}`);
    }

    // Validate the new package BEFORE touching the running plugin. An update must be the same plugin.
    const { manifest, entries } = parsePluginPackage(buffer);
    if (manifest.id !== id) {
      throw new BadRequestException(`Package id "${manifest.id}" does not match the plugin being updated ("${id}")`);
    }

    const wasEnabled = plugin.status === PluginStatus.ENABLED;
    const dir = path.join(this.pluginLoader.getPluginsDir(), id);
    // Dot-prefixed sibling inside pluginsDir: same filesystem (so the rename stays EXDEV-safe) but
    // skipped by the loader's directory scan, so a crash mid-update can't leave it loaded as a duplicate.
    const backup = path.join(this.pluginLoader.getPluginsDir(), `.${id}.bak`);

    // Stop the running plugin (terminates its sandbox worker) but keep its registry entry so config survives.
    await this.pluginLoader.unloadPlugin(id);

    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(dir, backup);

    try {
      for (const entry of entries) {
        const dest = path.join(dir, entry.relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.data);
      }
      this.pluginLoader.loadPlugin(dir);
      if (wasEnabled) {
        await this.pluginLoader.enablePlugin(id);
      }
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      // Roll back to the previous version: restore the backed-up directory and reload it.
      // The failed forward path may have left the NEW version in the loader map (loadPlugin
      // succeeded; enablePlugin failed with status=ERROR but did NOT remove it), so drop it first —
      // otherwise the restore's loadPlugin() hits the "already loaded" guard and the runtime stays
      // desynced from disk (new manifest in memory, old files on disk). unloadPlugin throws when
      // nothing is loaded (the loadPlugin-itself-failed case), hence the catch.
      await this.pluginLoader.unloadPlugin(id).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(backup, dir);
      try {
        this.pluginLoader.loadPlugin(dir);
        if (wasEnabled) await this.pluginLoader.enablePlugin(id);
      } catch {
        /* best-effort restore; surface the original failure below */
      }
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(
        `Failed to update plugin: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.findOne(id);
  }

  /** Update an installed plugin by downloading the new package from a URL (SSRF-guarded), then in place. */
  async updateFromUrl(id: string, url: string): Promise<PluginDto> {
    const maxBytes = this.configService.get<number>('plugins.downloadMaxBytes') ?? 5 * 1024 * 1024;
    let buffer: Buffer;
    try {
      buffer = await fetchSafeBuffer(url, { maxBytes });
    } catch (error) {
      throw new BadRequestException(
        `Failed to download plugin from URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.updatePackage(id, buffer);
  }

  /** Uninstall an installed user plugin: disable, unload, and delete its files. Built-ins are protected. */
  uninstall(id: string): Promise<{ success: boolean; message: string }> {
    return this.serialize(id, () => this.uninstallInner(id));
  }

  private async uninstallInner(id: string): Promise<{ success: boolean; message: string }> {
    const plugin = this.pluginLoader.getPlugin(id);
    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    try {
      await this.pluginLoader.uninstallPlugin(id);
      return { success: true, message: `Plugin ${id} uninstalled successfully` };
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  async healthCheck(id: string): Promise<{ healthy: boolean; message?: string }> {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    try {
      // Delegate to the loader so a sandboxed plugin's healthCheck (which runs in the worker, where
      // plugin.instance is null) is reached too — the old plugin.instance check always returned the
      // default "healthy" for sandboxed plugins, blinding health monitoring.
      return await this.pluginLoader.checkPluginHealth(id);
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
