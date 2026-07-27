import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EngineFactory } from './engine.factory';
import { ConfigService } from '@nestjs/config';
import { PluginLoaderService, PluginType } from '../core/plugins';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';

describe('EngineFactory', () => {
  const engineBlob = {
    type: 'whatsapp-web.js',
    sessionDataPath: '/var/data/sessions',
    puppeteer: { headless: true, args: ['--no-sandbox'], executablePath: '/usr/bin/chromium-browser' },
  };
  const buildConfigService = (overrides: Record<string, unknown> = {}): ConfigService => {
    const values: Record<string, unknown> = {
      'engine.type': 'whatsapp-web.js',
      'engine.sessionDataPath': '/var/data/sessions',
      'engine.puppeteer.headless': true,
      'engine.puppeteer.args': ['--no-sandbox'],
      'engine.puppeteer.executablePath': '/usr/bin/chromium-browser',
      engine: engineBlob,
      ...overrides,
    };
    return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
  };

  const buildMessageStore = (): BaileysMessageStoreService =>
    ({ put: jest.fn(), getMessage: jest.fn(), clearSession: jest.fn() }) as unknown as BaileysMessageStoreService;

  const buildLidStore = (): LidMappingStoreService =>
    ({
      getCached: jest.fn(),
      lidsForPhone: jest.fn().mockReturnValue([]),
      remember: jest.fn().mockResolvedValue(undefined),
    }) as unknown as LidMappingStoreService;

  it('refuses to create an engine for an unsafe session name (path-traversal into the auth dir)', () => {
    const createEngine = jest.fn().mockReturnValue({});
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue({ instance: { type: PluginType.ENGINE, createEngine } }),
    } as unknown as PluginLoaderService;
    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());

    expect(() => factory.create({ sessionId: '../../etc', dbSessionId: 'db-1' })).toThrow(/unsafe session name/i);
    expect(() => factory.create({ sessionId: 'a/b', dbSessionId: 'db-1' })).toThrow(/unsafe session name/i);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('passes ONLY engine-neutral fields to createEngine (no Puppeteer leak)', () => {
    const createEngine = jest.fn().mockReturnValue({});
    const pluginInstance = { type: PluginType.ENGINE, createEngine };
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue({ instance: pluginInstance }),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());
    factory.create({ sessionId: 'sess-1', dbSessionId: 'db-1', proxyUrl: 'http://p', proxyType: 'http' });

    // Plain-object (not objectContaining) assertion: any browser key (headless/puppeteerArgs/
    // executablePath/sessionDataPath) leaking into the per-call config would fail this exact match.
    expect(createEngine).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      dbSessionId: 'db-1',
      proxyUrl: 'http://p',
      proxyType: 'http',
    });
  });

  it('registers the built-in engine with the opaque engine config blob (#219 guarantee moves to context.config)', async () => {
    const registerBuiltInPlugin = jest.fn();
    const pluginLoader = {
      registerBuiltInPlugin,
      enablePlugin: jest.fn().mockResolvedValue(undefined),
      getPlugin: jest.fn(),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());
    await factory.onModuleInit();

    expect(registerBuiltInPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'whatsapp-web.js', type: PluginType.ENGINE }),
      expect.anything(),
      engineBlob,
    );
  });

  it('registers the built-in baileys engine alongside whatsapp-web.js with the opaque config blob', async () => {
    const registerBuiltInPlugin = jest.fn();
    const pluginLoader = {
      registerBuiltInPlugin,
      enablePlugin: jest.fn().mockResolvedValue(undefined),
      getPlugin: jest.fn(),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());
    await factory.onModuleInit();

    const registeredIds = registerBuiltInPlugin.mock.calls.map(call => (call as [{ id: string }])[0].id);
    expect(registeredIds).toContain('whatsapp-web.js');
    expect(registeredIds).toContain('baileys');
  });

  it('falls back to the direct adapter when no engine plugin is available', () => {
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue(undefined),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(buildConfigService(), pluginLoader, buildMessageStore(), buildLidStore());
    expect(() => factory.create({ sessionId: 'sess-2', dbSessionId: 'db-2' })).not.toThrow();
  });

  it('throws instead of silently building whatsapp-web.js when a non-wwebjs engine has no plugin', () => {
    // The legacy fallback only builds wwebjs; reaching it with ENGINE_TYPE=baileys must fail loudly
    // rather than run the wrong engine.
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue(undefined),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(
      buildConfigService({ 'engine.type': 'baileys' }),
      pluginLoader,
      buildMessageStore(),
      buildLidStore(),
    );
    expect(() => factory.create({ sessionId: 'sess-b', dbSessionId: 'db-b' })).toThrow(/baileys/i);
  });

  describe('purgeSessionData (delete fully removes on-disk auth, keyed by session name)', () => {
    const noPluginLoader = () => ({ getPlugin: jest.fn() }) as unknown as PluginLoaderService;
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-purge-'));
    });
    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    // Both auth-dir shapes live under tmpRoot so the tests are hermetic regardless of CWD.
    const buildBothDirFactory = (engineType: string) => {
      const sessionDataPath = path.join(tmpRoot, 'sessions');
      const authDir = path.join(tmpRoot, 'baileys');
      const factory = new EngineFactory(
        buildConfigService({
          'engine.type': engineType,
          'engine.sessionDataPath': sessionDataPath,
          'engine.baileys.authDir': authDir,
        }),
        noPluginLoader(),
        buildMessageStore(),
        buildLidStore(),
      );
      return { factory, wwjsDir: path.join(sessionDataPath, 'session-alice'), baileysDir: path.join(authDir, 'alice') };
    };

    it.each(['whatsapp-web.js', 'baileys'])(
      "removes BOTH engines' auth dirs when the active engine is %s (engine-switch residue)",
      async engineType => {
        const { factory, wwjsDir, baileysDir } = buildBothDirFactory(engineType);
        fs.mkdirSync(wwjsDir, { recursive: true });
        fs.mkdirSync(baileysDir, { recursive: true });
        fs.writeFileSync(path.join(wwjsDir, 'creds.json'), '{}');
        fs.writeFileSync(path.join(baileysDir, 'creds.json'), '{}');

        await factory.purgeSessionData('alice');

        expect(fs.existsSync(wwjsDir)).toBe(false);
        expect(fs.existsSync(baileysDir)).toBe(false);
      },
    );

    it('still purges the other engine dir (and resolves) when one rm fails', async () => {
      const { factory, wwjsDir, baileysDir } = buildBothDirFactory('baileys');
      fs.mkdirSync(wwjsDir, { recursive: true });
      fs.mkdirSync(baileysDir, { recursive: true });

      const realRm = fs.promises.rm.bind(fs.promises);
      const spy = jest
        .spyOn(fs.promises, 'rm')
        .mockImplementation(async (...args: Parameters<typeof fs.promises.rm>) => {
          if (String(args[0]) === baileysDir) throw new Error('EIO: simulated disk failure');
          return realRm(...args);
        });
      try {
        await expect(factory.purgeSessionData('alice')).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }

      // The healthy engine's purge still ran; the failed one is left behind (logged, never thrown).
      expect(fs.existsSync(wwjsDir)).toBe(false);
      expect(fs.existsSync(baileysDir)).toBe(true);
    });

    it('is a no-op (no throw) when neither auth dir exists', async () => {
      const { factory } = buildBothDirFactory('baileys');
      await expect(factory.purgeSessionData('never-linked')).resolves.toBeUndefined();
    });

    it('refuses to purge an unsafe session name (no rm on a traversal path)', async () => {
      // A sibling that a '../' name would resolve to — it must survive the refused purge.
      const sibling = path.join(tmpRoot, 'baileys-evil');
      fs.mkdirSync(sibling, { recursive: true });

      const { factory } = buildBothDirFactory('baileys');
      await factory.purgeSessionData('../baileys-evil');

      expect(fs.existsSync(sibling)).toBe(true);
    });
  });
});
