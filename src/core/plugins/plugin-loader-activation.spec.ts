import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager, HookHandler } from '../hooks';
import { PluginContext, PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';

function makePlugin(opts: { sessionScoped?: boolean; activeSessions?: string[] }): PluginInstance {
  const manifest: PluginManifest = {
    id: 'act-ext',
    name: 'Activation Ext',
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.js',
    sessionScoped: opts.sessionScoped,
  };
  return { manifest, status: PluginStatus.ENABLED, config: {}, instance: null, activeSessions: opts.activeSessions };
}

describe('PluginLoaderService — per-session activation gate (hook delivery)', () => {
  let loader: PluginLoaderService;
  let hookManager: HookManager;
  let setSessions: jest.Mock;

  beforeEach(() => {
    hookManager = new HookManager();
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    setSessions = jest.fn();
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue({}),
      setPluginSessions: setSessions,
    } as unknown as PluginStorageService;
    loader = new PluginLoaderService(configService, hookManager, pluginStorage, {
      get: jest.fn(),
    } as unknown as ModuleRef);
  });

  const seed = (plugin: PluginInstance): void => {
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set(plugin.manifest.id, plugin);
  };

  function register(plugin: PluginInstance, handler: HookHandler): void {
    const ctx = (
      loader as unknown as { createPluginContext: (p: PluginInstance) => PluginContext }
    ).createPluginContext(plugin);
    ctx.registerHook('message:received', handler);
  }

  const fire = (sessionId: string): Promise<unknown> =>
    hookManager.execute('message:received', {}, { sessionId, source: 'Engine' });

  it('delivers a hook only for the sessions a session-scoped plugin is activated for', async () => {
    const handler = jest.fn().mockResolvedValue({ continue: true });
    register(makePlugin({ activeSessions: ['sess-1'] }), handler);

    await fire('sess-1');
    expect(handler).toHaveBeenCalledTimes(1);

    await fire('sess-2');
    expect(handler).toHaveBeenCalledTimes(1); // not delivered for the inactive session
  });

  it("delivers for every session when activeSessions is ['*']", async () => {
    const handler = jest.fn().mockResolvedValue({ continue: true });
    register(makePlugin({ activeSessions: ['*'] }), handler);

    await fire('a');
    await fire('b');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('defaults to all sessions when activeSessions is unset', async () => {
    const handler = jest.fn().mockResolvedValue({ continue: true });
    register(makePlugin({}), handler); // no activeSessions

    await fire('anything');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a global plugin (sessionScoped:false) always receives the hook, even with no active sessions', async () => {
    const handler = jest.fn().mockResolvedValue({ continue: true });
    register(makePlugin({ sessionScoped: false, activeSessions: [] }), handler);

    await fire('x');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe('setPluginSessions', () => {
    it('updates a session-scoped plugin and persists the new active set', () => {
      const plugin = makePlugin({ activeSessions: ['*'] });
      seed(plugin);

      loader.setPluginSessions('act-ext', ['sess-1', 'sess-2']);

      expect(plugin.activeSessions).toEqual(['sess-1', 'sess-2']);
      expect(setSessions).toHaveBeenCalledWith('act-ext', ['sess-1', 'sess-2']);
    });

    it('rejects activating a global (non-session-scoped) plugin per session', () => {
      seed(makePlugin({ sessionScoped: false }));
      expect(() => loader.setPluginSessions('act-ext', ['sess-1'])).toThrow(/global/i);
      expect(setSessions).not.toHaveBeenCalled();
    });
  });
});

// A built-in/bundled plugin must read its persisted per-session activation + config back into the
// runtime on boot, exactly like a directory plugin (loadPlugin) — otherwise the gate falls back to
// all-sessions/base-config after every restart, silently widening delivery for a plugin the operator
// had restricted.
describe('PluginLoaderService — registerBuiltInPlugin restart read-back', () => {
  it('seeds activeSessions and sessionConfig from persisted storage', () => {
    const hookManager = new HookManager();
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const pluginStorage = {
      getPluginConfig: jest.fn().mockReturnValue({}),
      getPluginSessions: jest.fn().mockReturnValue(['sess-1']),
      getPluginSessionConfig: jest.fn().mockReturnValue({ 'sess-1': { lang: 'id' } }),
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginEntry: jest.fn(),
    } as unknown as PluginStorageService;
    const loader = new PluginLoaderService(configService, hookManager, pluginStorage, {
      get: jest.fn(),
    } as unknown as ModuleRef);

    const manifest: PluginManifest = {
      id: 'builtin-ext',
      name: 'Built-in Ext',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      main: 'index.js',
      sessionScoped: true,
    };
    loader.registerBuiltInPlugin(manifest, {});

    const plugin = (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.get('builtin-ext');
    expect(plugin?.activeSessions).toEqual(['sess-1']);
    expect(plugin?.sessionConfig).toEqual({ 'sess-1': { lang: 'id' } });
  });
});
