import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookContext, HookEvent, HookHandler, HookManager } from '../hooks';
import { IPlugin, PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { PluginLogLevel } from './sandbox/protocol';

type FakeHost = {
  load: jest.Mock;
  runLifecycle: jest.Mock;
  terminate: jest.Mock;
  dispatchHook: jest.Mock;
  healthCheck: jest.Mock;
};

/** Loader that returns fake worker hosts so routing is testable without spawning a real OS thread. */
class TestableLoader extends PluginLoaderService {
  readonly hosts: FakeHost[] = [];
  capturedOnHookSubscribe?: (event: string, priority?: number) => void;
  capturedOnLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void;
  capturedOnWorkerExit?: (code: number, intentional: boolean) => void;
  capturedOnUnresponsive?: () => void;
  protected createSandboxHost(
    _capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
    onHookSubscribe?: (event: string, priority?: number) => void,
    _onWebhookSubscribe?: (route: string) => void,
    onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
    _runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
    _onSearchProviderRegister?: () => void,
    onWorkerExit?: (code: number, intentional: boolean) => void,
    onUnresponsive?: () => void,
  ): PluginWorkerHost {
    this.capturedOnHookSubscribe = onHookSubscribe;
    this.capturedOnLog = onLog;
    this.capturedOnWorkerExit = onWorkerExit;
    this.capturedOnUnresponsive = onUnresponsive;
    const host: FakeHost = {
      load: jest.fn().mockResolvedValue(undefined),
      runLifecycle: jest.fn().mockResolvedValue(undefined),
      terminate: jest.fn().mockResolvedValue(undefined),
      dispatchHook: jest.fn().mockResolvedValue({ continue: true }),
      healthCheck: jest.fn().mockResolvedValue({ healthy: true }),
    };
    this.hosts.push(host);
    return host as unknown as PluginWorkerHost;
  }
}

function makeLoader(): TestableLoader {
  const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  const pluginStorage = {
    createPluginStorage: jest.fn().mockReturnValue({}),
    getPluginConfig: jest.fn().mockReturnValue(undefined),
    getPluginEntry: jest.fn().mockReturnValue(undefined),
    setPluginEntry: jest.fn(),
    setPluginStatus: jest.fn(),
  } as unknown as PluginStorageService;
  const moduleRef = { get: jest.fn() } as unknown as ModuleRef;
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
});
