import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EngineFactory } from './engine.factory';
import { ConfigService } from '@nestjs/config';
import { PluginLoaderService, PluginType } from '../core/plugins';
import { BaileysMessageStoreService } from './adapters/baileys-message-store.service';
import { LidMappingStoreService } from './identity/lid-mapping-store.service';
import { ChatStateStoreService } from './adapters/baileys-chat-state-store.service';
import { baileysAuthDir, wwjsAuthDir } from './auth-dir-paths';

describe('EngineFactory', () => {
  // The auth-dir key is Session.id (#1597), so the on-disk assertions below use a UUID and build the
  // expected paths with the same helpers the adapters use.
  const SESSION_ID = '8f5b1d9e-0c4a-4e21-9d6b-2a7c3f0e1b44';
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

  const buildChatStateStore = (): ChatStateStoreService =>
    ({
      get: jest.fn(),
      remember: jest.fn().mockResolvedValue(undefined),
      reload: jest.fn().mockResolvedValue(undefined),
    }) as unknown as ChatStateStoreService;

  it('refuses to create an engine for an unsafe session key (path-traversal into the auth dir)', () => {
    const createEngine = jest.fn().mockReturnValue({});
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue({ instance: { type: PluginType.ENGINE, createEngine } }),
    } as unknown as PluginLoaderService;
    const factory = new EngineFactory(
      buildConfigService(),
      pluginLoader,
      buildMessageStore(),
      buildLidStore(),
      buildChatStateStore(),
    );

    expect(() => factory.create({ sessionId: '../../etc', dbSessionId: 'db-1' })).toThrow(/unsafe session key/i);
    expect(() => factory.create({ sessionId: 'a/b', dbSessionId: 'db-1' })).toThrow(/unsafe session key/i);
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('passes ONLY engine-neutral fields to createEngine (no Puppeteer leak)', () => {
    const createEngine = jest.fn().mockReturnValue({});
    const pluginInstance = { type: PluginType.ENGINE, createEngine };
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue({ instance: pluginInstance }),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(
      buildConfigService(),
      pluginLoader,
      buildMessageStore(),
      buildLidStore(),
      buildChatStateStore(),
    );
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

    const factory = new EngineFactory(
      buildConfigService(),
      pluginLoader,
      buildMessageStore(),
      buildLidStore(),
      buildChatStateStore(),
    );
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

    const factory = new EngineFactory(
      buildConfigService(),
      pluginLoader,
      buildMessageStore(),
      buildLidStore(),
      buildChatStateStore(),
    );
    await factory.onModuleInit();

    const registeredIds = registerBuiltInPlugin.mock.calls.map(call => (call as [{ id: string }])[0].id);
    expect(registeredIds).toContain('whatsapp-web.js');
    expect(registeredIds).toContain('baileys');
  });

  it('falls back to the direct adapter when no engine plugin is available', () => {
    const pluginLoader = {
      getPlugin: jest.fn().mockReturnValue(undefined),
    } as unknown as PluginLoaderService;

    const factory = new EngineFactory(
      buildConfigService(),
      pluginLoader,
      buildMessageStore(),
      buildLidStore(),
      buildChatStateStore(),
    );
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
      buildChatStateStore(),
    );
    expect(() => factory.create({ sessionId: 'sess-b', dbSessionId: 'db-b' })).toThrow(/baileys/i);
  });

  describe('create() makes the session credential directories owner-only', () => {
    let tmpRoot: string;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-create-'));
    });
    afterEach(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const buildTmpFactory = (preLoosen?: boolean) => {
      const sessionDataPath = path.join(tmpRoot, 'sessions');
      const authDir = path.join(tmpRoot, 'baileys');
      // An upgrade reuses the dirs a previous install left world-readable (default umask); fresh
      // installs have no dirs at all. Both must end at 0o700 after create().
      if (preLoosen) {
        fs.mkdirSync(wwjsAuthDir(sessionDataPath, SESSION_ID), { recursive: true, mode: 0o755 });
        fs.mkdirSync(baileysAuthDir(authDir, SESSION_ID), { recursive: true, mode: 0o755 });
      }
      const createEngine = jest.fn().mockReturnValue({});
      const pluginLoader = {
        getPlugin: jest.fn().mockReturnValue({ instance: { type: PluginType.ENGINE, createEngine } }),
      } as unknown as PluginLoaderService;
      const factory = new EngineFactory(
        buildConfigService({
          'engine.sessionDataPath': sessionDataPath,
          'engine.baileys.authDir': authDir,
        }),
        pluginLoader,
        buildMessageStore(),
        buildLidStore(),
        buildChatStateStore(),
      );
      return {
        factory,
        wwjsDir: wwjsAuthDir(sessionDataPath, SESSION_ID),
        baileysDir: baileysAuthDir(authDir, SESSION_ID),
      };
    };

    it.each([false, true])('hardens both engine shapes on a %s install', preLoosen => {
      const { factory, wwjsDir, baileysDir } = buildTmpFactory(preLoosen);

      factory.create({ sessionId: SESSION_ID, dbSessionId: SESSION_ID });

      expect(fs.statSync(wwjsDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(baileysDir).mode & 0o777).toBe(0o700);
    });
  });

  describe('purgeSessionData (delete fully removes on-disk auth, keyed by session id)', () => {
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
        buildChatStateStore(),
      );
      return {
        factory,
        wwjsDir: wwjsAuthDir(sessionDataPath, SESSION_ID),
        baileysDir: baileysAuthDir(authDir, SESSION_ID),
      };
    };

    it.each(['whatsapp-web.js', 'baileys'])(
      "removes BOTH engines' auth dirs when the active engine is %s (engine-switch residue)",
      async engineType => {
        const { factory, wwjsDir, baileysDir } = buildBothDirFactory(engineType);
        fs.mkdirSync(wwjsDir, { recursive: true });
        fs.mkdirSync(baileysDir, { recursive: true });
        fs.writeFileSync(path.join(wwjsDir, 'creds.json'), '{}');
        fs.writeFileSync(path.join(baileysDir, 'creds.json'), '{}');

        await factory.purgeSessionData(SESSION_ID);

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
        await expect(factory.purgeSessionData(SESSION_ID)).resolves.toBeUndefined();
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

    // The boot migration keeps a legacy name-keyed directory it could not rename (an open profile, or
    // a conflict with an id-keyed one). Delete has to take it too, or a complete WhatsApp login stays
    // on the volume, and in every backup, after the session is gone.
    it('removes the legacy name-keyed directories of the deleted session as well', async () => {
      const { factory, wwjsDir, baileysDir } = buildBothDirFactory('baileys');
      fs.mkdirSync(wwjsDir, { recursive: true });
      fs.mkdirSync(baileysDir, { recursive: true });
      const legacyWwjs = wwjsAuthDir(path.join(tmpRoot, 'sessions'), 'alice');
      const legacyBaileys = baileysAuthDir(path.join(tmpRoot, 'baileys'), 'alice');
      fs.mkdirSync(legacyWwjs, { recursive: true });
      fs.mkdirSync(legacyBaileys, { recursive: true });

      await factory.purgeSessionData(SESSION_ID, 'alice');

      expect(fs.existsSync(legacyWwjs)).toBe(false);
      expect(fs.existsSync(legacyBaileys)).toBe(false);
    });

    // Why the legacy purge matches a directory listing instead of asking existsSync: there, deleting
    // `Alice` would remove the directory holding `alice`'s login, which is #1597 through the delete
    // path. The two only diverge on a case-insensitive filesystem, which is where the bug lives.
    it('leaves a legacy directory whose stored name differs only in case alone', async () => {
      const { factory } = buildBothDirFactory('baileys');
      const otherSession = wwjsAuthDir(path.join(tmpRoot, 'sessions'), 'alice');
      fs.mkdirSync(otherSession, { recursive: true });

      await factory.purgeSessionData(SESSION_ID, 'Alice');

      expect(fs.existsSync(otherSession)).toBe(true);
    });

    it('refuses to purge an unsafe session key (no rm on a traversal path)', async () => {
      // A sibling that a '../' name would resolve to — it must survive the refused purge.
      const sibling = path.join(tmpRoot, 'baileys-evil');
      fs.mkdirSync(sibling, { recursive: true });

      const { factory } = buildBothDirFactory('baileys');
      await factory.purgeSessionData('../baileys-evil');
      // Same guard on the legacy name, which an imported row can carry raw.
      await factory.purgeSessionData(SESSION_ID, '../baileys-evil');

      expect(fs.existsSync(sibling)).toBe(true);
    });
  });
});
