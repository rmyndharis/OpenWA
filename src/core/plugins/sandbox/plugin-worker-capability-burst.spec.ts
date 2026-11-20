import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { HookManager } from '../../hooks/hook-manager.service';
import type { HookEvent } from '../../hooks/hook.interfaces';
import { PluginStorageService } from '../plugin-storage.service';
import { dispatchCapabilityVerb, CapabilityContext } from './capability-router';
import { PluginWorkerHost } from './plugin-worker-host';
import { SANDBOX_MAX_INFLIGHT_CAPS, SANDBOX_MAX_PENDING_CAPS } from './protocol';
import { WorkerThreadChannel } from './worker-thread-channel';

const ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP = path.resolve(__dirname, 'worker-bootstrap.ts');
const fixture = (name: string): string => path.resolve(ROOT, 'test/fixtures/sandbox', name);

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
 * A plugin may issue any number of capability calls at once: a Promise.all over a list of keys, or a loop of writes
 * nobody awaits. The worker bounds what it posts to the host, but a call past the bound waits for a reply instead of
 * being refused, so the host answers every call it would have run. Each case runs a real worker thread against the
 * real storage service behind the real capability router, with the host's own bound of 32 calls in flight.
 */
describe('a sandboxed plugin that issues many capability calls at once', () => {
  jest.setTimeout(60_000);

  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-capability-burst-'));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const storageService = (): PluginStorageService =>
    new PluginStorageService({
      get: (key: string) => (key === 'dataDir' ? dataDir : undefined),
    } as unknown as ConfigService);
  const storedKeys = (): number => {
    const dir = path.join(dataDir, 'plugins', 'burst');
    return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  };

  const start = (
    capDispatcher: (verb: string, args: unknown[]) => Promise<unknown>,
    runWithHookGuard?: (events: string[], run: () => Promise<unknown>) => Promise<unknown>,
  ): {
    host: PluginWorkerHost;
    settled: Array<Record<string, unknown> | undefined>;
    exits: Array<{ code: number; intentional: boolean; reason?: string }>;
  } => {
    const settled: Array<Record<string, unknown> | undefined> = [];
    const exits: Array<{ code: number; intentional: boolean; reason?: string }> = [];
    const host = new PluginWorkerHost(
      makeChannel(),
      capDispatcher,
      undefined,
      undefined,
      (_level, message, meta) => {
        if (message === 'settled') settled.push(meta);
      },
      runWithHookGuard,
      SANDBOX_MAX_INFLIGHT_CAPS,
      undefined,
      (code, intentional, reason) => exits.push({ code, intentional, reason }),
      30_000,
    );
    return { host, settled, exits };
  };

  const storageDispatcher = (): ((verb: string, args: unknown[]) => Promise<unknown>) => {
    const context = { storage: storageService().createPluginStorage('burst') } as unknown as CapabilityContext;
    return (verb, args) => dispatchCapabilityVerb(context, verb, args);
  };

  it.each([32, 64, 65, 200])(
    'answers each of %i storage reads awaited together with the value of its own key',
    async calls => {
      const storage = storageService().createPluginStorage('burst');
      for (let i = 0; i < calls; i++) await storage.set(`k${i}`, { n: i });
      const { host, settled } = start(storageDispatcher());
      try {
        await host.load(fixture('storage-burst-plugin.cjs'), { pluginId: 'burst', config: { calls } });
        await host.runLifecycle('onEnable');
      } finally {
        await host.terminate();
      }

      expect(settled).toEqual([{ ok: calls, failed: 0, wrong: 0, firstError: null }]);
    },
  );

  it('stores every key of 200 writes awaited together', async () => {
    const { host, settled } = start(storageDispatcher());
    try {
      await host.load(fixture('storage-burst-plugin.cjs'), { pluginId: 'burst', config: { calls: 200, write: true } });
      await host.runLifecycle('onEnable');
    } finally {
      await host.terminate();
    }

    expect(settled).toEqual([{ ok: 200, failed: 0, wrong: 0, firstError: null }]);
    expect(storedKeys()).toBe(200);
  });

  it.each([64, 200])('writes every key of %i writes nobody awaits, and the worker keeps running', async calls => {
    const { host, exits } = start(storageDispatcher());
    try {
      await host.load(fixture('storage-unawaited-set-plugin.cjs'), { pluginId: 'burst', config: { calls } });
      await host.runLifecycle('onEnable');
      // The writes outlive onEnable: wait for the last one, or for the worker to die of a rejected one.
      await waitFor(() => storedKeys() === calls || exits.length > 0, `${calls} keys on disk`);

      expect(exits).toEqual([]);
      expect(storedKeys()).toBe(calls);
      await expect(host.healthCheck(10_000)).resolves.toMatchObject({ healthy: true });
    } finally {
      await host.terminate();
    }
  });

  it('writes every key of 200 writes nobody awaits when the plugin swallows each rejection, with none rejected', async () => {
    const { host, settled, exits } = start(storageDispatcher());
    try {
      await host.load(fixture('storage-unawaited-set-plugin.cjs'), {
        pluginId: 'burst',
        config: { calls: 200, swallow: true },
      });
      await host.runLifecycle('onEnable');
      await waitFor(() => settled.length > 0 || exits.length > 0, 'the plugin to report its writes settled');

      expect(settled).toEqual([{ rejected: 0 }]);
      expect(exits).toEqual([]);
      expect(storedKeys()).toBe(200);
    } finally {
      await host.terminate();
    }
  });

  it('keeps every call of a hook handler that fans out past the bound inside the hook re-entrancy guard', async () => {
    const hooks = new HookManager();
    const SENDING = 'message:sending' as HookEvent;
    // A send re-fires message:sending on the host; the answer says whether the guard covers this call.
    const { host } = start(
      verb => Promise.resolve(verb === 'messages.sendText' ? hooks.isInFlight(SENDING) : null),
      (events, run) => hooks.runInFlight(events as HookEvent[], run),
    );
    try {
      await host.load(fixture('hook-fan-out-plugin.cjs'), { pluginId: 'fan-out', config: { calls: 150 } });
      await host.runLifecycle('onEnable');
      const result = await host.dispatchHook({ event: SENDING, data: {}, source: 'test', timeoutMs: 30_000 });

      expect(result.error).toBeUndefined();
      expect(result.data).toEqual({ guarded: Array.from({ length: 150 }, () => true) });
    } finally {
      await host.terminate();
    }
  });

  // The calls of a handler that returns without awaiting them are answered after its dispatch is over, when the host no
  // longer honours the hook chain they were made in. A send among them fires message:sending, which dispatches the
  // handler again, so the sends past the worker's bound are refused, as they were before calls were held.
  describe('a hook handler that issues calls without awaiting them and returns', () => {
    const SENDING = 'message:sending' as HookEvent;
    const run = async (verb: 'send' | 'storage', calls: number) => {
      const hooks = new HookManager();
      const storage = storageDispatcher();
      // A send re-fires message:sending on the host; the answer says whether the guard covers this call.
      const { host, settled, exits } = start(
        (name, args) =>
          name === 'messages.sendText' ? Promise.resolve(hooks.isInFlight(SENDING)) : storage(name, args),
        (events, work) => hooks.runInFlight(events as HookEvent[], work),
      );
      try {
        await host.load(fixture('hook-fan-out-unawaited-plugin.cjs'), { pluginId: 'burst', config: { calls, verb } });
        await host.runLifecycle('onEnable');
        const result = await host.dispatchHook({ event: SENDING, data: {}, source: 'test', timeoutMs: 30_000 });
        await waitFor(() => settled.length > 0 || exits.length > 0, 'every call of the handler to settle');
        // The exits before the termination below, which is one more.
        return { result, settled: [...settled], exits: [...exits] };
      } finally {
        await host.terminate();
      }
    };

    it('answers the calls made inside the dispatch with the guard and refuses the sends held past its end', async () => {
      const { result, settled, exits } = await run('send', 150);

      expect(result.error).toBeUndefined();
      expect(exits).toEqual([]);
      expect(settled).toEqual([
        {
          guarded: SANDBOX_MAX_PENDING_CAPS,
          unguarded: 0,
          refused: 150 - SANDBOX_MAX_PENDING_CAPS,
          refusal: expect.stringContaining(
            'before the hook handler that made this messages.sendText call returned',
          ) as string,
        },
      ]);
    });

    it('still writes every key it holds, since a write fires no hook', async () => {
      const { result, settled, exits } = await run('storage', 150);

      expect(result.error).toBeUndefined();
      expect(exits).toEqual([]);
      expect(settled).toEqual([{ guarded: 0, unguarded: 0, refused: 0, refusal: null }]);
      expect(storedKeys()).toBe(150);
    });
  });
});
