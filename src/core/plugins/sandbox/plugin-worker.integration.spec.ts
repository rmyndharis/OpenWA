import * as path from 'path';
import { WorkerThreadChannel } from './worker-thread-channel';
import { PluginWorkerHost } from './plugin-worker-host';

// Repo root, from src/core/plugins/sandbox.
const ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP = path.resolve(__dirname, 'worker-bootstrap.ts');
const FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/echo-plugin.cjs');
const CAP_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/cap-echo-plugin.cjs');

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
});
