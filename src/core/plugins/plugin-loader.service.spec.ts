import * as path from 'path';
import { resolvePluginMainPath, buildSandboxWorkerEnv, dispatchConversationMedia } from './plugin-loader.service';

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

/** conversation.send media types must route to the matching MessageService method (not a copy-paste sibling). */
describe('dispatchConversationMedia', () => {
  const svc = () => ({
    sendImage: jest.fn().mockResolvedValue({ messageId: 'i' }),
    sendVideo: jest.fn().mockResolvedValue({ messageId: 'v' }),
    sendAudio: jest.fn().mockResolvedValue({ messageId: 'a' }),
    sendDocument: jest.fn().mockResolvedValue({ messageId: 'd' }),
  });
  const opts = (type: 'image' | 'video' | 'audio' | 'file') => ({
    chatId: 'c@c.us',
    url: 'https://cdn.example/m',
    caption: 'cap',
    type,
  });

  it.each([
    ['image', 'sendImage'],
    ['video', 'sendVideo'],
    ['audio', 'sendAudio'],
    ['file', 'sendDocument'],
  ] as const)('routes %s to %s with a url+caption DTO (no ptt)', async (type, method) => {
    const s = svc();
    await dispatchConversationMedia(s, 's', opts(type));
    expect(s[method]).toHaveBeenCalledWith('s', { chatId: 'c@c.us', url: 'https://cdn.example/m', caption: 'cap' });
    // No sibling method is invoked for the wrong type.
    for (const other of ['sendImage', 'sendVideo', 'sendAudio', 'sendDocument'] as const) {
      if (other !== method) expect(s[other]).not.toHaveBeenCalled();
    }
  });

  it("routes 'voice' to sendAudio with ptt:true so it renders as a WhatsApp voice note", async () => {
    const s = svc();
    await dispatchConversationMedia(s, 's', { chatId: 'c@c.us', url: 'https://cdn.example/n.ogg', type: 'voice' });
    expect(s.sendAudio).toHaveBeenCalledWith('s', {
      chatId: 'c@c.us',
      url: 'https://cdn.example/n.ogg',
      caption: undefined,
      ptt: true,
    });
    for (const other of ['sendImage', 'sendVideo', 'sendDocument'] as const) {
      expect(s[other]).not.toHaveBeenCalled();
    }
  });
});

import * as fs from 'fs';
import * as os from 'os';
import { PluginLoaderService } from './plugin-loader.service';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { HookManager } from '../hooks';
import { PluginStorageService } from './plugin-storage.service';
import { IPlugin, PluginContext, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { SearchProviderRegistry } from '../../modules/search/search-provider.registry';
import { WorkerThreadChannel } from './sandbox/worker-thread-channel';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { PluginLogLevel } from './sandbox/protocol';

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
    const registryPath = path.join(tmpDir, 'plugins', 'registry.json');
    expect(fs.existsSync(registryPath)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(registryPath).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
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

  it('rejects a plugin that declares ingress routes but omits the webhook:ingress permission', () => {
    // loadPlugin must run validateIngressManifest, so a malformed ingress declaration fails to load
    // rather than silently loading and becoming provisionable.
    const dir = path.join(pluginsDir, 'bad-ingress');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'bad-ingress',
        name: 'Bad Ingress',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        ingress: [{ route: 'events', signature: { headerName: 'X-Sig', scheme: 'hmac-sha256' } }],
        // permissions intentionally omitted → validateIngressManifest must reject
      }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    expect(() => loader.loadPlugin(dir)).toThrow(/webhook:ingress/i);
  });
});

describe('PluginLoaderService — skips dot-prefixed directories on load (crash-leftover .bak)', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-dotskip-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    loader = new PluginLoaderService(
      config,
      new HookManager(),
      new PluginStorageService(config),
      {} as unknown as ModuleRef,
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const writePlugin = (dirName: string, id: string): void => {
    const dir = path.join(pluginsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
  };

  it('does not scan a crash-leftover .<id>.bak directory (no duplicate-id load race)', () => {
    writePlugin('svc-plg', 'svc-plg');
    writePlugin('.svc-plg.bak', 'svc-plg'); // a leftover update backup carrying the SAME manifest id

    const loadSpy = jest.spyOn(loader, 'loadPlugin');
    loader.onModuleInit();

    const scanned = loadSpy.mock.calls.map(c => c[0]);
    expect(scanned).toContain(path.join(pluginsDir, 'svc-plg'));
    expect(scanned).not.toContain(path.join(pluginsDir, '.svc-plg.bak'));
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

describe('PluginLoaderService — enable-failure hook cleanup', () => {
  let tmpDir: string;
  let hooks: HookManager;
  let loader: PluginLoaderService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-enfail-'));
    const config = { get: (k: string) => (k === 'dataDir' ? tmpDir : undefined) } as unknown as ConfigService;
    hooks = new HookManager();
    loader = new PluginLoaderService(config, hooks, new PluginStorageService(config), {} as unknown as ModuleRef);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('does not leak hook registrations when an enable attempt fails, so a later enable does not double-dispatch', async () => {
    let shouldThrow = true;
    const instance = {
      onEnable: (ctx: PluginContext): Promise<void> => {
        // The plugin subscribes a hook, then its enable fails (e.g. a transient connect timeout).
        ctx.registerHook('message:received', () => Promise.resolve({ continue: true }));
        return shouldThrow ? Promise.reject(new Error('transient onEnable failure')) : Promise.resolve();
      },
    } as unknown as IPlugin;
    loader.registerBuiltInPlugin(
      { id: 'flaky-plg', name: 'Flaky', version: '1.0.0', type: PluginType.EXTENSION, main: 'index.js' },
      instance,
    );

    // First enable fails AFTER the hook was registered → the registration must not survive.
    await expect(loader.enablePlugin('flaky-plg')).rejects.toThrow(/transient/);
    expect(loader.getPlugin('flaky-plg')?.status).toBe(PluginStatus.ERROR);

    // Retry succeeds.
    shouldThrow = false;
    await loader.enablePlugin('flaky-plg');
    expect(loader.getPlugin('flaky-plg')?.status).toBe(PluginStatus.ENABLED);

    // Exactly one handler — the failed attempt left nothing behind. Without cleanup this is 2,
    // and every message:received would dispatch to the plugin twice.
    expect(hooks.getHookCount('message:received')).toBe(1);
  });
});

describe('PluginLoaderService.dispatchWebhookForInstance config delivery', () => {
  it('delivers the instance-session-resolved config to the sandbox host', async () => {
    const fakeInstanceService = { resolve: jest.fn().mockResolvedValue({ sessionScope: 'sess-1' }) };
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const pluginStorage = {
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginEntry: jest.fn(),
      getPluginConfig: jest.fn().mockReturnValue(null),
      getPluginSessions: jest.fn().mockReturnValue(undefined),
      getPluginSessionConfig: jest.fn().mockReturnValue(undefined),
    } as unknown as PluginStorageService;
    const moduleRef = { get: jest.fn().mockReturnValue(fakeInstanceService) } as unknown as ModuleRef;
    const loader = new PluginLoaderService(configService, new HookManager(), pluginStorage, moduleRef);

    const internals = loader as unknown as {
      plugins: Map<string, unknown>;
      sandboxHosts: Map<string, { dispatchWebhook: jest.Mock }>;
    };
    internals.plugins.set('chatwoot-adapter', {
      manifest: { id: 'chatwoot-adapter', sessionScoped: true },
      config: { baseUrl: 'base', accountId: 1 },
      sessionConfig: { 'sess-1': { baseUrl: 'https://tenant1' } },
    });
    const dispatchWebhook = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    internals.sandboxHosts.set('chatwoot-adapter', { dispatchWebhook });

    await loader.dispatchWebhookForInstance({
      pluginId: 'chatwoot-adapter',
      instanceId: 'acct1',
      route: 'chatwoot',
      deliveryId: 'd1',
      sessionId: 'sess-1',
      payload: { headers: {}, query: {}, body: '', rawBody: '' },
    });

    expect(fakeInstanceService.resolve).toHaveBeenCalledWith('chatwoot-adapter', 'acct1');
    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
    // Session override (tenant1) merged over the base — this is what makes an instance multi-tenant.
    expect(dispatchWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ config: { baseUrl: 'https://tenant1', accountId: 1 } }),
    );
  });
});

describe('PluginLoaderService — search-provider wiring', () => {
  function makeLoader(moduleRefGet: jest.Mock): PluginLoaderService {
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const pluginStorage = {
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginEntry: jest.fn(),
      setPluginStatus: jest.fn(),
      getPluginConfig: jest.fn().mockReturnValue(null),
      getPluginSessions: jest.fn().mockReturnValue(undefined),
      getPluginSessionConfig: jest.fn().mockReturnValue(undefined),
      createPluginStorage: jest
        .fn()
        .mockReturnValue({ get: jest.fn(), set: jest.fn(), delete: jest.fn(), list: jest.fn() }),
    } as unknown as PluginStorageService;
    return new PluginLoaderService(configService, new HookManager(), pluginStorage, {
      get: moduleRefGet,
    } as unknown as ModuleRef);
  }

  it('getSearchRegistry returns the registry when ModuleRef has it', () => {
    const registry = new SearchProviderRegistry();
    const loader = makeLoader(jest.fn().mockReturnValue(registry));
    expect((loader as unknown as { getSearchRegistry: () => unknown }).getSearchRegistry()).toBe(registry);
  });

  it('getSearchRegistry returns undefined when ModuleRef has no registry (search disabled)', () => {
    const loader = makeLoader(
      jest.fn().mockImplementation(() => {
        throw new Error('not found');
      }),
    );
    expect((loader as unknown as { getSearchRegistry: () => unknown }).getSearchRegistry()).toBeUndefined();
  });

  it('disablePlugin unregisters the plugin’s search-provider entry', async () => {
    const registry = new SearchProviderRegistry();
    registry.register({ id: 'plugin:disable-test', label: 'p', search: jest.fn(), health: jest.fn() });
    const loader = makeLoader(jest.fn().mockReturnValue(registry));
    const manifest: PluginManifest = {
      id: 'disable-test',
      name: 'Disable Test',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      main: 'index.js',
    };
    loader.registerBuiltInPlugin(manifest, {});
    await loader.enablePlugin('disable-test'); // builtIn → enableInProcess, status→ENABLED
    expect(registry.list().map(p => p.id)).toContain('plugin:disable-test');

    await loader.disablePlugin('disable-test');

    expect(registry.list().map(p => p.id)).not.toContain('plugin:disable-test');
  });
});

describe('PluginLoaderService — search-provider enable-failure cleanup', () => {
  jest.setTimeout(30000);
  let tmpDir: string;
  const BOOTSTRAP = path.resolve(__dirname, 'sandbox/worker-bootstrap.ts');
  const TS_NODE_OPTS = JSON.stringify({
    module: 'commonjs',
    moduleResolution: 'node',
    resolvePackageJsonExports: false,
  });

  // Runs the REAL worker (ts-node) instead of the compiled dist bootstrap, so enableSandboxed
  // exercises its true load/lifecycle/catch path with a live worker thread.
  class RealWorkerLoader extends PluginLoaderService {
    protected createSandboxHost(
      capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
      onHookSubscribe?: (event: string, priority?: number) => void,
      onWebhookSubscribe?: (route: string) => void,
      onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
      runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
      onSearchProviderRegister?: () => void,
    ): PluginWorkerHost {
      return new PluginWorkerHost(
        new WorkerThreadChannel({
          workerEntry: BOOTSTRAP,
          execArgv: ['-r', 'ts-node/register/transpile-only'],
          env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TS_NODE_OPTS },
        }),
        capDispatcher,
        onHookSubscribe,
        onWebhookSubscribe,
        onLog,
        runWithHookGuard,
        undefined,
        onSearchProviderRegister,
      );
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-search-ef-'));
    fs.mkdirSync(path.join(tmpDir, 'rt'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'rt', 'manifest.json'),
      JSON.stringify({ id: 'rt', name: 'RT', version: '1.0.0', type: 'EXTENSION', main: 'index.cjs' }),
    );
    // Fixture: register a search provider, THEN throw in onEnable — so the host has received
    // search-provider-register (and activated the provider in auto mode) before enable fails.
    fs.writeFileSync(
      path.join(tmpDir, 'rt', 'index.cjs'),
      "module.exports = class { async onEnable(ctx) { ctx.registerSearchProvider(async () => ({ hits: [], total: 0, tookMs: 1, provider: 'plugin:rt' })); throw new Error('onEnable failed'); } };",
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('unregisters the search provider when enable fails after registration (no dead active provider)', async () => {
    const registry = new SearchProviderRegistry();
    registry.register({ id: 'builtin-fts', label: 'b', search: jest.fn(), health: jest.fn() });
    const config = {
      get: (k: string) =>
        k === 'search.provider' ? 'auto' : k === 'plugins.dir' || k === 'dataDir' ? tmpDir : undefined,
    } as unknown as ConfigService;
    const storage = new PluginStorageService(config);
    const loader = new RealWorkerLoader(config, new HookManager(), storage, {
      get: () => registry,
    } as unknown as ModuleRef);

    loader.loadPlugin(path.join(tmpDir, 'rt'));
    await expect(loader.enablePlugin('rt')).rejects.toThrow('onEnable failed');

    // Registered mid-onEnable, then onEnable threw → the catch must unregister the dead provider.
    expect(registry.list().map(p => p.id)).not.toContain('plugin:rt');
    expect(registry.active()?.id).toBe('builtin-fts');
  });
});

describe('PluginLoaderService — search-provider worker-crash fallback', () => {
  jest.setTimeout(30000);
  let tmpDir: string;
  const BOOTSTRAP = path.resolve(__dirname, 'sandbox/worker-bootstrap.ts');
  const TS_NODE_OPTS = JSON.stringify({
    module: 'commonjs',
    moduleResolution: 'node',
    resolvePackageJsonExports: false,
  });

  // Real ts-node worker (so enableSandboxed runs its true path) that captures the host so the test can
  // crash it.
  class CapturingLoader extends PluginLoaderService {
    lastHost?: PluginWorkerHost;
    protected createSandboxHost(
      capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
      onHookSubscribe?: (event: string, priority?: number) => void,
      onWebhookSubscribe?: (route: string) => void,
      onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
      runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
      onSearchProviderRegister?: () => void,
      onWorkerExit?: (code: number) => void,
    ): PluginWorkerHost {
      const host = new PluginWorkerHost(
        new WorkerThreadChannel({
          workerEntry: BOOTSTRAP,
          execArgv: ['-r', 'ts-node/register/transpile-only'],
          env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TS_NODE_OPTS },
        }),
        capDispatcher,
        onHookSubscribe,
        onWebhookSubscribe,
        onLog,
        runWithHookGuard,
        undefined,
        onSearchProviderRegister,
        onWorkerExit,
      );
      this.lastHost = host;
      return host;
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-search-crash-'));
    fs.mkdirSync(path.join(tmpDir, 'ok'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'ok', 'manifest.json'),
      JSON.stringify({ id: 'ok', name: 'OK', version: '1.0.0', type: 'EXTENSION', main: 'index.cjs' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ok', 'index.cjs'),
      "module.exports = class { async onEnable(ctx) { ctx.registerSearchProvider(async () => ({ hits: [], total: 0, tookMs: 1, provider: 'plugin:ok' })); } };",
    );
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('falls back to builtin-fts when the plugin worker crashes after a successful enable', async () => {
    const registry = new SearchProviderRegistry();
    registry.register({ id: 'builtin-fts', label: 'b', search: jest.fn(), health: jest.fn() });
    const config = {
      get: (k: string) =>
        k === 'search.provider' ? 'auto' : k === 'plugins.dir' || k === 'dataDir' ? tmpDir : undefined,
    } as unknown as ConfigService;
    const storage = new PluginStorageService(config);
    const loader = new CapturingLoader(config, new HookManager(), storage, {
      get: () => registry,
    } as unknown as ModuleRef);

    loader.loadPlugin(path.join(tmpDir, 'ok'));
    await loader.enablePlugin('ok'); // registers + setActive -> active = plugin:ok
    expect(registry.active()?.id).toBe('plugin:ok');

    // Worker crashes (unexpected exit) — terminate() emits the worker 'exit' event -> handleExit -> onWorkerExit.
    await loader.lastHost!.terminate();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    expect(registry.list().map(p => p.id)).not.toContain('plugin:ok');
    expect(registry.active()?.id).toBe('builtin-fts'); // fell back, not pinned to the dead plugin
  });
});
