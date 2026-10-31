import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import { PluginInstance, PluginStatus, PluginType } from './plugin.interfaces';
import { ScopeBindingService } from '../../modules/integration/scope-binding.service';

// The integration instance projection applies to the running plugin even when registry.json cannot be written:
// the database rows are authoritative and boot reconciliation rebuilds the file, while a teardown that changed
// nothing in memory would leave a deleted instance firing, or its config slice for the survivor on its scope.
describe('the instance projection while registry.json cannot be written', () => {
  let tmp: string;
  let pluginsRoot: string;
  let loader: PluginLoaderService;
  let plugin: PluginInstance;
  let siblings: Array<{ pluginId: string; instanceId: string; sessionScope: string | null; enabled: boolean }>;
  let svc: ScopeBindingService;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-projection-unwritable-'));
    pluginsRoot = path.join(tmp, 'plugins');
    const values: Record<string, unknown> = { dataDir: tmp, 'plugins.dir': pluginsRoot };
    const configService = { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
    const storage = new PluginStorageService(configService);
    storage.setPluginEntry({
      id: 'p1',
      type: PluginType.EXTENSION,
      name: 'P1',
      version: '1.0.0',
      status: PluginStatus.ENABLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
      activeSessions: ['s1'],
      sessionConfig: { s1: { apiKey: 'tenant-A' } },
    });
    loader = new PluginLoaderService(configService, new HookManager(), storage, {
      get: jest.fn().mockReturnValue({ unregister: jest.fn() }),
    } as unknown as ModuleRef);
    plugin = {
      manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: PluginType.EXTENSION, main: 'index.js' },
      status: PluginStatus.ENABLED,
      config: {},
      instance: null,
      builtIn: false,
      activeSessions: ['s1'],
      sessionConfig: { s1: { apiKey: 'tenant-A' } },
    };
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
    siblings = [];
    const instances = { list: jest.fn(() => Promise.resolve(siblings)) };
    const audit = { logWarn: jest.fn().mockResolvedValue(undefined) };
    svc = new ScopeBindingService(instances as never, loader, audit as never, {} as never);
    fs.chmodSync(pluginsRoot, 0o500);
  });

  afterEach(() => {
    fs.chmodSync(pluginsRoot, 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a deleted instance stops receiving its session', async () => {
    await svc.applyScopeBinding('p1', 's1', {}, false);
    expect(plugin.activeSessions).not.toContain('s1');
  });

  it("a surviving sibling is not handed the retired instance's credentials", async () => {
    siblings = [{ pluginId: 'p1', instanceId: 'B', sessionScope: 's1', enabled: true }];
    await svc.applyScopeBinding('p1', 's1', {}, false);
    expect(plugin.sessionConfig?.s1).toBeUndefined();
  });

  it('the boot reconcile still binds an enabled instance in memory', async () => {
    await svc.applyScopeBinding('p1', 's2', { baseUrl: 'https://tenant-b' }, true, { additive: true });
    expect(plugin.activeSessions).toContain('s2');
    expect(plugin.sessionConfig?.s2).toEqual({ baseUrl: 'https://tenant-b' });
  });
});
