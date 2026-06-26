import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import { IPlugin, PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';

type FakeHost = { load: jest.Mock; runLifecycle: jest.Mock; terminate: jest.Mock };

/** Loader that returns fake worker hosts so routing is testable without spawning a real OS thread. */
class TestableLoader extends PluginLoaderService {
  readonly hosts: FakeHost[] = [];
  capturedOnHookSubscribe?: (event: string, priority?: number) => void;
  protected createSandboxHost(
    _capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
    onHookSubscribe?: (event: string, priority?: number) => void,
  ): PluginWorkerHost {
    this.capturedOnHookSubscribe = onHookSubscribe;
    const host: FakeHost = {
      load: jest.fn().mockResolvedValue(undefined),
      runLifecycle: jest.fn().mockResolvedValue(undefined),
      terminate: jest.fn().mockResolvedValue(undefined),
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
