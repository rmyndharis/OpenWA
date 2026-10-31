import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { PluginStorageService } from '../../core/plugins/plugin-storage.service';
import { HookManager } from '../../core/hooks';
import { PluginInstance, PluginStatus, PluginType } from '../../core/plugins/plugin.interfaces';
import { PluginsService } from './plugins.service';
import { InternalServerErrorException } from '@nestjs/common';

// A config save the gateway could not write to registry.json must not be reported as saved: the change
// lives only in memory and is gone after the next restart, while the operator was told it was stored.

describe('PluginsService.updateConfig when registry.json cannot be written', () => {
  let tmp: string;
  let pluginsRoot: string;
  let configService: ConfigService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-config-unpersisted-'));
    pluginsRoot = path.join(tmp, 'plugins');
    const values: Record<string, unknown> = { dataDir: tmp, 'plugins.dir': pluginsRoot };
    configService = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
  });

  afterEach(() => {
    fs.chmodSync(pluginsRoot, 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the failure instead of success', () => {
    const storage = new PluginStorageService(configService);
    storage.setPluginEntry({
      id: 'p1',
      type: PluginType.EXTENSION,
      name: 'P1',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: { apiKey: 'old' },
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    });
    const loader = new PluginLoaderService(configService, new HookManager(), storage, {
      get: jest.fn(),
    } as unknown as ModuleRef);
    const plugin: PluginInstance = {
      manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: PluginType.EXTENSION, main: 'index.js' },
      status: PluginStatus.INSTALLED,
      config: { apiKey: 'old' },
      instance: null,
      builtIn: false,
    };
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
    const service = new PluginsService(loader, configService);

    // The data volume stops accepting writes (full disk, read-only remount, wrong owner).
    fs.chmodSync(pluginsRoot, 0o500);

    const result = service.updateConfig('p1', { apiKey: 'rotated' });

    // What a restart would load: the registry on disk.
    expect(new PluginStorageService(configService).getPluginConfig('p1')).toEqual({ apiKey: 'old' });
    expect(result.success).toBe(false);
  });
});

// The other operator-facing plugin writes: each one the registry cannot store is answered as not applied, and the
// running state stays what a restart would load.
describe('PluginsService plugin changes when registry.json cannot be written', () => {
  let tmp: string;
  let pluginsRoot: string;
  let configService: ConfigService;
  let storage: PluginStorageService;
  let loader: PluginLoaderService;
  let service: PluginsService;
  let plugin: PluginInstance;

  const onDisk = (): PluginStorageService => new PluginStorageService(configService);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-unwritable-'));
    pluginsRoot = path.join(tmp, 'plugins');
    const values: Record<string, unknown> = { dataDir: tmp, 'plugins.dir': pluginsRoot };
    configService = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
    storage = new PluginStorageService(configService);
    storage.setPluginEntry({
      id: 'p1',
      type: PluginType.EXTENSION,
      name: 'P1',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: { apiKey: 'old' },
      builtIn: true,
      installedAt: new Date(),
      updatedAt: new Date(),
      activeSessions: ['s1'],
      enabledByOperator: false,
    });
    // One stand-in for every host port the paths below reach (search registry, conversation store).
    const port = { unregister: jest.fn(), releaseTakeovers: jest.fn().mockResolvedValue(undefined) };
    loader = new PluginLoaderService(configService, new HookManager(), storage, {
      get: jest.fn().mockReturnValue(port),
    } as unknown as ModuleRef);
    // An in-process plugin with nothing to run, so an enable completes without a worker.
    plugin = {
      manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: PluginType.EXTENSION, main: 'index.js' },
      status: PluginStatus.INSTALLED,
      config: { apiKey: 'old' },
      instance: {},
      builtIn: true,
      activeSessions: ['s1'],
    };
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
    service = new PluginsService(loader, configService);
    // The plugin's storage directory exists already, as it does for any plugin enabled before.
    fs.mkdirSync(path.join(pluginsRoot, 'p1'));
    fs.chmodSync(pluginsRoot, 0o500);
  });

  afterEach(() => {
    fs.chmodSync(pluginsRoot, 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps the running config when the save is refused', () => {
    expect(service.updateConfig('p1', { apiKey: 'rotated' }).success).toBe(false);
    expect(plugin.config).toEqual({ apiKey: 'old' });
    expect(storage.getPluginConfig('p1')).toEqual({ apiKey: 'old' });
  });

  it('refuses a per-session config it cannot store', () => {
    expect(service.updateSessionConfig('p1', 's1', { apiKey: 'tenant' }).success).toBe(false);
    expect(plugin.sessionConfig).toBeUndefined();
    expect(onDisk().getPluginSessionConfig('p1')).toBeNull();
  });

  it('answers an activation it cannot store as a server error, not a client error', () => {
    expect(() => service.updateSessions('p1', ['*'])).toThrow(InternalServerErrorException);
    expect(plugin.activeSessions).toEqual(['s1']);
    expect(onDisk().getPluginSessions('p1')).toEqual(['s1']);
  });

  it('does not leave a plugin running whose enable decision it cannot store', async () => {
    const result = await service.enable('p1');

    expect(result.success).toBe(false);
    expect(plugin.status).toBe(PluginStatus.DISABLED);
    expect(onDisk().getPluginEntry('p1')?.enabledByOperator).toBe(false);
  });

  it('keeps a running plugin running when its disable decision cannot be stored', async () => {
    plugin.status = PluginStatus.ENABLED;
    storage.getPluginEntry('p1')!.enabledByOperator = true;

    const result = await service.disable('p1');

    expect(result.success).toBe(false);
    expect(result.message).toContain('the change was not applied');
    expect(plugin.status).toBe(PluginStatus.ENABLED);
    expect(onDisk().getPluginEntry('p1')?.enabledByOperator).toBe(false);
  });

  it('reports a disable decision it cannot store for a plugin that is not loaded', async () => {
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.delete('p1');
    storage.getPluginEntry('p1')!.enabledByOperator = true;

    await expect(service.disable('p1')).resolves.toMatchObject({ success: false });
    expect(storage.getPluginEntry('p1')?.enabledByOperator).toBe(true);
  });

  it('refuses an uninstall it cannot store before removing anything', async () => {
    plugin.builtIn = false;
    storage.getPluginEntry('p1')!.builtIn = false;

    await expect(service.uninstall('p1')).rejects.toThrow(InternalServerErrorException);
    expect(loader.getPlugin('p1')).toBe(plugin);
    expect(fs.existsSync(path.join(pluginsRoot, 'p1'))).toBe(true);
    expect(storage.getPluginEntry('p1')?.config).toEqual({ apiKey: 'old' });
    expect(onDisk().getPluginEntry('p1')?.config).toEqual({ apiKey: 'old' });
  });
});
