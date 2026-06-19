import * as path from 'path';
import { resolvePluginMainPath } from './plugin-loader.service';

/** Regression lock: a plugin's manifest.main must not escape its plugin directory. */
describe('resolvePluginMainPath', () => {
  const dir = '/app/data/plugins';

  it('allows a normal entry inside the plugin directory', () => {
    expect(resolvePluginMainPath(dir, 'my-plugin', 'index.js')).toBe(path.resolve(dir, 'my-plugin', 'index.js'));
    expect(resolvePluginMainPath(dir, 'my-plugin', 'dist/main.js')).toBe(
      path.resolve(dir, 'my-plugin', 'dist/main.js'),
    );
  });

  it('rejects a path-traversal escape (../../)', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '../../etc/passwd')).toThrow(/escapes/);
  });

  it('rejects an absolute path', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '/etc/passwd')).toThrow(/escapes/);
  });

  it('rejects climbing into a sibling plugin', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '../other-plugin/evil.js')).toThrow(/escapes/);
  });
});

import * as fs from 'fs';
import * as os from 'os';
import { PluginLoaderService } from './plugin-loader.service';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { HookManager } from '../hooks';
import { PluginStorageService } from './plugin-storage.service';
import { IPlugin, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';

describe('PluginLoaderService.registerBuiltInPlugin config', () => {
  function makeLoader(): PluginLoaderService {
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const pluginStorage = {
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginEntry: jest.fn(),
      getPluginConfig: jest.fn().mockReturnValue(null),
    } as unknown as PluginStorageService;
    return new PluginLoaderService(configService, new HookManager(), pluginStorage, {} as unknown as ModuleRef);
  }
  const manifest: PluginManifest = {
    id: 'cfg-test',
    name: 'Cfg Test',
    version: '1.0.0',
    type: PluginType.ENGINE,
    main: 'index.ts',
  };
  const instance = {} as unknown as IPlugin;

  it('stores the supplied config on the plugin instance', () => {
    const loader = makeLoader();
    loader.registerBuiltInPlugin(manifest, instance, { sessionDataPath: '/d', puppeteer: { headless: false } });
    expect(loader.getPlugin('cfg-test')?.config).toEqual({ sessionDataPath: '/d', puppeteer: { headless: false } });
  });

  it('defaults to an empty config when none is supplied (back-compat)', () => {
    const loader = makeLoader();
    loader.registerBuiltInPlugin(manifest, instance);
    expect(loader.getPlugin('cfg-test')?.config).toEqual({});
  });
});

describe('PluginLoaderService — enable/config persistence', () => {
  let tmpDir: string;
  let config: ConfigService;
  let storage: PluginStorageService;
  let loader: PluginLoaderService;

  const manifest: PluginManifest = {
    id: 'persist-test',
    name: 'Persist Test',
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.js',
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-plugin-'));
    config = { get: (k: string) => (k === 'dataDir' ? tmpDir : undefined) } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    loader = new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a complete INSTALLED registry entry on register so a status write persists across a restart', () => {
    loader.registerBuiltInPlugin(manifest, {}, { apiKey: 'default' });
    const entry = storage.getPluginEntry('persist-test');
    expect(entry).toMatchObject({
      id: 'persist-test',
      status: PluginStatus.INSTALLED,
      builtIn: true,
    });

    // The status write now lands (previously a silent no-op because no entry existed).
    storage.setPluginStatus('persist-test', PluginStatus.ENABLED);

    // Durable: a fresh storage instance re-reads registry.json (simulates a restart).
    expect(new PluginStorageService(config).getPluginStatus('persist-test')).toBe(PluginStatus.ENABLED);
  });

  it('keeps using live env config for a built-in across restarts (the first snapshot must not freeze it)', () => {
    // Boot 1: register with one env-derived default, no operator edit.
    loader.registerBuiltInPlugin(manifest, {}, { execPath: '/old/chromium', headless: true });

    // Boot 2: env changed (e.g. operator set PUPPETEER_EXECUTABLE_PATH on a new image) → the live value wins.
    const storage2 = new PluginStorageService(config);
    const loader2 = new PluginLoaderService(config, new HookManager(), storage2, {} as unknown as ModuleRef);
    loader2.registerBuiltInPlugin(manifest, {}, { execPath: '/new/chromium', headless: true });

    expect(loader2.getPlugin('persist-test')?.config).toEqual({ execPath: '/new/chromium', headless: true });
  });

  it('reports a re-registered plugin as installed after restart even if it was enabled (no boot auto-enable, no divergence)', () => {
    loader.registerBuiltInPlugin(manifest, {}, {});
    storage.setPluginStatus('persist-test', PluginStatus.ENABLED); // operator enabled it

    // Restart: re-register the built-in.
    const storage2 = new PluginStorageService(config);
    const loader2 = new PluginLoaderService(config, new HookManager(), storage2, {} as unknown as ModuleRef);
    loader2.registerBuiltInPlugin(manifest, {}, {});

    // Runtime is INSTALLED (not auto-enabled) AND the registry agrees (no enabled/installed divergence).
    expect(loader2.getPlugin('persist-test')?.status).toBe(PluginStatus.INSTALLED);
    expect(storage2.getPluginStatus('persist-test')).toBe(PluginStatus.INSTALLED);
  });

  it('writes registry.json without group/other access (plugin config can hold secrets)', () => {
    loader.registerBuiltInPlugin(manifest, {}, { apiKey: 'secret' });
    const mode = fs.statSync(path.join(tmpDir, 'plugins', 'registry.json')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('restores the operator config on the next load instead of resetting to the default', () => {
    loader.registerBuiltInPlugin(manifest, {}, { apiKey: 'default' });
    loader.updatePluginConfig('persist-test', { apiKey: 'operator-secret' });
    expect(storage.getPluginConfig('persist-test')).toEqual({ apiKey: 'operator-secret' });

    // Restart: re-register the built-in with its default config — the persisted operator config wins.
    const storage2 = new PluginStorageService(config);
    const loader2 = new PluginLoaderService(config, new HookManager(), storage2, {} as unknown as ModuleRef);
    loader2.registerBuiltInPlugin(manifest, {}, { apiKey: 'default' });
    expect(loader2.getPlugin('persist-test')?.config).toEqual({ apiKey: 'operator-secret' });
  });
});
