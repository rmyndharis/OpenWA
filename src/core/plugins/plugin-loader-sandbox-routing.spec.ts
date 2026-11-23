import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import {
  HookContext,
  HookEvent,
  HookExecutionError,
  HookHandler,
  HookManager,
  HOOK_FAIL_CLOSED_SYMBOL,
} from '../hooks';
import { IPlugin, PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { HostToWorkerMessage, PluginLogLevel, PluginWorkerChannel, WorkerToHostMessage } from './sandbox/protocol';
import { WorkerHookHandler, WorkerHookRegistry } from './sandbox/worker-hooks';
import { LoggerService } from '../../common/services/logger.service';
import { PLUGIN_SEARCH_REGISTRY_PORT } from './plugin-host-ports';
import { SearchProviderRegistry } from '../../modules/search/search-provider.registry';
import { redactSecrets } from '../../common/services/logger.service';
import { leastCpuMs } from '../../../test/helpers/cpu-time';

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

    // Under fail-open mode, the shim does NOT attach `error` to the HookResult (preserving the
    // 60s log flood guard and avoiding discarding earlier-handler redactions). Under fail-closed
    // mode (HOOK_FAIL_CLOSED_SYMBOL), it propagates `error` to HookManager.
    const failOpenResult = await handler(ctx('message:sent'));
    expect(failOpenResult).toEqual({ continue: true });
    const failClosedCtx = ctx('message:sent');
    Object.defineProperty(failClosedCtx, HOOK_FAIL_CLOSED_SYMBOL, { value: true, enumerable: false });
    const failClosedResult = await handler(failClosedCtx);
    expect(failClosedResult.continue).toBe(true);
    expect(failClosedResult.error).toBeInstanceOf(Error);
    expect(failClosedResult.error?.message).toBe('boom');
    const hookManager = (loader as unknown as { hookManager: HookManager }).hookManager;
    await expect(
      hookManager.execute('message:sent', { ok: true }, { sessionId: 's1', source: 'Engine' }),
    ).resolves.toEqual({
      continue: true,
      data: { ok: true },
    });

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

  // Plugin code can post the declaration itself, as often as it likes.
  it('takes one declaration per worker, so a repeat cannot retake the active slot', async () => {
    const { loader, registry } = await setup();
    registry.register({ id: 'plugin:other', label: 'Other', search: jest.fn(), health: jest.fn() });
    registry.setActive('plugin:other');

    loader.capturedOnSearchProviderRegister!();

    expect(registry.active()?.id).toBe('plugin:other');
  });

  it('denies an undeclared provider with one warning per worker', async () => {
    const loader = makeLoader(new SearchProviderRegistry());
    seed(loader, { builtIn: false, instance: null });
    await loader.enablePlugin('p1');
    const logger = (loader as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    loader.capturedOnSearchProviderRegister!();
    loader.capturedOnSearchProviderRegister!();

    expect(
      warn.mock.calls.filter(([, meta]) => (meta as { action?: string })?.action === 'sandbox_search_provider_denied'),
    ).toHaveLength(1);
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

  // The bounds below are asserted on the cheapest of three relays of the same line. The relay drops a line past
  // 200 in a window and a run relays at most two, so no run is dropped, which would make it cheaper than the work.

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

      const cpuMs = leastCpuMs(() => loader.capturedOnLog!('log', sharedArray(7) as unknown as string));

      expect(cpuMs).toBeLessThan(1000);
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

      const cpuMs = leastCpuMs(() => loader.capturedOnLog!('log', 'fan-out', fanOut(8)));

      expect(cpuMs).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] fan-out', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('keeps the error text of a worker error log', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const errorSpy = jest
        .spyOn((loader as unknown as { logger: { error: jest.Mock } }).logger, 'error')
        .mockImplementation(() => undefined);

      const cpuMs = leastCpuMs(() => loader.capturedOnLog!('error', 'fan-out', { error: 'boom', fan: fanOut(8) }));

      expect(cpuMs).toBeLessThan(1000);
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

      const meta = { b: new Uint8Array(20_000_000) };

      const cpuMs = leastCpuMs(() => loader.capturedOnLog!('log', 'buffer', meta));

      expect(cpuMs).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] buffer', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('replaces a String wrapper of 10 million characters by the size marker at once', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);

      const boxed = structuredClone(new String('x'.repeat(10_000_000)));

      const cpuMs = leastCpuMs(() =>
        loader.capturedOnLog!('log', 'boxed', boxed as unknown as Record<string, unknown>),
      );

      expect(cpuMs).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] boxed', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('replaces one long string shared by 2000 entries by the size marker at once', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const holder = { s: 'x'.repeat(500_000) };

      const cpuMs = leastCpuMs(() =>
        loader.capturedOnLog!('log', 'shared-string', { list: Array.from({ length: 2000 }, () => holder) }),
      );

      expect(cpuMs).toBeLessThan(1000);
      expect(logSpy).toHaveBeenCalledWith('[p1] shared-string', { metaTruncated: true }, { pluginId: 'p1' });
    });

    it('replaces one object with a long property name shared by 4000 entries by the size marker at once', async () => {
      const loader = makeLoader();
      seed(loader, { builtIn: false, instance: null });
      await loader.enablePlugin('p1');
      const logSpy = jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
      const holder = { ['k'.repeat(100_000)]: 1 };

      const cpuMs = leastCpuMs(() =>
        loader.capturedOnLog!('log', 'shared-name', { list: Array.from({ length: 4000 }, () => holder) }),
      );

      expect(cpuMs).toBeLessThan(1000);
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

      const cpuMs = leastCpuMs(() => {
        loader.capturedOnLog!('log', 'floats', { m: new Map(pairs) });
        loader.capturedOnLog!('log', 'bigints', { s: new Set([10n ** 100_000n, 10n ** 100_000n + 1n]) });
      });

      expect(cpuMs).toBeLessThan(1000);
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

describe('PluginLoaderService - sandboxed pre-egress hook fail-closed propagation', () => {
  const prevEnv = process.env.HOOK_PRE_EGRESS_FAIL_CLOSED;

  afterEach(() => {
    jest.useRealTimers();
    if (prevEnv === undefined) delete process.env.HOOK_PRE_EGRESS_FAIL_CLOSED;
    else process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = prevEnv;
  });

  class ManualChannel implements PluginWorkerChannel {
    private msgHandler?: (m: WorkerToHostMessage) => void;
    private exitHandler?: (code: number) => void;
    readonly sent: HostToWorkerMessage[] = [];
    postMessage(m: HostToWorkerMessage): void {
      this.sent.push(m);
      if (m.kind === 'load') queueMicrotask(() => this.msgHandler?.({ kind: 'ready' }));
      if (m.kind === 'lifecycle')
        queueMicrotask(() => this.msgHandler?.({ kind: 'lifecycle-result', id: m.id, ok: true }));
    }
    onMessage(handler: (m: WorkerToHostMessage) => void): void {
      this.msgHandler = handler;
    }
    onExit(handler: (code: number) => void): void {
      this.exitHandler = handler;
    }
    terminate(): Promise<void> {
      return Promise.resolve();
    }
    reply(m: WorkerToHostMessage): void {
      this.msgHandler?.(m);
    }
    crash(code = 1): void {
      this.exitHandler?.(code);
    }
  }

  class RealHostLoader extends PluginLoaderService {
    readonly channels: ManualChannel[] = [];
    protected createSandboxHost(
      capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
      onHookSubscribe?: (event: string, priority?: number) => void,
      onWebhookSubscribe?: (route: string) => void,
      onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
      runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
      onSearchProviderRegister?: () => void,
      onWorkerExit?: (code: number, intentional: boolean, reason?: string) => void,
      onUnresponsive?: () => void,
    ): PluginWorkerHost {
      const channel = new ManualChannel();
      this.channels.push(channel);
      return new PluginWorkerHost(
        channel,
        capDispatcher,
        onHookSubscribe,
        onWebhookSubscribe,
        onLog,
        runWithHookGuard,
        undefined,
        onSearchProviderRegister,
        onWorkerExit,
        undefined,
        undefined,
        onUnresponsive,
      );
    }
  }

  async function createSandboxedHarness(failClosed: boolean): Promise<{
    hookManager: HookManager;
    channel: ManualChannel;
    loader: RealHostLoader;
  }> {
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'hooks.preEgressFailClosed') return failClosed;
        return undefined;
      }),
    } as unknown as ConfigService;
    const hookManager = new HookManager(configService);
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue({}),
      getPluginConfig: jest.fn().mockReturnValue(undefined),
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginEntry: jest.fn(),
      setPluginStatus: jest.fn(),
    } as unknown as PluginStorageService;
    const moduleRef = { get: jest.fn().mockReturnValue(undefined) } as unknown as ModuleRef;
    const loader = new RealHostLoader(configService, hookManager, pluginStorage, moduleRef);
    const plugin: PluginInstance = {
      manifest: manifest(),
      status: PluginStatus.INSTALLED,
      config: {},
      instance: null,
      builtIn: false,
    };
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
    await loader.enablePlugin('p1');
    return { hookManager, channel: loader.channels[0], loader };
  }

  it('fails closed with HookExecutionError when a sandboxed message:sending hook times out', async () => {
    const { hookManager, channel, loader } = await createSandboxedHarness(true);
    const warnSpy = jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    channel.reply({ kind: 'hook-subscribe', event: 'message:sending', priority: 10 });

    jest.useFakeTimers();
    const pending = hookManager.execute('message:sending', { input: { text: 'hi' } }, { sessionId: 's1', source: 't' });
    jest.advanceTimersByTime(5000);

    await expect(pending).rejects.toBeInstanceOf(HookExecutionError);
    await expect(pending).rejects.toMatchObject({ pluginId: 'p1', event: 'message:sending' });
    // Logged once as sandbox_hook_timeout, not double-recorded as sandbox_hook_error.
    const actions = warnSpy.mock.calls.map(c => (c[1] as { action?: string } | undefined)?.action);
    expect(actions.filter(a => a === 'sandbox_hook_timeout')).toHaveLength(1);
    expect(actions.filter(a => a === 'sandbox_hook_error')).toHaveLength(0);
  });

  it('fails closed with HookExecutionError when a sandboxed worker crashes during webhook:before', async () => {
    const { hookManager, channel, loader } = await createSandboxedHarness(true);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    channel.reply({ kind: 'hook-subscribe', event: 'webhook:before', priority: 10 });

    const pending = hookManager.execute(
      'webhook:before',
      { payload: { event: 'message.received', data: {} } },
      { sessionId: 's1', source: 'WebhookService' },
    );
    channel.crash(1);

    await expect(pending).rejects.toBeInstanceOf(HookExecutionError);
    await expect(pending).rejects.toMatchObject({ pluginId: 'p1', event: 'webhook:before' });
  });

  it('keeps fail-open behavior for sandboxed timeout when preEgressFailClosed is false', async () => {
    const { hookManager, channel, loader } = await createSandboxedHarness(false);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    channel.reply({ kind: 'hook-subscribe', event: 'message:sending', priority: 10 });

    jest.useFakeTimers();
    const pending = hookManager.execute('message:sending', { input: { text: 'hi' } }, { sessionId: 's1', source: 't' });
    jest.advanceTimersByTime(5000);

    await expect(pending).resolves.toEqual({ continue: true, data: { input: { text: 'hi' } } });
  });

  it('under default fail-open mode, a sandboxed timeout does not trigger HookManager logger.error', async () => {
    const { hookManager, channel, loader } = await createSandboxedHarness(false);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    try {
      channel.reply({ kind: 'hook-subscribe', event: 'message:sending', priority: 10 });
      jest.useFakeTimers();
      const pending = hookManager.execute(
        'message:sending',
        { input: { text: 'hi' } },
        { sessionId: 's1', source: 't' },
      );
      jest.advanceTimersByTime(5000);

      await expect(pending).resolves.toEqual({ continue: true, data: { input: { text: 'hi' } } });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  /** Channel wired directly to a real WorkerHookRegistry so worker-side dispatch logic runs end to end. */
  class WiredWorkerChannel extends ManualChannel {
    readonly workerHooks: WorkerHookRegistry;
    constructor() {
      super();
      this.workerHooks = new WorkerHookRegistry(msg => this.reply(msg));
    }
    override postMessage(m: HostToWorkerMessage): void {
      super.postMessage(m);
      if (m.kind === 'hook') {
        void this.workerHooks.handleHook(m);
      }
    }
  }

  class WiredWorkerLoader extends PluginLoaderService {
    readonly channels: WiredWorkerChannel[] = [];
    capturedOnUnresponsive?: () => void;
    protected createSandboxHost(
      capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
      onHookSubscribe?: (event: string, priority?: number) => void,
      onWebhookSubscribe?: (route: string) => void,
      onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
      runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
      onSearchProviderRegister?: () => void,
      onWorkerExit?: (code: number, intentional: boolean, reason?: string) => void,
      onUnresponsive?: () => void,
    ): PluginWorkerHost {
      const channel = new WiredWorkerChannel();
      this.channels.push(channel);
      this.capturedOnUnresponsive = onUnresponsive;
      return new PluginWorkerHost(
        channel,
        capDispatcher,
        onHookSubscribe,
        onWebhookSubscribe,
        onLog,
        runWithHookGuard,
        undefined,
        onSearchProviderRegister,
        onWorkerExit,
        undefined,
        undefined,
        onUnresponsive,
      );
    }
  }

  async function createWiredHarness(failClosed: boolean): Promise<{
    hookManager: HookManager;
    channel: WiredWorkerChannel;
    loader: WiredWorkerLoader;
  }> {
    const configService = {
      get: jest.fn((key: string) => (key === 'hooks.preEgressFailClosed' ? failClosed : undefined)),
    } as unknown as ConfigService;
    const hookManager = new HookManager(configService);
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue({}),
      getPluginConfig: jest.fn().mockReturnValue(undefined),
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginEntry: jest.fn(),
      setPluginStatus: jest.fn(),
    } as unknown as PluginStorageService;
    const moduleRef = { get: jest.fn().mockReturnValue(undefined) } as unknown as ModuleRef;
    const loader = new WiredWorkerLoader(configService, hookManager, pluginStorage, moduleRef);
    const plugin: PluginInstance = {
      manifest: manifest(),
      status: PluginStatus.INSTALLED,
      config: {},
      instance: null,
      builtIn: false,
    };
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
    await loader.enablePlugin('p1');
    return { hookManager, channel: loader.channels[0], loader };
  }

  it.each([
    ['corrupted payload string', { payload: 'corrupted' }],
    ['empty object', {}],
    ['null', null],
    ['null payload', { payload: null }],
  ])('fails closed when sandboxed webhook:before returns unusable data (%s)', async (_label, badData) => {
    const { hookManager, channel, loader } = await createWiredHarness(true);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    channel.workerHooks.register('webhook:before', () => ({ continue: true, data: badData }));

    await expect(
      hookManager.execute(
        'webhook:before',
        { sessionId: 's1', event: 'message.received', payload: { data: { ok: true } } },
        { sessionId: 's1', source: 'WebhookService' },
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);
  });

  it('fails closed when sandboxed plugin returns { continue: false, error }', async () => {
    const { hookManager, channel, loader } = await createWiredHarness(true);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    channel.workerHooks.register('webhook:before', () => ({ continue: false, error: new Error('db error') }));

    await expect(
      hookManager.execute(
        'webhook:before',
        { sessionId: 's1', event: 'message.received', payload: { data: {} } },
        { sessionId: 's1', source: 'WebhookService' },
      ),
    ).rejects.toMatchObject({ name: 'HookExecutionError', pluginId: 'p1', event: 'webhook:before' });
  });

  it.each<[string, () => unknown]>([
    ['empty Error', () => new Error()],
    ['empty string', () => ''],
    ['AggregateError with empty message', () => new AggregateError([new Error('ECONNREFUSED')], '')],
    ['null-prototype object', () => Object.create(null) as unknown],
  ])('fails closed when sandboxed plugin throws pathological value (%s)', async (_label, makeErr) => {
    const { hookManager, channel, loader } = await createWiredHarness(true);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const throwingHandler: WorkerHookHandler = () => {
      throw makeErr();
    };
    channel.workerHooks.register('message:sending', throwingHandler);

    await expect(
      hookManager.execute('message:sending', { input: { text: 'hi' } }, { sessionId: 's1', source: 'MessageService' }),
    ).rejects.toBeInstanceOf(HookExecutionError);
  });

  it('propagates per-call failClosed:true into sandboxed worker even when global flag is false', async () => {
    const { hookManager, channel, loader } = await createWiredHarness(false);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    channel.workerHooks.register('message:received', () => Promise.reject(new Error('strict observer failed')));

    await expect(
      hookManager.execute('message:received', { id: 'm1', chatId: 'c@c.us' }, { source: 'Engine', failClosed: true }),
    ).rejects.toBeInstanceOf(HookExecutionError);
  });

  it('under default fail-open mode, does not trigger HookManager logger.error and preserves earlier-handler redactions', async () => {
    const { hookManager, channel, loader } = await createWiredHarness(false);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    try {
      channel.workerHooks.register(
        'message:sending',
        ctx => ({ continue: true, data: { ...(ctx.data as object), redacted: true } }),
        10,
      );
      channel.workerHooks.register('message:sending', () => Promise.reject(new Error('telemetry down')), 20);

      const res = await hookManager.execute(
        'message:sending',
        { input: { text: 'secret' } },
        { sessionId: 's1', source: 'MessageService' },
      );

      expect(res).toEqual({ continue: true, data: { input: { text: 'secret' }, redacted: true } });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps failing closed on subsequent sends/webhooks after worker crash and recovers cleanly on disable, unload, or re-enable', async () => {
    const { hookManager, channel, loader } = await createWiredHarness(true);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    channel.workerHooks.register('message:received', () => ({ continue: true }));
    channel.workerHooks.register('message:sending', () => ({ continue: true }));
    channel.workerHooks.register('webhook:before', () => ({ continue: true }));

    // Crash the worker: non-pre-egress hooks drop, pre-egress shims stay active in ERROR state.
    channel.crash(1);
    expect(pluginOf(loader as unknown as TestableLoader).status).toBe(PluginStatus.ERROR);
    expect(hookManager.getHookCount('message:received')).toBe(0);
    expect(hookManager.getHookCount('message:sending')).toBe(1);
    expect(hookManager.getHookCount('webhook:before')).toBe(1);

    // Subsequent sends and webhooks MUST still fail closed!
    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'after crash' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).rejects.toMatchObject({ name: 'HookExecutionError', pluginId: 'p1', event: 'message:sending' });
    await expect(
      hookManager.execute(
        'webhook:before',
        { sessionId: 's1', event: 'message.received', payload: { data: {} } },
        { sessionId: 's1', source: 'WebhookService' },
      ),
    ).rejects.toMatchObject({ name: 'HookExecutionError', pluginId: 'p1', event: 'webhook:before' });

    // Re-enabling replaces the retained shims without duplicating them.
    await loader.enablePlugin('p1');
    const secondChannel = loader.channels[1];
    secondChannel.workerHooks.register('message:sending', () => ({ continue: true }));
    expect(hookManager.getHookCount('message:sending')).toBe(1);
    expect(hookManager.getHookCount('webhook:before')).toBe(0);
    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'recovered' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).resolves.toEqual({ continue: true, data: { input: { text: 'recovered' } } });

    // Mark unresponsive -> still fails closed on subsequent sends, then disablePlugin clears it!
    loader.capturedOnUnresponsive!();
    expect(pluginOf(loader as unknown as TestableLoader).status).toBe(PluginStatus.ERROR);
    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'after hang' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);

    await loader.disablePlugin('p1');
    expect(pluginOf(loader as unknown as TestableLoader).status).toBe(PluginStatus.DISABLED);
    expect(hookManager.getHookCount('message:sending')).toBe(0);
    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'disabled' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).resolves.toEqual({ continue: true, data: { input: { text: 'disabled' } } });

    // Re-enable, crash again, then unloadPlugin clears retained shims cleanly!
    await loader.enablePlugin('p1');
    const thirdChannel = loader.channels[2];
    thirdChannel.workerHooks.register('message:sending', () => ({ continue: true }));
    thirdChannel.crash(1);
    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'before unload' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);

    await loader.unloadPlugin('p1');
    expect(hookManager.getHookCount('message:sending')).toBe(0);
    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'unloaded' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).resolves.toEqual({ continue: true, data: { input: { text: 'unloaded' } } });
  });

  /** Channel that can pause, fail, or crash during a specific lifecycle hook (such as onEnable). */
  class ControllableWiredChannel extends WiredWorkerChannel {
    onEnableBehavior?: (id: number, channel: ControllableWiredChannel) => void;
    override postMessage(m: HostToWorkerMessage): void {
      if (m.kind === 'lifecycle' && m.method === 'onEnable' && this.onEnableBehavior) {
        this.sent.push(m);
        this.onEnableBehavior(m.id, this);
        return;
      }
      super.postMessage(m);
    }
  }

  class ControllableWiredLoader extends PluginLoaderService {
    readonly channels: ControllableWiredChannel[] = [];
    nextOnEnableBehavior?: (id: number, channel: ControllableWiredChannel) => void;
    protected createSandboxHost(
      capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
      onHookSubscribe?: (event: string, priority?: number) => void,
      onWebhookSubscribe?: (route: string) => void,
      onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
      runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
      onSearchProviderRegister?: () => void,
      onWorkerExit?: (code: number, intentional: boolean, reason?: string) => void,
      onUnresponsive?: () => void,
    ): PluginWorkerHost {
      const channel = new ControllableWiredChannel();
      channel.onEnableBehavior = this.nextOnEnableBehavior;
      this.nextOnEnableBehavior = undefined;
      this.channels.push(channel);
      return new PluginWorkerHost(
        channel,
        capDispatcher,
        onHookSubscribe,
        onWebhookSubscribe,
        onLog,
        runWithHookGuard,
        undefined,
        onSearchProviderRegister,
        onWorkerExit,
        undefined,
        undefined,
        onUnresponsive,
      );
    }
  }

  async function createControllableHarness(failClosed: boolean): Promise<{
    hookManager: HookManager;
    channel: ControllableWiredChannel;
    loader: ControllableWiredLoader;
  }> {
    const configService = {
      get: jest.fn((key: string) => (key === 'hooks.preEgressFailClosed' ? failClosed : undefined)),
    } as unknown as ConfigService;
    const hookManager = new HookManager(configService);
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue({}),
      getPluginConfig: jest.fn().mockReturnValue(undefined),
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginEntry: jest.fn(),
      setPluginStatus: jest.fn(),
    } as unknown as PluginStorageService;
    const moduleRef = { get: jest.fn().mockReturnValue(undefined) } as unknown as ModuleRef;
    const loader = new ControllableWiredLoader(configService, hookManager, pluginStorage, moduleRef);
    const plugin: PluginInstance = {
      manifest: manifest(),
      status: PluginStatus.INSTALLED,
      config: {},
      instance: null,
      builtIn: false,
    };
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
    await loader.enablePlugin('p1');
    return { hookManager, channel: loader.channels[0], loader };
  }

  it('keeps pre-egress hooks failing closed while re-enable is in flight and swaps cleanly without duplicates', async () => {
    const { hookManager, channel, loader } = await createControllableHarness(true);
    jest
      .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);
    channel.workerHooks.register('message:sending', () => ({ continue: true }));
    channel.workerHooks.register('webhook:before', () => ({ continue: true }));

    // Crash worker -> plugin sits in ERROR with retained pre-egress shims.
    channel.crash(1);
    expect(pluginOf(loader as unknown as TestableLoader).status).toBe(PluginStatus.ERROR);

    let enteredOnEnable!: () => void;
    const onEnableStarted = new Promise<void>(resolve => (enteredOnEnable = resolve));
    let subscribeNewHooks!: () => void;
    let finishOnEnable!: () => void;
    const newSendHandler = jest.fn(() => ({ continue: true }));
    const newWebhookHandler = jest.fn(() => ({ continue: true }));

    loader.nextOnEnableBehavior = (id, ch) => {
      enteredOnEnable();
      subscribeNewHooks = () => {
        ch.workerHooks.register('message:sending', newSendHandler);
        ch.workerHooks.register('webhook:before', newWebhookHandler);
      };
      finishOnEnable = () => ch.reply({ kind: 'lifecycle-result', id, ok: true });
    };

    const reEnablePromise = loader.enablePlugin('p1');
    await onEnableStarted;

    // Phase A: onEnable is paused before the replacement worker subscribes any hooks (only retained
    // shims exist while sandboxHosts already points at the new worker). Both MUST fail closed.
    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'mid-enable-before-subscribe' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);
    await expect(
      hookManager.execute(
        'webhook:before',
        { sessionId: 's1', event: 'message.received', payload: { data: {} } },
        { sessionId: 's1', source: 'WebhookService' },
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);

    // Phase B: replacement worker subscribes hooks during onEnable before onEnable resolves.
    // Both MUST still fail closed and MUST NOT dispatch into the half-initialized worker.
    subscribeNewHooks();
    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'mid-enable-after-subscribe' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);
    await expect(
      hookManager.execute(
        'webhook:before',
        { sessionId: 's1', event: 'message.received', payload: { data: {} } },
        { sessionId: 's1', source: 'WebhookService' },
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);
    expect(newSendHandler).not.toHaveBeenCalled();
    expect(newWebhookHandler).not.toHaveBeenCalled();

    // Finish onEnable -> prior shims dropped, fresh shims active with zero duplicates.
    finishOnEnable();
    await reEnablePromise;

    expect(pluginOf(loader as unknown as TestableLoader).status).toBe(PluginStatus.ENABLED);
    expect(hookManager.getHookCount('message:sending')).toBe(1);
    expect(hookManager.getHookCount('webhook:before')).toBe(1);

    await expect(
      hookManager.execute(
        'message:sending',
        { input: { text: 'after-enable' } },
        { sessionId: 's1', source: 'MessageService' },
      ),
    ).resolves.toEqual({ continue: true, data: { input: { text: 'after-enable' } } });
    expect(newSendHandler).toHaveBeenCalledTimes(1);
  });

  it.each<'throw' | 'crash'>(['throw', 'crash'])(
    'retains fail-closed pre-egress shims without duplicates when re-enable fails via %s in onEnable',
    async failureMode => {
      const { hookManager, channel, loader } = await createControllableHarness(true);
      jest
        .spyOn((loader as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);
      channel.workerHooks.register('message:sending', () => ({ continue: true }));
      channel.workerHooks.register('webhook:before', () => ({ continue: true }));

      channel.crash(1);
      expect(pluginOf(loader as unknown as TestableLoader).status).toBe(PluginStatus.ERROR);
      expect(hookManager.getHookCount('message:sending')).toBe(1);
      expect(hookManager.getHookCount('webhook:before')).toBe(1);

      loader.nextOnEnableBehavior = (id, ch) => {
        // Subscribe hooks before failing to ensure partial registrations from the failed attempt are cleaned up.
        ch.workerHooks.register('message:sending', () => ({ continue: true }));
        ch.workerHooks.register('message:received', () => ({ continue: true }));
        if (failureMode === 'throw') {
          queueMicrotask(() => ch.reply({ kind: 'lifecycle-result', id, ok: false, error: 'onEnable failed' }));
        } else {
          queueMicrotask(() => ch.crash(1));
        }
      };

      await expect(loader.enablePlugin('p1')).rejects.toThrow();

      // Plugin stays in ERROR, retained shims stay intact with zero duplicates, non-pre-egress partial hooks dropped.
      expect(pluginOf(loader as unknown as TestableLoader).status).toBe(PluginStatus.ERROR);
      expect(hookManager.getHookCount('message:received')).toBe(0);
      expect(hookManager.getHookCount('message:sending')).toBe(1);
      expect(hookManager.getHookCount('webhook:before')).toBe(1);

      await expect(
        hookManager.execute(
          'message:sending',
          { input: { text: 'still-blocked' } },
          { sessionId: 's1', source: 'MessageService' },
        ),
      ).rejects.toBeInstanceOf(HookExecutionError);
      await expect(
        hookManager.execute(
          'webhook:before',
          { sessionId: 's1', event: 'message.received', payload: { data: {} } },
          { sessionId: 's1', source: 'WebhookService' },
        ),
      ).rejects.toBeInstanceOf(HookExecutionError);

      // Recovery via disablePlugin clears the retained shims cleanly.
      await loader.disablePlugin('p1');
      expect(pluginOf(loader as unknown as TestableLoader).status).toBe(PluginStatus.DISABLED);
      expect(hookManager.getHookCount('message:sending')).toBe(0);
      expect(hookManager.getHookCount('webhook:before')).toBe(0);
      await expect(
        hookManager.execute(
          'message:sending',
          { input: { text: 'recovered-after-disable' } },
          { sessionId: 's1', source: 'MessageService' },
        ),
      ).resolves.toEqual({ continue: true, data: { input: { text: 'recovered-after-disable' } } });
    },
  );
});
