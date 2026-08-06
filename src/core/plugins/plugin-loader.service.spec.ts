import * as path from 'path';
import { resolvePluginMainPath, buildSandboxWorkerEnv } from './plugin-loader.service';
import { dispatchConversationMedia } from './plugin-capability-context';

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
import configuration from '../../config/configuration';
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

  it('reports a re-registered plugin as installed: registering never runs it, and the registry agrees', () => {
    loader.registerBuiltInPlugin(manifest, {}, {});
    storage.setPluginStatus('persist-test', PluginStatus.ENABLED); // operator enabled it

    // Restart: re-register the built-in.
    const storage2 = new PluginStorageService(config);
    const loader2 = new PluginLoaderService(config, new HookManager(), storage2, {} as unknown as ModuleRef);
    loader2.registerBuiltInPlugin(manifest, {}, {});

    // Runtime is INSTALLED (registering does not run the lifecycle) AND the registry agrees, so there
    // is no enabled/installed divergence. Restoring an operator-enabled plugin is a separate step that
    // happens at bootstrap and skips built-ins — see plugin-restore-on-boot.spec.ts (#856).
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

describe('PluginLoaderService — prunes registry ghosts of removed built-ins', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-ghosts-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    loader = new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const seedGhost = (id: string): void => {
    // A leftover directory with no manifest (code deleted) + a stale registry entry still claiming
    // the plugin is installed — the ghost state upgrades from <=0.6 are in.
    fs.mkdirSync(path.join(pluginsDir, id), { recursive: true });
    storage.setPluginEntry({
      id,
      type: 'extension',
      name: id,
      version: '1.0.0',
      status: 'installed',
      config: {},
      builtIn: true,
      installedAt: new Date(),
      updatedAt: new Date(),
    } as never);
  };

  it('prunes registry entries of legacy removed built-ins (auto-reply, translation) with no manifest', () => {
    seedGhost('auto-reply');
    seedGhost('translation');

    loader.onModuleInit();

    expect(storage.getPluginEntry('auto-reply')).toBeUndefined();
    expect(storage.getPluginEntry('translation')).toBeUndefined();
  });

  it('keeps a manifest-less NON-legacy plugin entry (config survives an unreadable dir)', () => {
    seedGhost('some-other-plugin');

    loader.onModuleInit();

    expect(storage.getPluginEntry('some-other-plugin')).toBeDefined();
  });
});

describe('PluginLoaderService — boot reconciles the registry entry of a plugin it drops', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let storage: PluginStorageService;

  const config = () =>
    ({
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    }) as unknown as ConfigService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-drop-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    storage = new PluginStorageService(config());
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const makeLoader = (): PluginLoaderService =>
    new PluginLoaderService(config(), new HookManager(), storage, {} as unknown as ModuleRef);

  const writePlugin = (id: string, manifest: Record<string, unknown>): void => {
    const dir = path.join(pluginsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
  };

  it('marks the persisted entry ERROR when boot-time manifest validation drops a previously-installed plugin', () => {
    // Boot 1: a valid hand-placed plugin loads and gets its registry entry.
    writePlugin('hand-placed', {
      id: 'hand-placed',
      name: 'Hand',
      version: '1.0.0',
      type: 'extension',
      main: 'index.js',
    });
    makeLoader().onModuleInit();
    expect(storage.getPluginEntry('hand-placed')?.status).toBe(PluginStatus.INSTALLED);
    // The operator's config + standing enable decision live in that entry.
    storage.setPluginConfig('hand-placed', { apiKey: 'keep-me' });
    storage.setPluginEnabledByOperator('hand-placed', true);

    // Boot 2: the manifest was hand-edited into something the installer would have rejected
    // (missing required field) — the plugin is dropped from the runtime...
    writePlugin('hand-placed', { id: 'hand-placed', name: 'Hand', type: 'extension', main: 'index.js' });
    const loader2 = makeLoader();
    loader2.onModuleInit();
    expect(loader2.getPlugin('hand-placed')).toBeUndefined();

    // ...and the registry no longer claims it installed. The entry itself (config,
    // enabledByOperator) survives, so fixing the manifest and rebooting re-enables it.
    const entry = storage.getPluginEntry('hand-placed');
    expect(entry?.status).toBe(PluginStatus.ERROR);
    expect(entry?.config).toEqual({ apiKey: 'keep-me' });
    expect(entry?.enabledByOperator).toBe(true);
  });

  it('a hand-placed plugin that fails validation without a registry entry simply does not load', () => {
    writePlugin('never-installed', { id: 'never-installed', name: 'Nope', type: 'extension', main: 'index.js' });

    const loader = makeLoader();
    loader.onModuleInit();

    expect(loader.getPlugin('never-installed')).toBeUndefined();
    // No entry existed, so the ERROR reconciliation is a no-op — none is invented either.
    expect(storage.getPluginEntry('never-installed')).toBeUndefined();
  });
});

describe('PluginLoaderService — loadPlugin seeds configSchema defaults', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-seed-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    loader = new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('seeds defaults into the runtime instance and the persisted registry entry at load', () => {
    const dir = path.join(pluginsDir, 'seeded-plg');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        id: 'seeded-plg',
        name: 'seeded-plg',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        configSchema: {
          type: 'object',
          properties: { timezone: { type: 'string', default: 'UTC' } },
        },
      }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');

    loader.onModuleInit();

    expect(loader.getPlugin('seeded-plg')?.config).toEqual({ timezone: 'UTC' });
    expect(storage.getPluginEntry('seeded-plg')?.config).toEqual({ timezone: 'UTC' });
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
      manifest: {
        id: 'chatwoot-adapter',
        sessionScoped: true,
        ingress: [{ route: 'chatwoot', signature: { scheme: 'none' } }],
      },
      config: { baseUrl: 'base', accountId: 1 },
      sessionConfig: { 'sess-1': { baseUrl: 'https://tenant1' } },
    });
    const dispatchWebhook = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    internals.sandboxHosts.set('chatwoot-adapter', { dispatchWebhook });

    await loader.dispatchWebhookForInstance({
      pluginId: 'chatwoot-adapter',
      instanceId: 'acct1',
      route: 'chatwoot',
      method: 'PATCH',
      deliveryId: 'd1',
      sessionId: 'sess-1',
      payload: { headers: {}, query: {}, body: '', rawBody: '' },
    });

    expect(fakeInstanceService.resolve).toHaveBeenCalledWith('chatwoot-adapter', 'acct1');
    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
    // Session override (tenant1) merged over the base — this is what makes an instance multi-tenant.
    expect(dispatchWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { baseUrl: 'https://tenant1', accountId: 1 },
        method: 'PATCH',
        verified: false,
      }),
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

  // getSearchRegistry's own behaviour now lives in plugin-host-services.spec.ts, tested on the class
  // that owns it instead of through a private reach-in on the loader.

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
    // TypeScript 6 rejects the legacy resolution pair unless acknowledged. Revisit before TS 7.
    ignoreDeprecations: '6.0',
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
      JSON.stringify({ id: 'rt', name: 'RT', version: '1.0.0', type: 'extension', main: 'index.cjs' }),
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
    // TypeScript 6 rejects the legacy resolution pair unless acknowledged. Revisit before TS 7.
    ignoreDeprecations: '6.0',
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
      onWorkerExit?: (code: number, intentional: boolean) => void,
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
      JSON.stringify({
        id: 'ok',
        name: 'OK',
        version: '1.0.0',
        type: 'extension',
        main: 'index.cjs',
        // This suite is about crash fallback, so the fixture must be a plugin the search bridge accepts.
        permissions: ['search:provide'],
      }),
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

  it('never activates a plugin that registers a search provider without declaring search:provide', async () => {
    // Same fixture, permission removed: ctx.registerSearchProvider is installed in EVERY worker context,
    // so this is the whole distance between an undeclared plugin and serving every /search query.
    fs.writeFileSync(
      path.join(tmpDir, 'ok', 'manifest.json'),
      JSON.stringify({ id: 'ok', name: 'OK', version: '1.0.0', type: 'extension', main: 'index.cjs' }),
    );
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
    await loader.enablePlugin('ok');

    // Assert BEFORE reaping: terminate() runs onWorkerExit -> unregisterPluginSearchProvider, which
    // drops plugin:ok and restores builtin-fts on its own. Asserting after it would pass whether or
    // not the permission gate works at all. The finally still reaps, so no worker handle leaks.
    try {
      expect(registry.list().map(p => p.id)).not.toContain('plugin:ok');
      expect(registry.active()?.id).toBe('builtin-fts'); // auto mode must NOT hand the gateway to it
    } finally {
      await loader.lastHost!.terminate();
    }
  });
});

describe('PluginLoaderService — boot-time manifest validation parity with install', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-bootval-'));
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

  const writePlugin = (id: string, manifest: unknown, withMain = true): string => {
    const dir = path.join(pluginsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
    if (withMain) fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    return dir;
  };
  const baseManifest = (id: string): Record<string, unknown> => ({
    id,
    name: id,
    version: '1.0.0',
    type: 'extension',
    main: 'index.js',
  });

  it('rejects the same invalid manifests install rejects (fields, id, reserved, type)', () => {
    // Missing a required field.
    const noName = baseManifest('no-name');
    delete noName.name;
    expect(() => loader.loadPlugin(writePlugin('no-name', noName))).toThrow(/required field: name/i);
    // A non-string required field (truthy — passed the old bare falsy check).
    expect(() => loader.loadPlugin(writePlugin('num-main', { ...baseManifest('num-main'), main: 123 }))).toThrow(
      /invalid required field/i,
    );
    // Unsafe id.
    expect(() => loader.loadPlugin(writePlugin('bad id', { ...baseManifest('bad id'), id: 'bad id' }))).toThrow(
      /invalid plugin id/i,
    );
    // Reserved built-in id (would shadow the baileys engine).
    expect(() => loader.loadPlugin(writePlugin('baileys', baseManifest('baileys')))).toThrow(/reserved/i);
    // A non-extension tier (engines are built-in, never directory-loadable).
    expect(() => loader.loadPlugin(writePlugin('my-eng', { ...baseManifest('my-eng'), type: 'engine' }))).toThrow(
      /not installable/i,
    );
    // A non-object manifest document.
    expect(() => loader.loadPlugin(writePlugin('arr-plg', '[]'))).toThrow(/must be a JSON object/i);
  });

  it('rejects a manifest whose main escapes the plugin directory', () => {
    const dir = writePlugin('trav-plg', { ...baseManifest('trav-plg'), main: '../other/evil.js' });
    expect(() => loader.loadPlugin(dir)).toThrow(/escapes the plugin directory/i);
  });

  it('rejects a manifest whose main file is missing from the directory', () => {
    const dir = writePlugin('gone-main', { ...baseManifest('gone-main'), main: 'gone.js' });
    expect(() => loader.loadPlugin(dir)).toThrow(/main file not found/i);
  });
});

describe('PluginLoaderService — interrupted-update recovery at boot', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-uprec-'));
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

  const writePluginTree = (dirName: string, id: string, version = '1.0.0'): void => {
    const dir = path.join(pluginsDir, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ id, name: id, version, type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
  };

  it('restores the backup as the live dir when a crash mid-swap lost the live dir', () => {
    // Crash between `rename(live → backup)` and `rename(staging → live)`: the live dir is gone, the
    // backup holds the previous version, and staging never landed.
    writePluginTree('.svc-plg.bak', 'svc-plg');
    writePluginTree('.svc-plg.new', 'svc-plg', '2.0.0');

    loader.onModuleInit();

    // The previous version is back as the live dir and loads normally — the plugin no longer
    // silently vanishes while its registry entry still claims it is installed.
    expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
  });

  it('drops a stale backup when the live dir exists (crash after the swap completed)', () => {
    writePluginTree('svc-plg', 'svc-plg', '2.0.0'); // the swapped-in new version
    writePluginTree('.svc-plg.bak', 'svc-plg'); // leftover backup of the old one

    loader.onModuleInit();

    expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('2.0.0');
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
  });

  it('drops a stale staging tree (crash before the swap ever started)', () => {
    writePluginTree('svc-plg', 'svc-plg');
    writePluginTree('.svc-plg.new', 'svc-plg', '2.0.0');

    loader.onModuleInit();

    expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
    expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
  });

  it('leaves an unrelated dot-prefixed directory alone', () => {
    writePluginTree('svc-plg', 'svc-plg');
    fs.mkdirSync(path.join(pluginsDir, '.gitkeep.d'), { recursive: true });

    loader.onModuleInit();

    expect(fs.existsSync(path.join(pluginsDir, '.gitkeep.d'))).toBe(true);
    expect(loader.getPlugin('svc-plg')).toBeDefined();
  });
});

describe('PluginLoaderService — onUnload dispatch', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let loader: PluginLoaderService;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-onunload-'));
    pluginsDir = path.join(tmpDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
    } as unknown as ConfigService;
    storage = new PluginStorageService(config);
    loader = new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const extManifest = (id: string): PluginManifest => ({
    id,
    name: id,
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.js',
  });

  it('runs an in-process plugin’s onUnload on the uninstall path (after onDisable)', async () => {
    const calls: string[] = [];
    const instance = {
      onDisable: () => {
        calls.push('onDisable');
        return Promise.resolve();
      },
      onUnload: () => {
        calls.push('onUnload');
        return Promise.resolve();
      },
    } as unknown as IPlugin;
    loader.registerBuiltInPlugin(extManifest('un-plg'), instance);
    // Built-ins can't be uninstalled, so drive the same unload path an uninstall takes.
    await loader.enablePlugin('un-plg');
    await loader.unloadPlugin('un-plg');

    expect(calls).toEqual(['onDisable', 'onUnload']);
    expect(loader.getPlugin('un-plg')).toBeUndefined();
  });

  it('does NOT fire onUnload on a plain disable (disable is reversible; its hook is onDisable)', async () => {
    const onUnload = jest.fn(() => Promise.resolve());
    loader.registerBuiltInPlugin(extManifest('no-unload-plg'), { onUnload });
    await loader.enablePlugin('no-unload-plg');

    await loader.disablePlugin('no-unload-plg');

    expect(onUnload).not.toHaveBeenCalled();
    expect(loader.getPlugin('no-unload-plg')?.status).toBe(PluginStatus.DISABLED);
  });

  it('dispatches onUnload to a sandboxed plugin’s worker before terminating it', async () => {
    loader.registerBuiltInPlugin(extManifest('sand-plg'), {});
    const plugin = loader.getPlugin('sand-plg')!;
    // Simulate a sandboxed runtime: non-built-in instance with a live worker host.
    plugin.builtIn = false;
    plugin.status = PluginStatus.ENABLED;
    const host = {
      runLifecycle: jest.fn().mockResolvedValue(undefined),
      terminate: jest.fn().mockResolvedValue(undefined),
    };
    (loader as unknown as { sandboxHosts: Map<string, typeof host> }).sandboxHosts.set('sand-plg', host);

    await loader.unloadPlugin('sand-plg');

    expect(host.runLifecycle.mock.calls.map((c: unknown[]) => c[0])).toEqual(['onDisable', 'onUnload']);
    expect(host.terminate).toHaveBeenCalledTimes(1);
    // onUnload must run BEFORE the worker is terminated — after terminate the hook is unreachable.
    const unloadOrder = host.runLifecycle.mock.invocationCallOrder[1];
    const terminateOrder = host.terminate.mock.invocationCallOrder[0];
    expect(unloadOrder).toBeLessThan(terminateOrder);
  });

  it('still terminates the worker when the sandboxed onUnload throws (best-effort teardown)', async () => {
    loader.registerBuiltInPlugin(extManifest('sand-bad'), {});
    const plugin = loader.getPlugin('sand-bad')!;
    plugin.builtIn = false;
    plugin.status = PluginStatus.ENABLED;
    const host = {
      runLifecycle: jest
        .fn()
        .mockImplementation((method: string) =>
          method === 'onUnload' ? Promise.reject(new Error('unload wedged')) : Promise.resolve(),
        ),
      terminate: jest.fn().mockResolvedValue(undefined),
    };
    (loader as unknown as { sandboxHosts: Map<string, typeof host> }).sandboxHosts.set('sand-bad', host);

    await expect(loader.unloadPlugin('sand-bad')).resolves.toBeUndefined();

    expect(host.terminate).toHaveBeenCalledTimes(1);
    expect(loader.getPlugin('sand-bad')).toBeUndefined();
  });
});

describe('PluginLoaderService — uninstall cleans up split-dir plugin storage', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let dataDir: string;
  let loader: PluginLoaderService;
  let storage: PluginStorageService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-splitstore-'));
    // Split-dir deployment: the package dir and the ctx.storage data dir are NOT the same tree.
    pluginsDir = path.join(tmpDir, 'plugins');
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const config = {
      get: (k: string) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? dataDir : undefined),
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

  it('removes the plugin’s storage dir on uninstall, and only that plugin’s', async () => {
    const dir = writeUserPlugin('user-plg');
    writeUserPlugin('other-plg');
    loader.loadPlugin(dir);
    loader.loadPlugin(path.join(pluginsDir, 'other-plg'));
    // Persist real ctx.storage state for both plugins (split-dir: under <dataDir>/plugins/<id>).
    await storage.createPluginStorage('user-plg').set('token', { secret: 'abc' });
    await storage.createPluginStorage('other-plg').set('token', { secret: 'xyz' });
    const userStorageDir = path.join(dataDir, 'plugins', 'user-plg');
    const otherStorageDir = path.join(dataDir, 'plugins', 'other-plg');
    expect(fs.existsSync(userStorageDir)).toBe(true);

    await loader.uninstallPlugin('user-plg');

    expect(fs.existsSync(dir)).toBe(false); // package dir (unchanged behavior)
    expect(fs.existsSync(userStorageDir)).toBe(false); // split-dir storage is now cleaned too
    expect(fs.existsSync(otherStorageDir)).toBe(true); // another plugin's storage is untouched
    expect(await storage.createPluginStorage('other-plg').get('token')).toEqual({ secret: 'xyz' });
  });
});

/**
 * Where the loader looks for plugin code at boot.
 *
 * The package dir and the plugin registry describe the same install, and they used to default from
 * two unrelated strings: with PLUGINS_DIR unset the loader scanned ./plugins while the registry (and
 * every plugin's ctx.storage) lived under <dataDir>/plugins. The scan found nothing and said only
 * "Loaded 0 plugins", while the registry still listed every plugin as installed — and in Docker the
 * install landed in the container layer instead of on the data volume, so a recreate destroyed the
 * code while the config and secrets on the volume survived.
 *
 * These tests boot through the REAL configuration factory from a temp cwd standing in for the image's
 * WORKDIR /app, because the defaults under test are relative paths resolved against the cwd.
 */
describe('PluginLoaderService — boot plugins directory', () => {
  let tmpDir: string;
  let origCwd: string;
  const origPluginsDir = process.env.PLUGINS_DIR;

  const loggerOf = (loader: PluginLoaderService): { warn: jest.Mock; log: jest.Mock; debug: jest.Mock } =>
    (loader as unknown as { logger: { warn: jest.Mock; log: jest.Mock; debug: jest.Mock } }).logger;

  /** Put a loadable plugin package (manifest + main file) at <dir>/<id>, like the installer does. */
  const installAt = (dir: string, id: string): void => {
    const pluginDir = path.join(dir, id);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'manifest.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', type: 'extension', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = class {};');
  };

  /** One `logger.warn(message, context)` call, as recorded by the spy below. */
  type WarnCall = [message: string, context?: Record<string, unknown>];
  type WarnMock = jest.Mock<void, WarnCall>;

  const boot = (): { loader: PluginLoaderService; storage: PluginStorageService; warn: WarnMock } => {
    const config = new ConfigService(configuration());
    const storage = new PluginStorageService(config);
    const loader = new PluginLoaderService(config, new HookManager(), storage, {} as unknown as ModuleRef);
    const warn = jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined) as unknown as WarnMock;
    jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
    jest.spyOn(loggerOf(loader), 'debug').mockImplementation(() => undefined);
    loader.onModuleInit();
    return { loader, storage, warn };
  };

  const warningsMatching = (warn: WarnMock, action: string): WarnCall[] =>
    warn.mock.calls.filter(([, context]) => context?.action === action);

  beforeEach(() => {
    delete process.env.PLUGINS_DIR;
    // realpath: on macOS os.tmpdir() is a symlink, and process.cwd() reports the resolved path.
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owa-pluginsdir-')));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origPluginsDir === undefined) delete process.env.PLUGINS_DIR;
    else process.env.PLUGINS_DIR = origPluginsDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // THE regression: with PLUGINS_DIR unset, plugin code sitting where the registry lives must load.
  it('loads plugin code from <dataDir>/plugins when PLUGINS_DIR is unset', () => {
    installAt(path.join(tmpDir, 'data', 'plugins'), 'ext-data');

    const { loader } = boot();

    expect(loader.getPlugin('ext-data')).toBeDefined();
    // ...and the registry is written into that same tree, which is the whole point: an install's code
    // and its persisted entry can never end up on different volumes again.
    expect(fs.existsSync(path.join(tmpDir, 'data', 'plugins', 'registry.json'))).toBe(true);
  });

  it('still loads plugins left at the legacy ./plugins location, and says so', () => {
    installAt(path.join(tmpDir, 'plugins'), 'ext-legacy');

    const { loader, warn } = boot();

    expect(loader.getPlugin('ext-legacy')).toBeDefined();
    const [message] = warningsMatching(warn, 'plugins_legacy_dir')[0];
    // The operator must be able to act on this without reading the source: both paths, and how to
    // make the choice permanent either way.
    expect(message).toContain(path.join('.', 'plugins'));
    expect(message).toContain(path.join('data', 'plugins'));
    expect(message).toContain('PLUGINS_DIR');
  });

  it('loads plugins from both locations while a host is mid-migration', () => {
    installAt(path.join(tmpDir, 'data', 'plugins'), 'ext-new');
    installAt(path.join(tmpDir, 'plugins'), 'ext-legacy');

    const { loader } = boot();

    expect(loader.getPlugin('ext-new')).toBeDefined();
    expect(loader.getPlugin('ext-legacy')).toBeDefined();
  });

  it('keeps the copy in the configured dir when the same plugin exists in both, without marking it ERROR', () => {
    installAt(path.join(tmpDir, 'data', 'plugins'), 'ext-both');
    installAt(path.join(tmpDir, 'plugins'), 'ext-both');

    const { loader, storage } = boot();

    expect(loader.getPlugin('ext-both')).toBeDefined();
    expect(storage.getPluginStatus('ext-both')).toBe(PluginStatus.INSTALLED);
  });

  it('honors an explicit PLUGINS_DIR over both the default and the legacy fallback', () => {
    const custom = path.join(tmpDir, 'custom-plugins');
    process.env.PLUGINS_DIR = custom;
    installAt(custom, 'ext-custom');
    installAt(path.join(tmpDir, 'data', 'plugins'), 'ext-data');
    installAt(path.join(tmpDir, 'plugins'), 'ext-legacy');

    const { loader, warn } = boot();

    expect(loader.getPlugin('ext-custom')).toBeDefined();
    expect(loader.getPlugin('ext-data')).toBeUndefined();
    expect(loader.getPlugin('ext-legacy')).toBeUndefined();
    expect(warningsMatching(warn, 'plugins_legacy_dir')).toHaveLength(0);
  });

  it('ignores a legacy directory that holds no loadable plugin package', () => {
    // <dataDir>/plugins/<id> doubles as the plugin's ctx.storage dir, so "a directory exists" says
    // nothing about whether code is there — only a manifest does.
    fs.mkdirSync(path.join(tmpDir, 'plugins', 'ext-storage-only'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'plugins', 'ext-storage-only', 'key-abc.json'), '{}');

    const { warn } = boot();

    expect(warningsMatching(warn, 'plugins_legacy_dir')).toHaveLength(0);
  });

  it('warns when the registry holds installed plugins whose code is not there', () => {
    // A host whose plugin code was destroyed with the container layer: the entry (config, secrets,
    // enabledByOperator) survived on the volume, the code did not.
    const config = new ConfigService(configuration());
    const seed = new PluginStorageService(config);
    seed.setPluginEntry({
      id: 'ext-gone',
      type: PluginType.EXTENSION,
      name: 'Ext Gone',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    });

    const { warn } = boot();

    const [message, context] = warningsMatching(warn, 'plugin_registry_without_code')[0];
    expect(message).toContain('ext-gone');
    expect(context?.count).toBe(1);
    expect(context?.pluginsDir).toContain(path.join('data', 'plugins'));
  });

  it('warns when the plugins directory does not exist at all but the registry has entries', () => {
    const custom = path.join(tmpDir, 'never-created');
    process.env.PLUGINS_DIR = custom;
    const seed = new PluginStorageService(new ConfigService(configuration()));
    seed.setPluginEntry({
      id: 'ext-gone',
      type: PluginType.EXTENSION,
      name: 'Ext Gone',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    });

    const { warn } = boot();

    const [message] = warningsMatching(warn, 'plugin_registry_without_code')[0];
    expect(message).toContain(custom);
    expect(message).toContain('does not exist');
  });

  it('stays quiet on a genuinely empty install and for built-ins, which never have a package dir', () => {
    const seed = new PluginStorageService(new ConfigService(configuration()));
    seed.setPluginEntry({
      id: 'whatsapp-web.js',
      type: PluginType.ENGINE,
      name: 'whatsapp-web.js',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: true,
      installedAt: new Date(),
      updatedAt: new Date(),
    });

    const { warn } = boot();

    expect(warningsMatching(warn, 'plugin_registry_without_code')).toHaveLength(0);
    expect(warningsMatching(warn, 'plugins_legacy_dir')).toHaveLength(0);
  });

  it("does not report a built-in's storage directory as a stray non-plugin directory", () => {
    // <dataDir>/plugins/<id> is also where ctx.storage writes, so a built-in engine that persists
    // anything gets a manifest-less directory here on every healthy boot. That must not read like a
    // fault, and must not look the same as an installed plugin whose code is gone.
    const seed = new PluginStorageService(new ConfigService(configuration()));
    seed.setPluginEntry({
      id: 'whatsapp-web.js',
      type: PluginType.ENGINE,
      name: 'whatsapp-web.js',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: true,
      installedAt: new Date(),
      updatedAt: new Date(),
    });
    fs.mkdirSync(path.join(tmpDir, 'data', 'plugins', 'whatsapp-web.js'), { recursive: true });

    const { warn } = boot();

    expect(warningsMatching(warn, 'manifest_missing')).toHaveLength(0);
  });

  it('reports an installed plugin whose storage survived but whose code is gone', () => {
    const seed = new PluginStorageService(new ConfigService(configuration()));
    seed.setPluginEntry({
      id: 'ext-gone',
      type: PluginType.EXTENSION,
      name: 'Ext Gone',
      version: '1.0.0',
      status: PluginStatus.INSTALLED,
      config: {},
      builtIn: false,
      installedAt: new Date(),
      updatedAt: new Date(),
    });
    const dataOnly = path.join(tmpDir, 'data', 'plugins', 'ext-gone');
    fs.mkdirSync(dataOnly, { recursive: true });
    fs.writeFileSync(path.join(dataOnly, 'key-abc.json'), '{}');

    const { warn } = boot();

    const [message] = warningsMatching(warn, 'plugin_code_missing')[0];
    expect(message).toContain('ext-gone');
    // The state is intact — the operator needs to know reinstalling is safe, not assume data loss.
    expect(message).toMatch(/config|data/i);
  });
});
