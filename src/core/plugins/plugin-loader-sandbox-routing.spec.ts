import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookContext, HookEvent, HookHandler, HookManager } from '../hooks';
import { IPlugin, PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { PluginLogLevel } from './sandbox/protocol';
import { PLUGIN_SEARCH_REGISTRY_PORT } from './plugin-host-ports';
import { SearchProviderRegistry } from '../../modules/search/search-provider.registry';
import { redactSecrets } from '../../common/services/logger.service';

type FakeHost = {
  load: jest.Mock;
  runLifecycle: jest.Mock;
  terminate: jest.Mock;
  dispatchHook: jest.Mock;
  healthCheck: jest.Mock;
  dispatchSearch: jest.Mock;
};

/** Loader that returns fake worker hosts so routing is testable without spawning a real OS thread. */
class TestableLoader extends PluginLoaderService {
  readonly hosts: FakeHost[] = [];
  capturedOnHookSubscribe?: (event: string, priority?: number) => void;
  capturedOnLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void;
  capturedOnWorkerExit?: (code: number, intentional: boolean, reason?: string) => void;
  capturedOnUnresponsive?: () => void;
  capturedOnSearchProviderRegister?: () => void;
  protected createSandboxHost(
    _capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
    onHookSubscribe?: (event: string, priority?: number) => void,
    _onWebhookSubscribe?: (route: string) => void,
    onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
    _runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
    onSearchProviderRegister?: () => void,
    onWorkerExit?: (code: number, intentional: boolean, reason?: string) => void,
    onUnresponsive?: () => void,
  ): PluginWorkerHost {
    this.capturedOnHookSubscribe = onHookSubscribe;
    this.capturedOnLog = onLog;
    this.capturedOnWorkerExit = onWorkerExit;
    this.capturedOnUnresponsive = onUnresponsive;
    this.capturedOnSearchProviderRegister = onSearchProviderRegister;
    const host: FakeHost = {
      load: jest.fn().mockResolvedValue(undefined),
      runLifecycle: jest.fn().mockResolvedValue(undefined),
      terminate: jest.fn().mockResolvedValue(undefined),
      dispatchHook: jest.fn().mockResolvedValue({ continue: true }),
      healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
      dispatchSearch: jest.fn().mockResolvedValue({
        ok: true,
        results: { hits: [], total: 0, tookMs: 1, provider: 'plugin:p1' },
      }),
    };
    this.hosts.push(host);
    return host as unknown as PluginWorkerHost;
  }
}

function makeLoader(registry?: SearchProviderRegistry, searchMode = 'auto'): TestableLoader {
  const configService = {
    get: jest.fn((key: string) => (key === 'search.provider' ? searchMode : undefined)),
  } as unknown as ConfigService;
  const pluginStorage = {
    createPluginStorage: jest.fn().mockReturnValue({}),
    getPluginConfig: jest.fn().mockReturnValue(undefined),
    getPluginEntry: jest.fn().mockReturnValue(undefined),
    setPluginEntry: jest.fn(),
    setPluginStatus: jest.fn(),
  } as unknown as PluginStorageService;
  const moduleRef = {
    get: jest.fn((token: unknown) => (token === PLUGIN_SEARCH_REGISTRY_PORT ? registry : undefined)),
  } as unknown as ModuleRef;
  return new TestableLoader(configService, new HookManager(), pluginStorage, moduleRef);
}

const manifest = (): PluginManifest => ({
  id: 'p1',
  name: 'P1',
  version: '1.0.0',
  type: PluginType.EXTENSION,
  main: 'index.js',
});

function seed(loader: TestableLoader, opts: { builtIn: boolean; instance: IPlugin | null }): void {
  const plugin: PluginInstance = {
    manifest: manifest(),
    status: PluginStatus.INSTALLED,
    config: {},
    instance: opts.instance,
    builtIn: opts.builtIn,
  };
  (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
}

const pluginOf = (loader: TestableLoader): PluginInstance =>
  (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.get('p1') as PluginInstance;

describe('PluginLoaderService — sandbox tier routing', () => {
  it('enables an untrusted plugin in a sandbox worker, not in-process', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });

    await loader.enablePlugin('p1');

    expect(loader.hosts).toHaveLength(1);
    expect(loader.hosts[0].load).toHaveBeenCalled();
    expect(loader.hosts[0].runLifecycle).toHaveBeenCalledWith('onEnable', expect.any(Number));
    const plugin = pluginOf(loader);
    expect(plugin.status).toBe(PluginStatus.ENABLED);
    expect(plugin.instance).toBeNull(); // the instance lives in the worker, never in-process
  });

  it('disables an untrusted plugin by running onDisable then terminating the worker', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const host = loader.hosts[0];

    await loader.disablePlugin('p1');

    expect(host.runLifecycle).toHaveBeenCalledWith('onDisable', expect.any(Number));
    expect(host.terminate).toHaveBeenCalled();
    expect(pluginOf(loader).status).toBe(PluginStatus.DISABLED);
  });

  it('force-terminates the sandbox worker even when onDisable rejects (e.g. times out)', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const host = loader.hosts[0];
    host.runLifecycle.mockRejectedValueOnce(new Error("plugin worker lifecycle 'onDisable' timed out after 30000ms"));

    await loader.disablePlugin('p1'); // resolves: disable is a force-teardown, not blocked by onDisable

    expect(host.terminate).toHaveBeenCalled(); // worker killed despite the onDisable failure
    expect(pluginOf(loader).status).toBe(PluginStatus.DISABLED);
    // the host must be dropped so a misbehaving plugin can't leak its worker thread
    expect((loader as unknown as { sandboxHosts: Map<string, unknown> }).sandboxHosts.has('p1')).toBe(false);
  });

  it('runs the worker onDisable and terminate once when shutdown overlaps a disable in flight', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const host = loader.hosts[0];
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    host.runLifecycle.mockClear().mockReturnValueOnce(gate);

    const disabling = loader.disablePlugin('p1');
    const destroying = loader.onModuleDestroy();
    release();
    await disabling;
    await destroying;

    expect(host.runLifecycle).toHaveBeenCalledTimes(1);
    expect(host.runLifecycle).toHaveBeenCalledWith('onDisable', expect.any(Number));
    expect(host.terminate).toHaveBeenCalledTimes(1);
    expect(pluginOf(loader).status).toBe(PluginStatus.DISABLED);
  });

  it('tears down the second worker when a re-enabled plugin is disabled again', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });

    await loader.enablePlugin('p1');
    await loader.disablePlugin('p1');
    await loader.enablePlugin('p1');
    await loader.disablePlugin('p1');

    // Each enable starts its own worker and each disable has to end that one. A disable that joined the
    // settled teardown of the first cycle would report success and leave the second worker running.
    expect(loader.hosts).toHaveLength(2);
    for (const host of loader.hosts) {
      expect(host.runLifecycle).toHaveBeenCalledWith('onDisable', expect.any(Number));
      expect(host.terminate).toHaveBeenCalledTimes(1);
    }
    expect(pluginOf(loader).status).toBe(PluginStatus.DISABLED);
  });

  it('dedups duplicate hook-subscribe from the worker so a flood cannot grow the host registry', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    const hookManager = (loader as unknown as { hookManager: HookManager }).hookManager;
    const registerSpy = jest.spyOn(hookManager, 'register');

    await loader.enablePlugin('p1');
    const onHookSubscribe = loader.capturedOnHookSubscribe;
    expect(onHookSubscribe).toBeDefined();

    // A hostile worker posts the same subscribe many times; the host must register it ONCE.
    onHookSubscribe!('message:received');
    onHookSubscribe!('message:received');
    onHookSubscribe!('message:received');
    expect(registerSpy.mock.calls.filter(c => c[1] === 'message:received')).toHaveLength(1);

    // A genuinely distinct event still registers.
    onHookSubscribe!('message:sending');
    expect(registerSpy.mock.calls.filter(c => c[1] === 'message:sending')).toHaveLength(1);
  });

  it('drops fabricated (unknown) hook-subscribe events so the host registry cannot grow unbounded', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    const hookManager = (loader as unknown as { hookManager: HookManager }).hookManager;
    const registerSpy = jest.spyOn(hookManager, 'register');

    await loader.enablePlugin('p1');
    const onHookSubscribe = loader.capturedOnHookSubscribe;
    expect(onHookSubscribe).toBeDefined();

    // A worker floods the boundary with fabricated event names — none may reach hookManager.register.
    for (let i = 0; i < 1000; i++) onHookSubscribe!(`x:${i}`);
    expect(registerSpy).not.toHaveBeenCalled();

    // A real, known event still registers.
    onHookSubscribe!('message:received');
    expect(registerSpy.mock.calls.filter(c => c[1] === 'message:received')).toHaveLength(1);
  });

  it('runs the shim at the lowest priority the worker asked for, and ignores a non-numeric one', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    const hookManager = (loader as unknown as { hookManager: HookManager }).hookManager;
    const order: string[] = [];
    hookManager.register('other', 'message:sending', () => {
      order.push('other@100');
      return Promise.resolve({ continue: true });
    });
    await loader.enablePlugin('p1');
    loader.hosts[0].dispatchHook.mockImplementation(() => {
      order.push('p1');
      return Promise.resolve({ continue: true });
    });

    // The worker's first handler asks for 200; a later one for 1 (it re-subscribes); junk is ignored.
    loader.capturedOnHookSubscribe!('message:sending', 200);
    loader.capturedOnHookSubscribe!('message:sending', 1);
    loader.capturedOnHookSubscribe!('message:sending', 'high' as unknown as number);
    loader.capturedOnHookSubscribe!('message:sending', NaN);
    await hookManager.execute('message:sending', {}, { source: 't' });

    expect(order).toEqual(['p1', 'other@100']);
    expect(hookManager.getRegisteredHooks()['message:sending']).toEqual([
      { pluginId: 'p1', priority: 1 },
      { pluginId: 'other', priority: 100 },
    ]);
  });

  it('forwards the host in-flight chain to the worker with each dispatch', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    const hookManager = (loader as unknown as { hookManager: HookManager }).hookManager;
    await loader.enablePlugin('p1');
    loader.capturedOnHookSubscribe!('message:sent');

    await hookManager.runInFlight(['message:sending'], () =>
      hookManager.execute('message:sent', {}, { sessionId: 's1', source: 't' }),
    );

    expect(loader.hosts[0].dispatchHook).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'message:sent', inFlight: ['message:sending', 'message:sent'] }),
    );
  });

  it('reports a sandboxed plugin with no live worker as unhealthy (crashed or disabled)', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);

    loader.capturedOnWorkerExit!(1, false);
    const crashed = await loader.checkPluginHealth('p1');
    expect(crashed.healthy).toBe(false);
    expect(crashed.message).toContain('worker exited unexpectedly');

    pluginOf(loader).status = PluginStatus.DISABLED;
    pluginOf(loader).error = undefined;
    expect(await loader.checkPluginHealth('p1')).toEqual({
      healthy: false,
      message: 'plugin is not running (status disabled)',
    });
  });

  it('shows why a sandboxed worker died when it reported a reason before exiting', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);

    loader.capturedOnWorkerExit!(1, false, 'boom: relay answered 500');

    expect(pluginOf(loader).error).toBe('worker exited unexpectedly (code 1): boom: relay answered 500');
  });

  it('enables a built-in plugin in-process (no sandbox worker spawned)', async () => {
    const loader = makeLoader();
    const onEnable = jest.fn().mockResolvedValue(undefined);
    seed(loader, { builtIn: true, instance: { onEnable } });

    await loader.enablePlugin('p1');

    expect(loader.hosts).toHaveLength(0);
    expect(onEnable).toHaveBeenCalled();
    expect(pluginOf(loader).status).toBe(PluginStatus.ENABLED);
  });
});

describe('PluginLoaderService — sandbox hook error surfacing', () => {
  const loggerOf = (loader: TestableLoader): { warn: jest.Mock; log: jest.Mock } =>
    (loader as unknown as { logger: { warn: jest.Mock; log: jest.Mock } }).logger;

  /** A context in the shape the emitters actually build — the shim reads `event` to route. */
  const ctx = (event: HookEvent): HookContext => ({
    event,
    data: {},
    sessionId: 's1',
    timestamp: new Date(0),
    source: 'Engine',
  });

  /** Enable p1, subscribe it to `event`, and return the shim the loader registered for it. */
  const setupShim = async (loader: TestableLoader, event: HookEvent): Promise<HookHandler> => {
    seed(loader, { builtIn: false, instance: null });
    const hookManager = (loader as unknown as { hookManager: HookManager }).hookManager;
    const registerSpy = jest.spyOn(hookManager, 'register');
    await loader.enablePlugin('p1');
    loader.capturedOnHookSubscribe!(event);
    const call = registerSpy.mock.calls.find(c => c[1] === event);
    expect(call).toBeDefined();
    return call![2];
  };

  it('logs a worker-reported hook error (rate-limited per event) and surfaces it in plugin health', async () => {
    const loader = makeLoader();
    const handler = await setupShim(loader, 'message:sent');
    // The worker reports (not throws) the handler failure on its hook-result.
    loader.hosts[0].dispatchHook.mockResolvedValue({ continue: true, error: 'boom' });
    const warnSpy = jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined);

    await handler(ctx('message:sent'));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Sandboxed plugin p1 hook 'message:sent' handler failed: boom"),
      expect.objectContaining({ action: 'sandbox_hook_error', pluginId: 'p1', event: 'message:sent' }),
    );

    // A second failure inside the rate-limit window is counted, not logged again.
    await handler(ctx('message:sent'));
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // The chain still fails open: the shim resolves continue:true for the hook manager.
    await expect(handler(ctx('message:sent'))).resolves.toEqual({ continue: true });

    // The health surface carries the last hook error without overriding the worker's own verdict.
    const health = await loader.checkPluginHealth('p1');
    expect(health.healthy).toBe(true);
    expect(health.message).toContain("last hook error in 'message:sent'");
    expect(health.message).toContain('boom');

    // Disable clears the record: a fresh enable starts with a clean slate.
    await loader.disablePlugin('p1');
    const after = await loader.checkPluginHealth('p1');
    expect(after.message ?? '').not.toContain('last hook error');
  });

  it('does not carry a dead generation’s hook error into the worker that replaces it', async () => {
    // The record is cleared on disable, but a crash never goes through disable. Without a clear on
    // enable, the next worker inherits the previous one's error and checkPluginHealth reports it as
    // current — the field's own contract says a fresh enable starts from a clean slate.
    const loader = makeLoader();
    const handler = await setupShim(loader, 'message:sent');
    loader.hosts[0].dispatchHook.mockResolvedValue({ continue: true, error: 'boom' });
    jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined);

    await handler(ctx('message:sent'));
    expect((await loader.checkPluginHealth('p1')).message).toContain('last hook error');

    // Worker crashes (intentional=false): the host is dropped without any disable running.
    loader.capturedOnWorkerExit!(1, false);
    await loader.enablePlugin('p1');

    const after = await loader.checkPluginHealth('p1');
    expect(after.message ?? '').not.toContain('last hook error');
  });

  it('does not log or record anything when the worker reports no error', async () => {
    const loader = makeLoader();
    const handler = await setupShim(loader, 'message:sent');
    loader.hosts[0].dispatchHook.mockResolvedValue({ continue: false, data: { n: 1 } });
    const warnSpy = jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined);

    await expect(handler(ctx('message:sent'))).resolves.toEqual({
      continue: false,
      data: { n: 1 },
    });
    expect(warnSpy).not.toHaveBeenCalled();
    const health = await loader.checkPluginHealth('p1');
    expect(health.message ?? '').not.toContain('last hook error');
  });
});

describe('PluginLoaderService - blocked sandbox worker', () => {
  const loggerOf = (loader: TestableLoader): { warn: jest.Mock } =>
    (loader as unknown as { logger: { warn: jest.Mock } }).logger;
  const hostsOf = (loader: TestableLoader): Map<string, unknown> =>
    (loader as unknown as { sandboxHosts: Map<string, unknown> }).sandboxHosts;
  const storageOf = (loader: TestableLoader): { setPluginStatus: jest.Mock } =>
    (loader as unknown as { pluginStorage: { setPluginStatus: jest.Mock } }).pluginStorage;

  it('terminates an unresponsive worker and leaves the plugin in ERROR with its hooks removed', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    const hookManager = (loader as unknown as { hookManager: HookManager }).hookManager;
    const unregisterSpy = jest.spyOn(hookManager, 'unregisterPlugin');
    const warnSpy = jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined);
    await loader.enablePlugin('p1');
    const host = loader.hosts[0];

    loader.capturedOnUnresponsive!();

    const plugin = pluginOf(loader);
    expect(plugin.status).toBe(PluginStatus.ERROR);
    expect(plugin.error).toMatch(/unresponsive/);
    expect(storageOf(loader).setPluginStatus).toHaveBeenCalledWith('p1', PluginStatus.ERROR);
    expect(unregisterSpy).toHaveBeenCalledWith('p1');
    expect(hostsOf(loader).has('p1')).toBe(false);
    expect(host.terminate).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('p1'),
      expect.objectContaining({ action: 'sandbox_worker_unresponsive', pluginId: 'p1' }),
    );

    // The deliberate terminate() then exits the worker; that must not undo or repeat the above.
    loader.capturedOnWorkerExit!(1, true);
    expect(pluginOf(loader).status).toBe(PluginStatus.ERROR);
  });

  it('ignores a late report from a worker generation that has already been replaced', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const staleReport = loader.capturedOnUnresponsive!;
    await loader.disablePlugin('p1');
    await loader.enablePlugin('p1');
    const current = loader.hosts[1];

    staleReport();

    expect(pluginOf(loader).status).toBe(PluginStatus.ENABLED);
    expect(hostsOf(loader).get('p1')).toBe(current);
    expect(current.terminate).not.toHaveBeenCalled();
  });

  it('rate-limits the hook timeout warn per event and surfaces the timeout in plugin health', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    const hookManager = (loader as unknown as { hookManager: HookManager }).hookManager;
    const registerSpy = jest.spyOn(hookManager, 'register');
    await loader.enablePlugin('p1');
    loader.capturedOnHookSubscribe!('message:received');
    const handler = registerSpy.mock.calls.find(c => c[1] === 'message:received')![2];
    loader.hosts[0].dispatchHook.mockImplementation((options: { onTimeout?: () => void }) => {
      options.onTimeout?.();
      return Promise.resolve({ continue: true });
    });
    const warnSpy = jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined);
    const hookCtx: HookContext = {
      event: 'message:received',
      data: {},
      sessionId: 's1',
      timestamp: new Date(0),
      source: 'Engine',
    };

    await handler(hookCtx);
    await handler(hookCtx);

    const timeoutWarns = warnSpy.mock.calls.filter(
      c => (c[1] as { action?: string } | undefined)?.action === 'sandbox_hook_timeout',
    );
    expect(timeoutWarns).toHaveLength(1);
    const health = await loader.checkPluginHealth('p1');
    expect(health.message).toContain("last hook error in 'message:received'");
    expect(health.message).toContain('timed out');
  });
});

describe('PluginLoaderService - sandbox search provider ownership', () => {
  const setup = async (mode = 'auto', searchEnabled = true) => {
    const registry = new SearchProviderRegistry();
    registry.register({ id: 'builtin-fts', label: 'Built-in', search: jest.fn(), health: jest.fn() });
    const loader = makeLoader(searchEnabled ? registry : undefined, mode);
    seed(loader, { builtIn: false, instance: null });
    pluginOf(loader).manifest.permissions = ['search:provide'];
    await loader.enablePlugin('p1');
    loader.capturedOnSearchProviderRegister!();
    return { loader, registry };
  };

  it.each([true, false])(
    'preserves the replacement provider when a retired worker exits (intentional=%s)',
    async intentional => {
      const { loader, registry } = await setup();
      const oldExit = loader.capturedOnWorkerExit!;
      let finishTermination!: () => void;
      loader.hosts[0].terminate.mockReturnValueOnce(new Promise<void>(resolve => (finishTermination = resolve)));
      loader.capturedOnUnresponsive!();
      expect(pluginOf(loader).status).toBe(PluginStatus.ERROR);
      await loader.enablePlugin('p1');
      loader.capturedOnSearchProviderRegister!();
      loader.capturedOnHookSubscribe!('message:received');
      const currentProvider = registry.active();
      const hooks = (loader as unknown as { hookManager: HookManager }).hookManager;
      const unregister = jest.spyOn(hooks, 'unregisterPlugin');

      oldExit(1, intentional);
      finishTermination();

      expect(registry.active()).toBe(currentProvider);
      expect(registry.active()?.id).toBe('plugin:p1');
      await expect(registry.active()!.search({ q: 'hello' })).resolves.toEqual({
        hits: [],
        total: 0,
        tookMs: 1,
        provider: 'plugin:p1',
      });
      expect(loader.hosts[1].dispatchSearch).toHaveBeenCalled();
      expect(pluginOf(loader).status).toBe(PluginStatus.ENABLED);
      expect((loader as unknown as { sandboxHosts: Map<string, unknown> }).sandboxHosts.get('p1')).toBe(
        loader.hosts[1],
      );
      expect(unregister).not.toHaveBeenCalled();
      expect(loader.hosts[1].terminate).not.toHaveBeenCalled();
    },
  );

  it('removes an unresponsive worker provider when its host entry is already absent', async () => {
    const { loader, registry } = await setup();
    loader.capturedOnUnresponsive!();
    expect((loader as unknown as { sandboxHosts: Map<string, unknown> }).sandboxHosts.has('p1')).toBe(false);

    loader.capturedOnWorkerExit!(1, true);

    expect(registry.list().map(provider => provider.id)).toEqual(['builtin-fts']);
    expect(registry.active()?.id).toBe('builtin-fts');
    expect(pluginOf(loader).status).toBe(PluginStatus.ERROR);
  });

  it('removes the current worker provider after an unexpected exit', async () => {
    const { loader, registry } = await setup();

    loader.capturedOnWorkerExit!(1, false);

    expect(registry.list().map(provider => provider.id)).toEqual(['builtin-fts']);
    expect(registry.active()?.id).toBe('builtin-fts');
    expect(pluginOf(loader).status).toBe(PluginStatus.ERROR);
  });

  it.each(['builtin-fts', 'none', 'disabled'])('preserves search mode %s across worker replacement', async mode => {
    const { loader, registry } = await setup(mode, mode !== 'disabled');
    const oldExit = loader.capturedOnWorkerExit!;
    loader.capturedOnUnresponsive!();
    await loader.enablePlugin('p1');
    loader.capturedOnSearchProviderRegister!();

    oldExit(1, true);

    expect(registry.active()?.id).toBe('builtin-fts');
    expect(registry.list().map(provider => provider.id)).toEqual(
      mode === 'builtin-fts' ? ['builtin-fts', 'plugin:p1'] : ['builtin-fts'],
    );
    expect(pluginOf(loader).status).toBe(PluginStatus.ENABLED);
  });

  it('registers a replacement normally when the retired worker exits first', async () => {
    const { loader, registry } = await setup();
    const oldExit = loader.capturedOnWorkerExit!;
    loader.capturedOnUnresponsive!();
    oldExit(1, true);
    expect(registry.active()?.id).toBe('builtin-fts');

    await loader.enablePlugin('p1');
    loader.capturedOnSearchProviderRegister!();

    expect(registry.active()?.id).toBe('plugin:p1');
  });

  it.each(['disable', 'unload'])('removes the provider during normal %s', async operation => {
    const { loader, registry } = await setup();
    const onExit = loader.capturedOnWorkerExit!;

    if (operation === 'disable') await loader.disablePlugin('p1');
    else await loader.unloadPlugin('p1');
    onExit(0, true);

    expect(loader.hosts[0].terminate).toHaveBeenCalledTimes(1);
    expect(registry.list().map(provider => provider.id)).toEqual(['builtin-fts']);
    expect(registry.active()?.id).toBe('builtin-fts');
    expect((loader as unknown as { sandboxHosts: Map<string, unknown> }).sandboxHosts.has('p1')).toBe(false);
    if (operation === 'disable') expect(pluginOf(loader).status).toBe(PluginStatus.DISABLED);
    else expect(pluginOf(loader)).toBeUndefined();
  });
});

describe('PluginLoaderService — sandbox log relay bounds', () => {
  const loggerOf = (loader: TestableLoader): { warn: jest.Mock; log: jest.Mock } =>
    (loader as unknown as { logger: { warn: jest.Mock; log: jest.Mock } }).logger;

  it('relays up to the per-window cap, then drops the excess and reports the count at rollover', async () => {
    jest.useFakeTimers();
    try {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined);

      const onLog = loader.capturedOnLog!;
      for (let i = 0; i < 250; i++) onLog('log', `line ${i}`);
      expect(logSpy).toHaveBeenCalledTimes(200); // the excess 50 are dropped, not relayed
      expect(warnSpy).not.toHaveBeenCalled(); // the drop warn fires at the NEXT window rollover

      jest.setSystemTime(Date.now() + 10000);
      onLog('log', 'next window');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropped 50 log messages from sandboxed plugin p1'),
        expect.objectContaining({ action: 'sandbox_log_relay_dropped', pluginId: 'p1', dropped: 50 }),
      );
      expect(logSpy).toHaveBeenCalledTimes(201); // the rollover line relays normally
    } finally {
      jest.useRealTimers();
    }
  });

  it('flushes the pending drop count on worker exit, so a quiet plugin loses nothing', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined);

    const onLog = loader.capturedOnLog!;
    for (let i = 0; i < 250; i++) onLog('log', `line ${i}`);
    expect(logSpy).toHaveBeenCalledTimes(200);
    expect(warnSpy).not.toHaveBeenCalled(); // the plugin went quiet before any window rollover

    // Disable/crash tears the worker down first: the pending count surfaces as a final burst.
    loader.capturedOnWorkerExit!(0, true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dropped 50 log messages from sandboxed plugin p1'),
      expect.objectContaining({ action: 'sandbox_log_relay_dropped', pluginId: 'p1', dropped: 50 }),
    );

    // The flush is one-shot: a repeated exit callback must not re-report the same count.
    loader.capturedOnWorkerExit!(0, true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('relays an unknown worker log level as log instead of throwing', async () => {
    // Plugin code can post to parentPort directly, so the level is untrusted: `logger.info` does not exist.
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

    expect(() => loader.capturedOnLog!('info' as PluginLogLevel, 'hello')).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith('[p1] hello', {}, { pluginId: 'p1' });
  });

  it('truncates an oversized worker log line before relaying it', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

    loader.capturedOnLog!('log', 'x'.repeat(10000));

    expect(logSpy).toHaveBeenCalledTimes(1);
    const relayed = logSpy.mock.calls[0][0] as string;
    expect(relayed).toContain('…[truncated]');
    expect(relayed.length).toBe('[p1] '.length + 8192 + '…[truncated]'.length);
  });

  describe('a non-string worker log message', () => {
    // Plugin code can post to parentPort directly, so the message is untrusted and may not be a string. It is not
    // turned into text, which for an array would write out every shared reference at every use.
    const sharedArray = (levels: number): unknown[] => {
      let node: unknown[] = [1];
      for (let level = 0; level < levels; level++) node = new Array<unknown>(10).fill(node);
      return node;
    };

    it.each([
      ['an array', ['x'.repeat(6000), 'y'.repeat(6000)]],
      ['a number', 42],
      ['an object', { text: 'x'.repeat(10000) }],
      ['null', null],
    ])('is relayed as a fixed marker when it is %s', async (_name, message) => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

      loader.capturedOnLog!('log', message as unknown as string);

      expect(logSpy).toHaveBeenCalledWith('[p1] [non-string log message]', {}, { pluginId: 'p1' });
    });

    it('is relayed at once when it is an array whose levels share the same child', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

      const started = Date.now();
      loader.capturedOnLog!('log', sharedArray(7) as unknown as string);

      expect(Date.now() - started).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] [non-string log message]', {}, { pluginId: 'p1' });
    });
  });

  it('replaces an oversized worker log meta with a size marker instead of relaying it', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

    loader.capturedOnLog!('log', 'big', { data: 'x'.repeat(20000) });
    loader.capturedOnLog!('log', 'small', { n: 1 });

    expect(logSpy).toHaveBeenNthCalledWith(1, '[p1] big', { metaTruncated: true }, { pluginId: 'p1' });
    expect(logSpy).toHaveBeenNthCalledWith(2, '[p1] small', { n: 1 }, { pluginId: 'p1' });
  });

  it('relays a worker log meta that is a string or an array as one field', async () => {
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

    loader.capturedOnLog!('log', 'string', 'abc' as unknown as Record<string, unknown>);
    loader.capturedOnLog!('log', 'array', [1, 2] as unknown as Record<string, unknown>);
    loader.capturedOnLog!(
      'log',
      'bytes',
      structuredClone(new Uint8Array([1, 2])) as unknown as Record<string, unknown>,
    );
    loader.capturedOnLog!('log', 'boxed', structuredClone(new String('ab')) as unknown as Record<string, unknown>);
    loader.capturedOnLog!('log', 'record', structuredClone({ id: 1 }));

    expect(logSpy).toHaveBeenNthCalledWith(1, '[p1] string', { meta: 'abc' }, { pluginId: 'p1' });
    expect(logSpy).toHaveBeenNthCalledWith(2, '[p1] array', { meta: [1, 2] }, { pluginId: 'p1' });
    expect(logSpy).toHaveBeenNthCalledWith(3, '[p1] bytes', { meta: new Uint8Array([1, 2]) }, { pluginId: 'p1' });
    expect(Object.keys(logSpy.mock.calls[3][1] as object)).toEqual(['meta']);
    expect(String((logSpy.mock.calls[3][1] as { meta: unknown }).meta)).toBe('ab');
    expect(logSpy).toHaveBeenNthCalledWith(5, '[p1] record', { id: 1 }, { pluginId: 'p1' });
  });

  it('keeps the error text of a worker error log whose meta is oversized or not serializable', async () => {
    // logger.error's reason travels as meta.error, and the host error call gets no trace argument.
    const loader = makeLoader();
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const errorSpy = jest
      .spyOn((loader as unknown as { logger: { error: jest.Mock } }).logger, 'error')
      .mockImplementation(() => undefined);

    loader.capturedOnLog!('error', 'big', { data: 'x'.repeat(20000), error: 'boom' });
    loader.capturedOnLog!('error', 'bigint', { n: 1n, error: 'boom' });
    loader.capturedOnLog!('error', 'long', { error: 'e'.repeat(10000) });
    loader.capturedOnLog!('error', 'nullmeta', null as unknown as Record<string, unknown>);

    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      '[p1] big',
      undefined,
      { error: 'boom', metaTruncated: true },
      { pluginId: 'p1' },
    );
    expect(errorSpy).toHaveBeenNthCalledWith(2, '[p1] bigint', undefined, { error: 'boom' }, { pluginId: 'p1' });
    const longMeta = errorSpy.mock.calls[2][2] as { error: string; metaTruncated: boolean };
    expect(longMeta.metaTruncated).toBe(true);
    expect(longMeta.error).toBe(`${'e'.repeat(8192)}…[truncated]`);
    expect(errorSpy).toHaveBeenNthCalledWith(4, '[p1] nullmeta', undefined, {}, { pluginId: 'p1' });
  });

  // postMessage keeps shared references shared, so a meta that is small to hold writes out, at every use, as JSON
  // text of any size: ten keys over the same child, eight levels deep, is a hundred million leaves.
  describe('a meta whose shared references write out to an enormous text', () => {
    const fanOut = (levels: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { leaf: 1 };
      for (let level = 0; level < levels; level++) {
        node = Object.fromEntries(Array.from({ length: 10 }, (_, key) => [`k${key}`, node]));
      }
      return node;
    };
    const ones = (length: number): number[] => new Array<number>(length).fill(1);

    it('is replaced by a size marker at once, without being written out', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

      const started = Date.now();
      loader.capturedOnLog!('log', 'fan-out', fanOut(8));

      expect(Date.now() - started).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] fan-out', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('keeps the error text of a worker error log', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const errorSpy = jest
        .spyOn((loader as unknown as { logger: { error: jest.Mock } }).logger, 'error')
        .mockImplementation(() => undefined);

      const started = Date.now();
      loader.capturedOnLog!('error', 'fan-out', { error: 'boom', fan: fanOut(8) });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(errorSpy).toHaveBeenCalledWith(
        '[p1] fan-out',
        undefined,
        { error: 'boom', metaTruncated: true },
        { pluginId: 'p1' },
      );
    });

    it('still reports the exact length of a meta that has no more values than the size limit', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

      // The array is one value and each entry another, and the limit is 8192 values: a text of more values than
      // that is longer than the size limit, so the walk stops there and no length is known.
      loader.capturedOnLog!('log', 'walked', ones(8191) as unknown as Record<string, unknown>);
      loader.capturedOnLog!('log', 'stopped', ones(8192) as unknown as Record<string, unknown>);

      expect(logSpy).toHaveBeenNthCalledWith(
        1,
        '[p1] walked',
        { metaTruncated: true, metaLength: 8191 + 8190 + 2 },
        { pluginId: 'p1' },
      );
      expect(logSpy).toHaveBeenNthCalledWith(2, '[p1] stopped', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('replaces a typed array of 20 million elements by the size marker at once', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

      const started = Date.now();
      loader.capturedOnLog!('log', 'buffer', { b: new Uint8Array(20_000_000) });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] buffer', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('replaces a String wrapper of 10 million characters by the size marker at once', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

      const started = Date.now();
      const boxed = structuredClone(new String('x'.repeat(10_000_000)));
      loader.capturedOnLog!('log', 'boxed', boxed as unknown as Record<string, unknown>);

      expect(Date.now() - started).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] boxed', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('replaces one long string shared by 2000 entries by the size marker at once', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const holder = { s: 'x'.repeat(500_000) };

      const started = Date.now();
      loader.capturedOnLog!('log', 'shared-string', { list: Array.from({ length: 2000 }, () => holder) });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] shared-string', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('replaces one object with a long property name shared by 4000 entries by the size marker at once', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const holder = { ['k'.repeat(100_000)]: 1 };

      const started = Date.now();
      loader.capturedOnLog!('log', 'shared-name', { list: Array.from({ length: 4000 }, () => holder) });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] shared-name', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('counts a Map or a Set by its size', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

      loader.capturedOnLog!('log', 'map', { m: new Map(ones(9000).map((one, key) => [key, one])) });
      loader.capturedOnLog!('log', 'set', { s: new Set(ones(9000).map((_, key) => key)) });

      expect(logSpy).toHaveBeenNthCalledWith(1, '[p1] map', { metaTruncated: true }, { pluginId: 'p1' });
      expect(logSpy).toHaveBeenNthCalledWith(2, '[p1] set', { metaTruncated: true }, { pluginId: 'p1' });
    });

    // JSON.stringify writes an Error, a Map and a Set as {}, but the logger writes what they hold.
    it('counts the message and stack of an Error and the entries of a Map or a Set that the logger writes', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const text = 'x'.repeat(9000);

      loader.capturedOnLog!('log', 'error', structuredClone({ e: new Error(text) }));
      loader.capturedOnLog!('log', 'map', structuredClone({ m: new Map([[1, text]]) }));
      loader.capturedOnLog!('log', 'set', structuredClone({ s: new Set([text]) }));
      loader.capturedOnLog!('log', 'small', structuredClone({ e: new Error('boom'), m: new Map([[1, 2]]) }));

      for (const [call, name] of [
        [1, 'error'],
        [2, 'map'],
        [3, 'set'],
      ] as const) {
        expect(logSpy).toHaveBeenNthCalledWith(call, `[p1] ${name}`, { metaTruncated: true }, { pluginId: 'p1' });
      }
      expect((logSpy.mock.calls[3][1] as { e: Error }).e.message).toBe('boom');
    });

    // Few values, but a long text once written: numbers in a Map, or a BigInt in a Set, which JSON.stringify alone
    // would write as {}. A worker's meta arrives in the host's realm; structuredClone here would make it in another,
    // which the logger copies by its own properties.
    it('measures the text of a Map or a Set as the logger writes it', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const float = -Math.PI * 1e-300;
      const pairs = Array.from({ length: 2000 }, (_, key): [number, number] => [float * (key + 1), float]);

      const started = Date.now();
      loader.capturedOnLog!('log', 'floats', { m: new Map(pairs) });
      loader.capturedOnLog!('log', 'bigints', { s: new Set([10n ** 100_000n, 10n ** 100_000n + 1n]) });

      expect(Date.now() - started).toBeLessThan(1000);
      const [floats, bigints] = logSpy.mock.calls.map(call => call[1] as Record<string, unknown>);
      expect(floats).toMatchObject({ metaTruncated: true });
      expect(floats.metaLength).toBeGreaterThan(8192);
      expect(bigints).toEqual({});
    });

    // Few values, but a longer text once written: an invalid Date is written as text where JSON.stringify writes null,
    // and the value of a credential key as the marker however short it is. A typed array is written as its type and
    // length, so one that fits the count is relayed.
    it('measures an invalid Date, a credential value and a typed array as the logger writes them', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const invalid = new Date(Number.NaN);

      loader.capturedOnLog!('log', 'dates', { d: Array.from({ length: 1600 }, () => new Date(Number.NaN)) });
      loader.capturedOnLog!('log', 'shared', { d: Array.from({ length: 1600 }, () => invalid) });
      loader.capturedOnLog!('log', 'tokens', { l: Array.from({ length: 600 }, () => ({ token: 0 })) });
      loader.capturedOnLog!('log', 'bytes', { b: new Uint8Array(5000) });

      const [dates, shared, tokens, bytes] = logSpy.mock.calls.map(call => call[1] as Record<string, unknown>);
      for (const marked of [dates, shared, tokens]) {
        expect(marked).toMatchObject({ metaTruncated: true });
        expect(marked.metaLength).toBeGreaterThan(8192);
      }
      expect(JSON.stringify(redactSecrets(bytes))).toBe('{"b":{"type":"Uint8Array","length":5000}}');
    });

    // A boxed string is written as its text, so one that fits is relayed and written in that many characters. A worker's
    // meta arrives in the host's realm; structuredClone here would make it in another, which the logger copies by its
    // own properties.
    it('relays a boxed string that the logger writes as its text', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const text = 'x'.repeat(8000);

      loader.capturedOnLog!('log', 'boxed', { s: new String(text) });

      expect(JSON.stringify(redactSecrets(logSpy.mock.calls[0][1]))).toBe(JSON.stringify({ s: text }));
    });

    it('still drops a circular meta without a marker, as it cannot be written as JSON', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const circular: Record<string, unknown> = { id: 1 };
      circular.self = circular;

      loader.capturedOnLog!('log', 'circular', circular);

      expect(logSpy).toHaveBeenCalledWith('[p1] circular', {}, { pluginId: 'p1' });
    });
  });
});
