import { Injectable, NotFoundException } from '@nestjs/common';
import { PluginLoaderService, PluginStatus } from '../../core/plugins';
import { PluginDto } from './dto/plugin.dto';
import { redactSecretConfig, restoreSecretConfig } from './redact-config';

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
      builtIn: plugin.manifest.id === 'whatsapp-web.js', // Built-in engines
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
      builtIn: plugin.manifest.id === 'whatsapp-web.js',
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

  async healthCheck(id: string): Promise<{ healthy: boolean; message?: string }> {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    if (!plugin.instance?.healthCheck) {
      return { healthy: true, message: 'Plugin does not implement health check' };
    }

    try {
      return await plugin.instance.healthCheck();
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
