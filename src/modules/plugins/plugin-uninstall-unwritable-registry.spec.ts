import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { HookManager } from '../../core/hooks';
import { PluginRegistryEntry } from '../../core/plugins/plugin.interfaces';
import { PluginUninstallingError } from '../../core/plugins/plugin-uninstaller';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

const manifest = { id: 'p1', name: 'P1', version: '1.0.0', type: 'extension', main: 'index.js' };
function pkg(): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.js', Buffer.from('module.exports = class {};'));
  return zip.toBuffer();
}

/** What an uninstall must not leave for a reinstall of the id to inherit, or for a restart to restore. */
const operatorSettings = (entry: PluginRegistryEntry | undefined) => ({
  config: entry?.config,
  activeSessions: entry?.activeSessions,
  sessionConfig: entry?.sessionConfig,
  enabledByOperator: entry?.enabledByOperator,
});
const emptied = { config: {}, activeSessions: undefined, sessionConfig: undefined, enabledByOperator: false };

// An uninstall empties the plugin's registry entry before it removes anything and drops the entry last. A registry
// that cannot take the first write refuses the uninstall with nothing changed. One that fails only the last write
// leaves an emptied entry: the answer and the audit trail say the plugin was uninstalled, and neither a reinstall of
// the id nor a restart gets the old config, session activation or enable decision back.
describe('Uninstall when registry.json cannot be written', () => {
  let tmp: string;
  let registryRoot: string;
  let packageDir: string;
  let configService: ConfigService;
  let onRelease: () => void;

  /** One gateway process over the same directories; a second call is a restart. */
  const boot = () => {
    const storage = new PluginStorageService(configService);
    const port = {
      unregister: jest.fn(),
      releaseTakeovers: jest.fn(() => {
        onRelease();
        return Promise.resolve();
      }),
    };
    const loader = new PluginLoaderService(configService, new HookManager(), storage, {
      get: jest.fn().mockReturnValue(port),
    } as unknown as ModuleRef);
    const service = new PluginsService(loader, configService);
    const logInfo = jest.fn().mockResolvedValue(null);
    const controller = new PluginsController(service, { logInfo } as unknown as AuditService);
    return { storage, loader, service, controller, logInfo };
  };
  let gateway: ReturnType<typeof boot>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-uninstall-unwritable-'));
    registryRoot = path.join(tmp, 'data', 'plugins');
    // PLUGINS_DIR outside the data directory: the package tree stays writable when the data volume does not.
    const packagesRoot = path.join(tmp, 'packages');
    fs.mkdirSync(packagesRoot, { recursive: true });
    packageDir = path.join(packagesRoot, 'p1');
    const values: Record<string, unknown> = { dataDir: path.join(tmp, 'data'), 'plugins.dir': packagesRoot };
    configService = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
    onRelease = () => undefined;
    gateway = boot();
    gateway.service.install({ buffer: pkg() });
    const mustPersist = { mustPersist: true };
    gateway.storage.setPluginConfig('p1', { token: 'old-secret' }, mustPersist);
    gateway.storage.setPluginSessions('p1', ['s1'], mustPersist);
    gateway.storage.setPluginSessionConfig('p1', { s1: { token: 'tenant-secret' } }, mustPersist);
    gateway.storage.setPluginEnabledByOperator('p1', true);
  });

  afterEach(() => {
    fs.chmodSync(registryRoot, 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const onDisk = () => new PluginStorageService(configService).getPluginEntry('p1');

  it('refuses the uninstall before removing anything when the registry cannot be written from the start', async () => {
    // The data volume's plugin directory stops accepting writes (an ownership change).
    fs.chmodSync(registryRoot, 0o500);

    await expect(gateway.controller.uninstall('p1')).rejects.toThrow(InternalServerErrorException);

    expect(gateway.loader.getPlugin('p1')).toBeDefined();
    expect(fs.existsSync(packageDir)).toBe(true);
    expect(onDisk()?.config).toEqual({ token: 'old-secret' });
    expect(onDisk()?.enabledByOperator).toBe(true);
    expect(gateway.logInfo).not.toHaveBeenCalled();
  });

  it('answers done when only the final delete fails, and a reinstall in the same process starts fresh', async () => {
    // The registry stops accepting writes while the plugin is being removed.
    onRelease = () => fs.chmodSync(registryRoot, 0o500);

    const result = await gateway.controller.uninstall('p1');

    expect(gateway.loader.getPlugin('p1')).toBeUndefined();
    expect(fs.existsSync(packageDir)).toBe(false);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/keeps its entry, emptied of config, sessions and the enable decision/);
    // The plugin is no longer listed, so the answer names the call that removes the entry.
    expect(result.message).toMatch(/until DELETE \/api\/plugins\/p1 is repeated once the registry is writable$/);
    expect(gateway.logInfo).toHaveBeenCalledWith(AuditAction.PLUGIN_UNINSTALLED, {
      sessionId: undefined,
      metadata: { pluginId: 'p1' },
    });
    expect(operatorSettings(gateway.storage.getPluginEntry('p1'))).toEqual(emptied);
    expect(operatorSettings(onDisk())).toEqual(emptied);

    fs.chmodSync(registryRoot, 0o700);
    onRelease = () => undefined;
    gateway.service.install({ buffer: pkg() });

    expect(operatorSettings(gateway.storage.getPluginEntry('p1'))).toEqual(emptied);
    expect(operatorSettings(onDisk())).toEqual(emptied);
  });

  it('leaves nothing for a restart to re-enable or hand to a reinstall', async () => {
    onRelease = () => fs.chmodSync(registryRoot, 0o500);
    await gateway.controller.uninstall('p1');
    onRelease = () => undefined;

    const restarted = boot();
    restarted.loader.onModuleInit();

    expect(restarted.loader.getPlugin('p1')).toBeUndefined();
    // What the boot restore reads to decide whether to enable a loaded plugin.
    expect(operatorSettings(restarted.loader.getRegistryEntry('p1'))).toEqual(emptied);

    fs.chmodSync(registryRoot, 0o700);
    restarted.service.install({ buffer: pkg() });

    expect(operatorSettings(restarted.storage.getPluginEntry('p1'))).toEqual(emptied);
    expect(operatorSettings(onDisk())).toEqual(emptied);
  });

  it('refuses config and session writes that arrive while the uninstall is unloading the plugin', async () => {
    onRelease = () => fs.chmodSync(registryRoot, 0o500);
    // The unload awaits the plugin's own hooks with the plugin still loaded; every write lands in that window.
    const lifecycle = (gateway.loader as unknown as { lifecycle: { unloadPlugin(id: string): Promise<void> } })
      .lifecycle;
    const unload = lifecycle.unloadPlugin.bind(lifecycle);
    const outcomes: unknown[] = [];
    const attempt = (write: () => unknown): void => {
      try {
        outcomes.push(write());
      } catch (error) {
        outcomes.push(error);
      }
    };
    jest.spyOn(lifecycle, 'unloadPlugin').mockImplementation(async (id: string) => {
      const { controller, loader } = gateway;
      attempt(() => controller.updateConfig('p1', { config: { token: 'saved-during-uninstall' } }));
      attempt(() => controller.updateSessionConfig('p1', 's2', { config: { token: 'tenant-2' } }));
      attempt(() => controller.updateSessions('p1', { sessions: ['s2'] }));
      // The integration fabric projects instance config through the loader directly, best effort.
      attempt(() => loader.updatePluginConfig('p1', { token: 'instance-secret' }));
      attempt(() => loader.setPluginSessionConfig('p1', 's3', { token: 'instance-3' }));
      attempt(() => loader.setPluginSessions('p1', ['*']));
      return unload(id);
    });

    const result = await gateway.controller.uninstall('p1');

    expect(outcomes.slice(0, 3).map(o => o instanceof ConflictException)).toEqual([true, true, true]);
    expect(outcomes.slice(3).map(o => o instanceof PluginUninstallingError)).toEqual([true, true, true]);
    expect(result.message).toMatch(/keeps its entry, emptied of config, sessions and the enable decision/);
    // Only the uninstall is audited: no refused write left a row.
    expect(gateway.logInfo).toHaveBeenCalledTimes(1);
    expect(gateway.logInfo).toHaveBeenCalledWith(AuditAction.PLUGIN_UNINSTALLED, expect.anything());
    expect(operatorSettings(gateway.storage.getPluginEntry('p1'))).toEqual(emptied);
    expect(operatorSettings(onDisk())).toEqual(emptied);

    // What a reinstall of the id inherits after a restart.
    onRelease = () => undefined;
    fs.chmodSync(registryRoot, 0o700);
    const restarted = boot();
    restarted.loader.onModuleInit();
    restarted.service.install({ buffer: pkg() });
    expect(restarted.loader.getPlugin('p1')?.config).toEqual({});
    expect(operatorSettings(restarted.storage.getPluginEntry('p1'))).toEqual(emptied);
  });

  it('takes config and session writes again once an uninstall leaves the plugin loaded', async () => {
    const lifecycle = (gateway.loader as unknown as { lifecycle: { unloadPlugin(id: string): Promise<void> } })
      .lifecycle;
    jest.spyOn(lifecycle, 'unloadPlugin').mockRejectedValueOnce(new Error('onUnload failed'));

    await expect(gateway.controller.uninstall('p1')).rejects.toThrow('onUnload failed');

    expect(gateway.loader.getPlugin('p1')).toBeDefined();
    expect(gateway.controller.updateConfig('p1', { config: { token: 'new-secret' } }).success).toBe(true);
    expect(onDisk()?.config).toEqual({ token: 'new-secret' });
  });

  it('removes the leftover entry when the uninstall is repeated with a writable registry', async () => {
    onRelease = () => fs.chmodSync(registryRoot, 0o500);
    await gateway.controller.uninstall('p1');
    onRelease = () => undefined;
    fs.chmodSync(registryRoot, 0o700);

    await expect(gateway.controller.uninstall('p1')).resolves.toEqual({
      success: true,
      message: 'Plugin p1 uninstalled successfully',
    });
    expect(gateway.storage.getPluginEntry('p1')).toBeUndefined();
    expect(onDisk()).toBeUndefined();
  });
});
