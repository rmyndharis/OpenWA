import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import { PluginStatus, PluginType, type PluginManifest } from './plugin.interfaces';

// #856 — an operator's enable decision must survive a restart.
//
// Before this, `ensureRegistryEntry` rewrote the persisted status to INSTALLED on every load, so every
// restart silently turned off every extension plugin and destroyed the only record that it had been on.
// The intent is now persisted separately from the runtime status, and restored at bootstrap.
//
// The intent is written ONLY by the operator-facing enable/disable in PluginsService, never by the
// loader — which is what keeps the shutdown teardown (onModuleDestroy disables every enabled plugin)
// from wiping it on the way out. The last test here guards exactly that.

const manifest: PluginManifest = {
  id: 'ext-test',
  name: 'Ext Test',
  version: '1.0.0',
  type: PluginType.EXTENSION,
  main: 'index.js',
};

describe('PluginLoaderService — restoring the operator enable decision across a restart (#856)', () => {
  let tmpDir: string;
  let config: ConfigService;
  let storage: PluginStorageService;
  let loader: PluginLoaderService;
  let pluginDir: string;

  const makeLoader = (s: PluginStorageService): PluginLoaderService =>
    new PluginLoaderService(config, new HookManager(), s, {} as unknown as ModuleRef);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-restore-'));
    config = { get: (k: string) => (k === 'dataDir' ? tmpDir : undefined) } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    loader = makeLoader(storage);
    // A plugin on disk is only a manifest as far as loadPlugin is concerned — the code itself runs in
    // the sandbox worker, so no module is required here.
    pluginDir = path.join(tmpDir, 'plugins', manifest.id);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('carries the operator enable decision across a reload, even though the runtime status resets', () => {
    loader.loadPlugin(pluginDir);
    storage.setPluginEnabledByOperator(manifest.id, true);

    // Restart: fresh storage re-reads registry.json, fresh loader re-loads the plugin directory.
    const storage2 = new PluginStorageService(config);
    makeLoader(storage2).loadPlugin(pluginDir);

    const entry = storage2.getPluginEntry(manifest.id);
    // The runtime still comes up INSTALLED — enabling runs the lifecycle and must stay an explicit step.
    expect(entry?.status).toBe(PluginStatus.INSTALLED);
    // ...but the operator's intent is intact, which is what bootstrap acts on.
    expect(entry?.enabledByOperator).toBe(true);
  });

  it('adopts a pre-#856 entry that is still recorded as ENABLED, so an upgrade does not lose the decision', () => {
    // A registry written by an older build: status ENABLED (the operator enabled it after the last
    // boot, so nothing has overwritten it yet) and no enabledByOperator field at all.
    loader.loadPlugin(pluginDir);
    const entry = storage.getPluginEntry(manifest.id)!;
    delete (entry as { enabledByOperator?: boolean }).enabledByOperator;
    entry.status = PluginStatus.ENABLED;
    storage.setPluginEntry(entry);

    // First boot on the new build.
    const storage2 = new PluginStorageService(config);
    makeLoader(storage2).loadPlugin(pluginDir);

    expect(storage2.getPluginEntry(manifest.id)?.enabledByOperator).toBe(true);
  });

  it('leaves a plugin the operator never enabled alone', () => {
    loader.loadPlugin(pluginDir);

    const storage2 = new PluginStorageService(config);
    makeLoader(storage2).loadPlugin(pluginDir);

    expect(storage2.getPluginEntry(manifest.id)?.enabledByOperator).toBeFalsy();
  });

  it('enables the plugins the operator had enabled, at bootstrap', async () => {
    loader.loadPlugin(pluginDir);
    storage.setPluginEnabledByOperator(manifest.id, true);

    const storage2 = new PluginStorageService(config);
    const loader2 = makeLoader(storage2);
    loader2.loadPlugin(pluginDir);
    // Stub the real enable: the lifecycle spawns a sandbox worker, which is not what this asserts.
    const enable = jest.spyOn(loader2, 'enablePlugin').mockResolvedValue(undefined);

    await loader2.onApplicationBootstrap();

    expect(enable).toHaveBeenCalledWith(manifest.id);
  });

  it('does not enable a plugin the operator had not enabled', async () => {
    const storage2 = new PluginStorageService(config);
    const loader2 = makeLoader(storage2);
    loader2.loadPlugin(pluginDir);
    const enable = jest.spyOn(loader2, 'enablePlugin').mockResolvedValue(undefined);

    await loader2.onApplicationBootstrap();

    expect(enable).not.toHaveBeenCalled();
  });

  it('keeps booting when one plugin fails to come back, and still restores the others', async () => {
    const second: PluginManifest = { ...manifest, id: 'ext-two', name: 'Ext Two' };
    const secondDir = path.join(tmpDir, 'plugins', second.id);
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(path.join(secondDir, 'manifest.json'), JSON.stringify(second));

    const storage2 = new PluginStorageService(config);
    const loader2 = makeLoader(storage2);
    loader2.loadPlugin(pluginDir);
    loader2.loadPlugin(secondDir);
    storage2.setPluginEnabledByOperator(manifest.id, true);
    storage2.setPluginEnabledByOperator(second.id, true);

    const enable = jest
      .spyOn(loader2, 'enablePlugin')
      .mockImplementation((id: string) => (id === manifest.id ? Promise.reject(new Error('boom')) : Promise.resolve()));

    // A plugin that cannot come back must never hold up the gateway.
    await expect(loader2.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(enable).toHaveBeenCalledWith(second.id);
  });

  it('does not treat the shutdown teardown as the operator disabling the plugin', async () => {
    // The regression that makes this whole design fragile: onModuleDestroy disables every enabled
    // plugin on the way out. If teardown cleared the intent, one graceful restart would erase it and
    // the plugin would never come back — exactly the bug being fixed, just relocated.
    loader.loadPlugin(pluginDir);
    storage.setPluginEnabledByOperator(manifest.id, true);
    const plugin = loader.getPlugin(manifest.id)!;
    plugin.status = PluginStatus.ENABLED;
    jest.spyOn(loader, 'disablePlugin').mockResolvedValue(undefined);

    await loader.onModuleDestroy();

    expect(storage.getPluginEntry(manifest.id)?.enabledByOperator).toBe(true);
  });
});
