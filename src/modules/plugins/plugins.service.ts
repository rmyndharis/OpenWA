import { Injectable, NotFoundException, BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PluginLoaderService, PluginStatus } from '../../core/plugins';
import { PluginDto } from './dto/plugin.dto';
import { redactSecretConfig, restoreSecretConfig } from './redact-config';
import { parsePluginPackage } from './plugin-installer';

@Injectable()
export class PluginsService {
  constructor(private readonly pluginLoader: PluginLoaderService) {}

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
      loadedAt: plugin.loadedAt?.toISOString(),
      enabledAt: plugin.enabledAt?.toISOString(),
      error: plugin.error,
    };
  }

  async enable(id: string): Promise<{ success: boolean; message: string }> {
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

  async disable(id: string): Promise<{ success: boolean; message: string }> {
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

  /** Uninstall an installed user plugin: disable, unload, and delete its files. Built-ins are protected. */
  async uninstall(id: string): Promise<{ success: boolean; message: string }> {
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
