import type { PluginPermission } from '../plugin.interfaces';

export class PluginPermissionDeniedError extends Error {
  constructor(pluginId: string, permission: PluginPermission) {
    super(`Plugin "${pluginId}" attempted to use "${permission}" without declaring it`);
    this.name = 'PluginPermissionDeniedError';
  }
}
