import * as path from 'path';
import { WorkerThreadChannel } from './worker-thread-channel';
import { PluginWorkerHost } from './plugin-worker-host';
import { SANDBOX_LOG_MAX_PER_WINDOW, SANDBOX_MAX_HELD_CAPS, SANDBOX_MAX_PENDING_CAPS } from './protocol';
import { SANDBOX_LOG_MAX_LINES_PER_WINDOW } from './worker-log-limiter';

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

/** Polls until `condition` holds. It fails at the deadline, and counts neither loop turns nor a fixed sleep. */
const waitFor = async (condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

/**
 * A plugin whose loop never yields can post faster than the host's one thread can read: a MessagePort has no
 * back-pressure, so the backlog grows in native memory while every session and request waits behind it. The bound is
 * on what the worker posts, so what the host is handed is what these specs count. Nothing here reads the clock: the
 * loops run a fixed number of iterations inside onEnable, and the lifecycle result that follows the last iteration
 * arrives after every message the loop posted, and before the worker reads a single reply.
 */
describe('a worker whose plugin loops without yielding', () => {
  jest.setTimeout(60000);

  const run = async (
    fixture: string,
    config: Record<string, unknown>,
    options: {
      capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>;
      onLog?: (level: string, message: string, meta?: Record<string, unknown>) => void;
      /** Runs once onEnable has returned, before the worker is ended. */
      afterEnable?: () => void | Promise<void>;
    },
  ): Promise<void> => {
    const host = new PluginWorkerHost(makeChannel(), options.capDispatcher, undefined, undefined, options.onLog);
    try {
      await host.load(fixture, { pluginId: 'flood', config });
      await host.runLifecycle('onEnable');
      await options.afterEnable?.();
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

      expect(attempts.length).toBeGreaterThanOrEqual(SANDBOX_LOG_MAX_LINES_PER_WINDOW);
      expect(lines.length).toBeLessThan(1000);
      expect(attempts.slice(0, SANDBOX_LOG_MAX_LINES_PER_WINDOW)).toEqual(
        Array.from({ length: SANDBOX_LOG_MAX_LINES_PER_WINDOW }, (_, i) => i),
      );
    });

    it('says that lines are being dropped, so the loss is not silent', async () => {
      const lines: string[] = [];
      await run(LOG_FLOOD_FIXTURE, { lines: 50_000 }, { onLog: (_level, message) => lines.push(message) });

      const noteAt = lines.findIndex(message => /log rate limit reached/i.test(message));
      expect(noteAt).toBeGreaterThanOrEqual(0);
      // The host's relay counts the note as a message of its window, so the note has to come within the bound.
      expect(noteAt + 1).toBeLessThanOrEqual(SANDBOX_LOG_MAX_PER_WINDOW);
    });

    it('relays every line of a plugin that stays within the bound', async () => {
      const lines: string[] = [];
      await run(
        LOG_FLOOD_FIXTURE,
        { lines: SANDBOX_LOG_MAX_LINES_PER_WINDOW },
        { onLog: (_level, message) => lines.push(message) },
      );

      expect(lines).toEqual(Array.from({ length: SANDBOX_LOG_MAX_LINES_PER_WINDOW }, () => 'retrying'));
    });
  });

  describe('calling a capability without awaiting', () => {
    const CALLS = 20_000;

    it('hands the host no more capability calls than the worker leaves unanswered while the loop runs', async () => {
      let dispatched = 0;
      let whileLooping = -1;
      // No host in-flight bound: only the worker's own bound is in play.
      await run(
        CAP_FLOOD_FIXTURE,
        { calls: CALLS },
        {
          capDispatcher: () => {
            dispatched++;
            return Promise.resolve(null);
          },
          // The loop yields only when it ends, so the worker reads no reply before its lifecycle result: what the
          // host has been handed by now is what the loop posted.
          afterEnable: () => {
            whileLooping = dispatched;
          },
        },
      );

      expect(whileLooping).toBe(SANDBOX_MAX_PENDING_CAPS);
    });

    it('holds the rest back until replies free slots, and refuses only the calls past the held bound', async () => {
      let dispatched = 0;
      const accepted = SANDBOX_MAX_PENDING_CAPS + SANDBOX_MAX_HELD_CAPS;
      await run(
        CAP_FLOOD_FIXTURE,
        { calls: CALLS },
        {
          capDispatcher: () => {
            dispatched++;
            return Promise.resolve(null);
          },
          afterEnable: () => waitFor(() => dispatched >= accepted, `${accepted} capability calls at the host`),
        },
      );

      // The loop made more calls than that, so the rest were refused in the worker and never reached the host.
      expect(CALLS).toBeGreaterThan(accepted);
      expect(dispatched).toBe(accepted);
    });
  });
});
