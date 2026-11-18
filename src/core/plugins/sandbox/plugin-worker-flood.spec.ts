import * as path from 'path';
import { WorkerThreadChannel } from './worker-thread-channel';
import { PluginWorkerHost } from './plugin-worker-host';
import { SANDBOX_LOG_MAX_PER_WINDOW, SANDBOX_MAX_PENDING_CAPS } from './protocol';

const ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP = path.resolve(__dirname, 'worker-bootstrap.ts');
const LOG_FLOOD_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/log-flood-plugin.cjs');
const CAP_FLOOD_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/cap-flood-plugin.cjs');

// The worker runs the TS bootstrap through ts-node, as in plugin-worker.integration.spec.ts.
const TS_NODE_OPTS = JSON.stringify({
  module: 'commonjs',
  moduleResolution: 'node',
  resolvePackageJsonExports: false,
  ignoreDeprecations: '6.0',
});

const makeChannel = (): WorkerThreadChannel =>
  new WorkerThreadChannel({
    workerEntry: BOOTSTRAP,
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TS_NODE_OPTS },
    maxOldGenerationSizeMb: 256,
  });

/**
 * A plugin whose loop never yields can post faster than the host's one thread can read: a MessagePort has no
 * back-pressure, so the backlog grows in native memory while every session and request waits behind it. The bound is
 * on what the worker posts, so what the host is handed is what these specs count. Nothing here reads the clock: the
 * loops run a fixed number of iterations inside onEnable, and the lifecycle result that follows the last iteration
 * arrives after every message the loop posted.
 */
describe('a worker whose plugin loops without yielding', () => {
  jest.setTimeout(60000);

  const run = async (
    fixture: string,
    config: Record<string, unknown>,
    options: {
      capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>;
      onLog?: (level: string, message: string, meta?: Record<string, unknown>) => void;
    },
  ): Promise<void> => {
    const host = new PluginWorkerHost(makeChannel(), options.capDispatcher, undefined, undefined, options.onLog);
    try {
      await host.load(fixture, { pluginId: 'flood', config });
      await host.runLifecycle('onEnable');
    } finally {
      await host.terminate();
    }
  };

  describe('logging', () => {
    it('hands the host a bounded number of log messages, the first ones in order', async () => {
      const lines: string[] = [];
      const attempts: number[] = [];
      await run(
        LOG_FLOOD_FIXTURE,
        { lines: 50_000 },
        {
          onLog: (_level, message, meta) => {
            lines.push(message);
            if (message === 'retrying') attempts.push(meta?.attempt as number);
          },
        },
      );

      expect(attempts.length).toBeGreaterThanOrEqual(SANDBOX_LOG_MAX_PER_WINDOW);
      expect(lines.length).toBeLessThan(1000);
      expect(attempts.slice(0, SANDBOX_LOG_MAX_PER_WINDOW)).toEqual(
        Array.from({ length: SANDBOX_LOG_MAX_PER_WINDOW }, (_, i) => i),
      );
    });

    it('says that lines are being dropped, so the loss is not silent', async () => {
      const lines: string[] = [];
      await run(LOG_FLOOD_FIXTURE, { lines: 50_000 }, { onLog: (_level, message) => lines.push(message) });

      expect(lines.filter(message => /log rate limit reached/i.test(message)).length).toBeGreaterThanOrEqual(1);
    });

    it('relays every line of a plugin that stays within the bound', async () => {
      const lines: string[] = [];
      await run(
        LOG_FLOOD_FIXTURE,
        { lines: SANDBOX_LOG_MAX_PER_WINDOW },
        { onLog: (_level, message) => lines.push(message) },
      );

      expect(lines).toEqual(Array.from({ length: SANDBOX_LOG_MAX_PER_WINDOW }, () => 'retrying'));
    });
  });

  describe('calling a capability without awaiting', () => {
    it('hands the host no more capability calls than the worker leaves unanswered', async () => {
      let dispatched = 0;
      // No host in-flight bound: only the worker's own bound is in play.
      await run(
        CAP_FLOOD_FIXTURE,
        { calls: 20_000 },
        {
          capDispatcher: () => {
            dispatched++;
            return Promise.resolve(null);
          },
        },
      );

      expect(dispatched).toBe(SANDBOX_MAX_PENDING_CAPS);
    });
  });
});
