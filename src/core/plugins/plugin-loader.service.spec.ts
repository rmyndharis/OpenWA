import * as path from 'path';
import { resolvePluginMainPath, buildSandboxWorkerEnv } from './plugin-loader.service';

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

/**
 * Untrusted plugins run in a worker thread; the worker must NOT inherit the host's secrets. The
 * worker env is an allowlist, not a copy of process.env.
 */
describe('buildSandboxWorkerEnv', () => {
  it('forwards only the allowlisted vars and drops host secrets', () => {
    const env = buildSandboxWorkerEnv({
      NODE_ENV: 'production',
      TZ: 'UTC',
      NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
      API_MASTER_KEY: 'super-secret',
      API_KEY_PEPPER: 'pepper',
      DATABASE_PASSWORD: 'dbpw',
      DATABASE_URL: 'postgres://u:p@host/db',
      REDIS_URL: 'redis://u:p@host',
      DOCKER_HOST: 'tcp://0.0.0.0:2375',
    });

    expect(env.NODE_ENV).toBe('production');
    expect(env.TZ).toBe('UTC');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/certs/ca.pem');

    // Host secrets must never reach an untrusted plugin.
    expect(env.API_MASTER_KEY).toBeUndefined();
    expect(env.API_KEY_PEPPER).toBeUndefined();
    expect(env.DATABASE_PASSWORD).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it('omits allowlisted keys that are unset rather than emitting undefined entries', () => {
    const env = buildSandboxWorkerEnv({ NODE_ENV: 'development' });
    expect(env.NODE_ENV).toBe('development');
    expect('TZ' in env).toBe(false);
    expect('NODE_EXTRA_CA_CERTS' in env).toBe(false);
  });

  it('defaults NODE_ENV to production when the host has none', () => {
    expect(buildSandboxWorkerEnv({}).NODE_ENV).toBe('production');
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
      getPluginSessions: jest.fn().mockReturnValue(undefined),
      getPluginSessionConfig: jest.fn().mockReturnValue(undefined),
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

describe('PluginLoaderService — engine mutual exclusion', () => {
  let tmpDir: string;
  let storage: PluginStorageService;

  const engineManifest = (id: string): PluginManifest => ({
    id,
    name: id,
    version: '1.0.0',
    type: PluginType.ENGINE,
    main: 'index.js',
  });

  const makeLoader = (activeEngine: string): PluginLoaderService => {
    const config = {
      get: (k: string) => (k === 'engine.type' ? activeEngine : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    return new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-eng-'));
    storage = new PluginStorageService({
      get: (k: string) => (k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('rejects enabling an engine that is not the configured active engine', async () => {
    const loader = makeLoader('whatsapp-web.js');
    loader.registerBuiltInPlugin(engineManifest('baileys'), {});

    await expect(loader.enablePlugin('baileys')).rejects.toThrow(/active engine/i);
    // Rejected up front — the plugin stays INSTALLED (not flipped to ERROR).
    expect(loader.getPlugin('baileys')?.status).toBe(PluginStatus.INSTALLED);
  });

  it('allows enabling the configured active engine', async () => {
    const loader = makeLoader('baileys');
    loader.registerBuiltInPlugin(engineManifest('baileys'), {});

    await loader.enablePlugin('baileys');
    expect(loader.getPlugin('baileys')?.status).toBe(PluginStatus.ENABLED);
  });
});

describe('PluginLoaderService — uninstall', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let storage: PluginStorageService;
  let loader: PluginLoaderService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-uninst-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    loader = new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writeUserPlugin = (id: string): string => {
    const dir = path.join(pluginsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    return dir;
  };

  it('removes the plugin directory, registry entry, and runtime instance', async () => {
    const dir = writeUserPlugin('user-plg');
    loader.loadPlugin(dir);
    expect(storage.getPluginEntry('user-plg')).toBeDefined();

    await loader.uninstallPlugin('user-plg');

    expect(fs.existsSync(dir)).toBe(false);
    expect(storage.getPluginEntry('user-plg')).toBeUndefined();
    expect(loader.getPlugin('user-plg')).toBeUndefined();
  });

  it('refuses to uninstall a built-in plugin', async () => {
    loader.registerBuiltInPlugin(
      { id: 'core-engine', name: 'Core', version: '1.0.0', type: PluginType.ENGINE, main: 'x.js' },
      {},
    );
    await expect(loader.uninstallPlugin('core-engine')).rejects.toThrow(/built-in/i);
  });
});

describe('PluginLoaderService — enable concurrency', () => {
  let tmpDir: string;
  let loader: PluginLoaderService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-enable-'));
    const config = { get: (k: string) => (k === 'dataDir' ? tmpDir : undefined) } as unknown as ConfigService;
    loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('rejects a racing second enable instead of double-running onEnable', async () => {
    let enableCount = 0;
    const instance = {
      onEnable: async (): Promise<void> => {
        enableCount++;
        await new Promise(resolve => setTimeout(resolve, 25)); // keep the first enable in flight
      },
    } as unknown as IPlugin;
    loader.registerBuiltInPlugin(
      { id: 'race-plg', name: 'Race', version: '1.0.0', type: PluginType.EXTENSION, main: 'index.js' },
      instance,
    );

    const results = await Promise.allSettled([loader.enablePlugin('race-plg'), loader.enablePlugin('race-plg')]);

    // The first claims the lock and runs onEnable once; the second is rejected before any await.
    expect(enableCount).toBe(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/already being enabled/i);
    expect(loader.getPlugin('race-plg')?.status).toBe(PluginStatus.ENABLED);
  });
});

describe('PluginLoaderService — graceful shutdown (onModuleDestroy)', () => {
  let tmpDir: string;
  let loader: PluginLoaderService;

  const ext = (id: string): PluginManifest => ({
    id,
    name: id,
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.js',
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-shutdown-'));
    const config = { get: (k: string) => (k === 'dataDir' ? tmpDir : undefined) } as unknown as ConfigService;
    loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('runs onDisable for every enabled plugin on shutdown, best-effort past a failure', async () => {
    const okDisable = jest.fn(() => Promise.resolve());
    loader.registerBuiltInPlugin(ext('bad-plg'), {
      onDisable: () => Promise.reject(new Error('flush failed')),
    });
    loader.registerBuiltInPlugin(ext('ok-plg'), { onDisable: okDisable });
    await loader.enablePlugin('bad-plg');
    await loader.enablePlugin('ok-plg');

    await expect(loader.onModuleDestroy()).resolves.toBeUndefined();

    // The failing plugin's onDisable error didn't block the other from being disabled.
    expect(okDisable).toHaveBeenCalledTimes(1);
    expect(loader.getPlugin('ok-plg')?.status).toBe(PluginStatus.DISABLED);
  });
});
