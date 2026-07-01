import * as path from 'path';
import { WorkerThreadChannel } from './worker-thread-channel';
import { PluginWorkerHost } from './plugin-worker-host';

// Repo root, from src/core/plugins/sandbox.
const ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP = path.resolve(__dirname, 'worker-bootstrap.ts');
const FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/echo-plugin.cjs');
const CAP_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/cap-echo-plugin.cjs');
const HOOK_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/hook-plugin.cjs');
const HOOK_HANG_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/hook-hang-plugin.cjs');
const RUNAWAY_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/runaway-plugin.cjs');
const CTX_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/ctx-aware-plugin.cjs');
const HOOK_CONFIG_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/hook-config-plugin.cjs');
const CTX_LIFECYCLE_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/ctx-lifecycle-plugin.cjs');
const flushAsync = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// Run the TS bootstrap inside the worker via ts-node. The base tsconfig is nodenext; we pin the
// worker's transpile to CommonJS (same override the jest/ts-jest config uses) so `require()` works.
// Production loads the compiled `worker-bootstrap.js` directly and needs none of this.
const TS_NODE_OPTS = JSON.stringify({ module: 'commonjs', moduleResolution: 'node', resolvePackageJsonExports: false });

const makeChannel = (): WorkerThreadChannel =>
  new WorkerThreadChannel({
    workerEntry: BOOTSTRAP,
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TS_NODE_OPTS },
  });

const makeHost = (capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>): PluginWorkerHost =>
  new PluginWorkerHost(makeChannel(), capDispatcher);

describe('plugin worker — real worker_threads round-trip (B1)', () => {
  jest.setTimeout(30000);

  it('loads a plugin and runs its lifecycle in a real worker thread', async () => {
    const host = makeHost();
    await host.load(FIXTURE);
    await host.runLifecycle('onEnable');
    await host.runLifecycle('onDisable');
    await host.terminate();
  });

  it('rejects load() when the plugin module cannot be required', async () => {
    const host = makeHost();
    await expect(host.load(path.resolve(ROOT, 'test/fixtures/sandbox/missing.cjs'))).rejects.toThrow();
    await host.terminate();
  });

  it('round-trips a capability call: the worker plugin invokes ctx.messages.sendText and gets the result', async () => {
    const dispatcher = jest.fn().mockResolvedValue({ messageId: 'wamid' });
    const host = makeHost(dispatcher);

    await host.load(CAP_FIXTURE);
    // onEnable awaits ctx.messages.sendText and throws unless it gets { messageId: 'wamid' } back,
    // so this resolving proves the full worker -> host -> worker round-trip.
    await host.runLifecycle('onEnable');

    expect(dispatcher).toHaveBeenCalledWith('messages.sendText', ['s', 'c', 'hi']);
    await host.terminate();
  });

  it('round-trips a hook: the worker registers a handler, the host dispatches and gets continue/data', async () => {
    const subscribed: string[] = [];
    const host = new PluginWorkerHost(makeChannel(), undefined, event => subscribed.push(event));

    await host.load(HOOK_FIXTURE);
    await host.runLifecycle('onEnable'); // the plugin registers its hook here
    await flushAsync(); // let the hook-subscribe message land
    expect(subscribed).toContain('message:received');

    const result = await host.dispatchHook({
      event: 'message:received',
      data: { body: 'hi' },
      source: 'Engine',
      timeoutMs: 5000,
    });
    expect(result).toEqual({ continue: false, data: { body: 'hi', seen: true } });
    await host.terminate();
  });

  it('a wedged worker hook handler times out so the host chain proceeds', async () => {
    const host = new PluginWorkerHost(makeChannel(), undefined, () => undefined);

    await host.load(HOOK_HANG_FIXTURE);
    await host.runLifecycle('onEnable');
    await flushAsync();

    const onTimeout = jest.fn();
    const result = await host.dispatchHook({
      event: 'message:received',
      data: {},
      source: 'Engine',
      timeoutMs: 200,
      onTimeout,
    });
    expect(result).toEqual({ continue: true });
    expect(onTimeout).toHaveBeenCalled();
    await host.terminate();
  });

  it('force-terminates a runaway (infinite-loop) plugin', async () => {
    const host = makeHost();
    await host.load(RUNAWAY_FIXTURE);

    // onEnable spins forever and blocks the worker event loop — it can never reply, so cooperative
    // shutdown is impossible. terminate() must still reclaim the thread.
    const wedged = host.runLifecycle('onEnable');
    wedged.catch(() => undefined); // terminate() rejects this pending call; swallow it
    await new Promise(resolve => setTimeout(resolve, 150));

    await expect(host.terminate()).resolves.toBeUndefined();
  });

  it('preserves a structured-clone-safe hook payload across the worker boundary', async () => {
    const host = new PluginWorkerHost(makeChannel(), undefined, () => undefined);
    await host.load(HOOK_FIXTURE); // its handler returns { ...data, seen: true }
    await host.runLifecycle('onEnable');
    await flushAsync();

    const payload = {
      body: 'hi',
      mentions: ['a@c.us', 'b@c.us'],
      meta: { ts: new Date('2026-06-22T00:00:00.000Z'), nested: { n: 1 } },
    };
    const result = await host.dispatchHook({
      event: 'message:received',
      data: payload,
      source: 'Engine',
      timeoutMs: 5000,
    });
    const data = result.data as typeof payload & { seen: boolean };

    expect(data.mentions).toEqual(['a@c.us', 'b@c.us']);
    expect(data.meta.nested).toEqual({ n: 1 });
    expect(data.meta.ts.getTime()).toBe(new Date('2026-06-22T00:00:00.000Z').getTime());
    expect(data.seen).toBe(true);
    await host.terminate();
  });

  it('exposes the host-resolved per-session config slice as ctx.config during a hook', async () => {
    const host = new PluginWorkerHost(makeChannel(), undefined, () => undefined);
    await host.load(HOOK_CONFIG_FIXTURE, { pluginId: 'hc', config: { greeting: 'base', lang: 'en' } });
    await host.runLifecycle('onEnable');
    await flushAsync();

    // A dispatch carrying the resolved slice → the handler sees exactly that as ctx.config.
    const overridden = await host.dispatchHook({
      event: 'message:received',
      data: {},
      source: 'Engine',
      timeoutMs: 5000,
      config: { greeting: 'hello-A', lang: 'en', extra: 1 },
    });
    expect((overridden.data as { config: unknown }).config).toEqual({ greeting: 'hello-A', lang: 'en', extra: 1 });

    // No resolved slice → ctx.config falls back to the base config.
    const base = await host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 5000 });
    expect((base.data as { config: unknown }).config).toEqual({ greeting: 'base', lang: 'en' });
    await host.terminate();
  });

  it('keeps ctx.config correct when hooks for different sessions interleave across an await', async () => {
    const host = new PluginWorkerHost(makeChannel(), undefined, () => undefined);
    await host.load(HOOK_CONFIG_FIXTURE, { pluginId: 'hc', config: { who: 'base' } });
    await host.runLifecycle('onEnable');
    await flushAsync();

    // Dispatch A (slow: reads ctx.config AFTER an await) and B (fast) concurrently. Without an
    // AsyncLocalStorage scope, B's config would clobber a shared ctx.config and A would read B's.
    const [a, b] = await Promise.all([
      host.dispatchHook({
        event: 'message:received',
        data: { delay: 80 },
        source: 'Engine',
        timeoutMs: 5000,
        config: { who: 'session-A' },
      }),
      host.dispatchHook({
        event: 'message:received',
        data: { delay: 0 },
        source: 'Engine',
        timeoutMs: 5000,
        config: { who: 'session-B' },
      }),
    ]);
    expect((a.data as { config: { who: string } }).config.who).toBe('session-A');
    expect((b.data as { config: { who: string } }).config.who).toBe('session-B');
    await host.terminate();
  });

  it('bridges ctx.logger and ctx.config into a sandboxed plugin', async () => {
    const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
    const host = new PluginWorkerHost(makeChannel(), undefined, undefined, undefined, (level, message, meta) =>
      logs.push({ level, message, meta }),
    );

    await host.load(CTX_FIXTURE, { pluginId: 'ctx-demo', config: { greeting: 'hi' } });
    await host.runLifecycle('onEnable');
    await flushAsync();

    // The plugin read ctx.pluginId + ctx.config and logged via ctx.logger; all of it crossed the bridge.
    expect(logs).toContainEqual({ level: 'log', message: 'hello from ctx-demo', meta: { greeting: 'hi' } });
    await host.terminate();
  });

  it('delivers healthCheck and onConfigChange to a sandboxed plugin (and refreshes ctx.config)', async () => {
    const host = new PluginWorkerHost(makeChannel());
    await host.load(CTX_LIFECYCLE_FIXTURE, { pluginId: 'ctx-lc', config: { a: 1 } });
    await host.runLifecycle('onEnable');

    // healthCheck reaches the worker plugin and returns ITS result (here it reports its current config).
    await expect(host.healthCheck(3000)).resolves.toEqual({ healthy: true, message: JSON.stringify({ a: 1 }) });

    // A config change refreshes ctx.config in the worker (and would invoke onConfigChange).
    host.sendConfigChange({ a: 2 });
    await flushAsync();
    await expect(host.healthCheck(3000)).resolves.toEqual({ healthy: true, message: JSON.stringify({ a: 2 }) });

    await host.terminate();
  });
});
