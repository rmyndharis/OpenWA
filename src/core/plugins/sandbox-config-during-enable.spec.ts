import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { HookManager } from '../hooks';
import { PluginInstance, PluginStatus, PluginType } from './plugin.interfaces';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { WorkerThreadChannel } from './sandbox/worker-thread-channel';
import { PluginLogLevel } from './sandbox/protocol';

// A config saved while a sandboxed plugin is still enabling must reach the plugin's worker: outside a hook
// the worker answers ctx.config from the base config it was last handed, so a save that is never handed
// over leaves the plugin running on the config it had before the save, until the next save.

const BOOTSTRAP = path.resolve(__dirname, 'sandbox', 'worker-bootstrap.ts');
const TS_NODE_OPTS = JSON.stringify({
  module: 'commonjs',
  moduleResolution: 'node',
  resolvePackageJsonExports: false,
  ignoreDeprecations: '6.0',
});

// The plugin keeps its context and reports ctx.config.mode from its health check, which runs outside any
// hook, so it reads the worker's base config.
const PLUGIN_SOURCE = `module.exports = class {
  async onEnable(ctx) {
    this.ctx = ctx;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  healthCheck() {
    return { healthy: true, message: String(this.ctx.config.mode) };
  }
};
`;

class RealWorkerLoader extends PluginLoaderService {
  onEnableStarted?: () => void;
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
      32,
      onSearchProviderRegister,
      onWorkerExit,
      30000,
      5000,
      onUnresponsive,
    );
    const runLifecycle = host.runLifecycle.bind(host);
    host.runLifecycle = (method, timeoutMs) => {
      const running = runLifecycle(method, timeoutMs);
      if (method === 'onEnable') this.onEnableStarted?.();
      return running;
    };
    return host;
  }
}

describe('PluginLoaderService: a config saved while a sandboxed plugin is enabling', () => {
  jest.setTimeout(30000);

  let tmp: string;
  let loader: RealWorkerLoader;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-config-during-enable-'));
    fs.mkdirSync(path.join(tmp, 'p1'));
    fs.writeFileSync(path.join(tmp, 'p1', 'index.cjs'), PLUGIN_SOURCE);
    let stored: Record<string, unknown> = { mode: 'old' };
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue({}),
      getPluginConfig: jest.fn(() => stored),
      setPluginConfig: jest.fn((_id: string, config: Record<string, unknown>) => {
        stored = config;
      }),
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginEntry: jest.fn(),
      setPluginStatus: jest.fn(),
    } as unknown as PluginStorageService;
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const moduleRef = { get: jest.fn().mockReturnValue(undefined) } as unknown as ModuleRef;
    loader = new RealWorkerLoader(configService, new HookManager(), pluginStorage, moduleRef);
    const plugin: PluginInstance = {
      manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: PluginType.EXTENSION, main: 'index.cjs' },
      status: PluginStatus.INSTALLED,
      config: { mode: 'old' },
      instance: null,
      builtIn: false,
      packageDir: path.join(tmp, 'p1'),
    };
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
  });

  afterEach(async () => {
    await loader.disablePlugin('p1').catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is handed to the worker once the enable completes', async () => {
    const onEnableStarted = new Promise<void>(resolve => (loader.onEnableStarted = resolve));
    const enabling = loader.enablePlugin('p1');
    await onEnableStarted;

    // The operator saves the config while onEnable is still running in the worker.
    loader.updatePluginConfig('p1', { mode: 'new' });
    await enabling;

    expect(loader.getPlugin('p1')?.status).toBe(PluginStatus.ENABLED);
    expect(loader.getPlugin('p1')?.config).toEqual({ mode: 'new' });
    await expect(loader.checkPluginHealth('p1')).resolves.toMatchObject({ message: 'new' });
  });

  it('is handed to the worker when saved after the enable completed', async () => {
    await loader.enablePlugin('p1');

    loader.updatePluginConfig('p1', { mode: 'new' });

    await expect(loader.checkPluginHealth('p1')).resolves.toMatchObject({ message: 'new' });
  });
});

/** Records every call the loader makes on its worker host, in order; onEnable settles when the test says so. */
class RecordingLoader extends PluginLoaderService {
  readonly calls: string[] = [];
  readonly pushed: Record<string, unknown>[] = [];
  settleOnEnable: (error?: Error) => void = () => undefined;
  onEnableStarted?: () => void;
  protected createSandboxHost(): PluginWorkerHost {
    const host = {
      load: jest.fn(() => Promise.resolve(void this.calls.push('load'))),
      runLifecycle: jest.fn((method: string) => {
        this.calls.push(`lifecycle:${method}`);
        if (method !== 'onEnable') return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          this.settleOnEnable = error => (error ? reject(error) : resolve());
          this.onEnableStarted?.();
        });
      }),
      sendConfigChange: jest.fn((config: Record<string, unknown>) => {
        this.calls.push('config-change');
        this.pushed.push(config);
      }),
      terminate: jest.fn(() => Promise.resolve(void this.calls.push('terminate'))),
    };
    return host as unknown as PluginWorkerHost;
  }
}

describe('PluginLoaderService: the config push after a sandboxed enable', () => {
  const makeLoader = (): RecordingLoader => {
    const pluginStorage = {
      createPluginStorage: jest.fn().mockReturnValue({}),
      getPluginConfig: jest.fn().mockReturnValue({}),
      setPluginConfig: jest.fn(),
      getPluginEntry: jest.fn().mockReturnValue(undefined),
      setPluginStatus: jest.fn(),
    } as unknown as PluginStorageService;
    const loader = new RecordingLoader(
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      new HookManager(),
      pluginStorage,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ModuleRef,
    );
    const plugin: PluginInstance = {
      manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: PluginType.EXTENSION, main: 'index.cjs' },
      status: PluginStatus.INSTALLED,
      config: { mode: 'old' },
      instance: null,
      builtIn: false,
      packageDir: path.join(os.tmpdir(), 'p1'),
    };
    (loader as unknown as { plugins: Map<string, PluginInstance> }).plugins.set('p1', plugin);
    return loader;
  };

  // Wrapped: an async function returning the enable promise itself would wait for the enable to settle.
  const startEnable = async (loader: RecordingLoader): Promise<{ enabling: Promise<void> }> => {
    const started = new Promise<void>(resolve => (loader.onEnableStarted = resolve));
    const enabling = loader.enablePlugin('p1');
    await started;
    return { enabling };
  };

  it('sends a config saved during onEnable only after onEnable finished', async () => {
    const loader = makeLoader();
    const { enabling } = await startEnable(loader);

    loader.updatePluginConfig('p1', { mode: 'new' });
    expect(loader.calls).not.toContain('config-change');
    loader.settleOnEnable();
    await enabling;

    expect(loader.calls).toEqual(['load', 'lifecycle:onLoad', 'lifecycle:onEnable', 'config-change']);
    expect(loader.pushed).toEqual([{ mode: 'new' }]);
  });

  it('sends one push carrying the last of several saves made during onEnable', async () => {
    const loader = makeLoader();
    const { enabling } = await startEnable(loader);

    loader.updatePluginConfig('p1', { mode: 'mid' });
    loader.updatePluginConfig('p1', { other: 1 });
    loader.settleOnEnable();
    await enabling;

    expect(loader.pushed).toEqual([{ mode: 'mid', other: 1 }]);
  });

  it('sends nothing when no config was saved during the enable', async () => {
    const loader = makeLoader();
    const { enabling } = await startEnable(loader);

    loader.settleOnEnable();
    await enabling;

    expect(loader.calls).not.toContain('config-change');
  });

  it('sends nothing when the enable fails', async () => {
    const loader = makeLoader();
    const { enabling } = await startEnable(loader);

    loader.updatePluginConfig('p1', { mode: 'new' });
    loader.settleOnEnable(new Error('onEnable failed'));
    await expect(enabling).rejects.toThrow('onEnable failed');

    expect(loader.calls).not.toContain('config-change');
    expect(loader.getPlugin('p1')?.status).toBe(PluginStatus.ERROR);
  });
});
