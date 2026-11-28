import { AsyncLocalStorage } from 'async_hooks';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource, type Repository } from 'typeorm';
import { WorkerThreadChannel } from './worker-thread-channel';
import { PluginWorkerHost } from './plugin-worker-host';
import { SANDBOX_MAX_PENDING_CAPS } from './protocol';
import { HookManager, type HookEvent } from '../../hooks';
import { EngineRegistry } from '../../../engine/engine-registry.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../../engine/interfaces/whatsapp-engine.interface';
import { Message } from '../../../modules/message/entities/message.entity';
import { MessageSendService } from '../../../modules/message/message-send.service';
import { SendPacingService } from '../../../modules/message/send-pacing.service';
import { MessageProjector } from '../../../modules/session/message-projector.service';
import type { Session } from '../../../modules/session/entities/session.entity';
import type { SessionService } from '../../../modules/session/session.service';
import type { TemplateService } from '../../../modules/template/template.service';
import type { EventsGateway } from '../../../modules/events/events.gateway';
import type { WebhookService } from '../../../modules/webhook/webhook.service';
import type { StatusStoreService } from '../../../modules/status-store/status-store.service';
import type { SessionLidResolver } from '../../../modules/session/session-lid-resolver.service';

// Repo root, from src/core/plugins/sandbox.
const ROOT = path.resolve(__dirname, '../../../..');
const BOOTSTRAP = path.resolve(__dirname, 'worker-bootstrap.ts');
const FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/echo-plugin.cjs');
const CAP_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/cap-echo-plugin.cjs');
const HOOK_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/hook-plugin.cjs');
const HOOK_HANG_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/hook-hang-plugin.cjs');
const BUSY_HOOK_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/busy-hook-plugin.cjs');
const RUNAWAY_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/runaway-plugin.cjs');
const CTX_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/ctx-aware-plugin.cjs');
const HOOK_CONFIG_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/hook-config-plugin.cjs');
const HOOK_ERROR_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/hook-error-plugin.cjs');
const CTX_LIFECYCLE_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/ctx-lifecycle-plugin.cjs');
const SEARCH_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/search-plugin.cjs');
const UNLOAD_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/unload-plugin.cjs');
const UNCLONEABLE_LOG_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/uncloneable-log-plugin.cjs');
const CONFIG_THROW_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/config-throw-plugin.cjs');
const IDLE_SPIN_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/idle-spin-plugin.cjs');
const SENT_ECHO_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/sent-echo-plugin.cjs');
const WEBHOOK_SLOW_CAP_FIXTURE = path.resolve(ROOT, 'test/fixtures/sandbox/webhook-slow-cap-plugin.cjs');
const flushAsync = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

// Run the TS bootstrap inside the worker via ts-node. The base tsconfig is nodenext; we pin the
// worker's transpile to CommonJS (same override the jest/ts-jest config uses) so `require()` works.
// Production loads the compiled `worker-bootstrap.js` directly and needs none of this.
const TS_NODE_OPTS = JSON.stringify({
  module: 'commonjs',
  moduleResolution: 'node',
  resolvePackageJsonExports: false,
  // Same bridge as the jest/ts-jest override: TypeScript 6 rejects the legacy resolution pair
  // outright unless the deprecation is acknowledged. Revisit before TypeScript 7.
  ignoreDeprecations: '6.0',
});

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

  it('dispatches onUnload to the plugin inside the worker (the hook the loader fires on uninstall)', async () => {
    const host = makeHost();
    await host.load(UNLOAD_FIXTURE);
    await host.runLifecycle('onEnable');
    await expect(host.healthCheck(3000)).resolves.toMatchObject({ message: 'loaded' });

    await host.runLifecycle('onUnload');

    // The worker-side instance observed its onUnload — before this hook was dispatched on the
    // unload path, a sandboxed plugin's cleanup (timers, connections) never ran.
    await expect(host.healthCheck(3000)).resolves.toMatchObject({ message: 'unloaded' });
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

    expect(dispatcher).toHaveBeenCalledWith('messages.sendText', ['s', 'c', 'hi'], undefined, expect.any(AbortSignal));
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
    expect(result).toEqual({ continue: true, error: 'hook timed out after 200ms' });
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
    // Poll until the loop is genuinely blocked rather than sleeping a fixed 150ms: the health-check
    // message is queued behind the onEnable call (FIFO on one channel), so it can only time out once
    // the infinite loop has actually started. Firing terminate() earlier would reclaim an idle worker
    // and prove nothing.
    const wedgeDeadline = Date.now() + 10_000;
    for (;;) {
      const health = await host.healthCheck(150);
      if (!health.healthy) break;
      if (Date.now() > wedgeDeadline) throw new Error('runaway plugin never blocked the worker event loop');
    }

    await expect(host.terminate()).resolves.toBeUndefined();
  });

  const probingHost = (onUnresponsive: () => void): PluginWorkerHost =>
    new PluginWorkerHost(
      makeChannel(),
      undefined,
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      300,
      onUnresponsive,
    );

  it('a slow async hook handler answers the liveness probe, so it is not reported', async () => {
    const onUnresponsive = jest.fn();
    const host = probingHost(onUnresponsive);
    try {
      await host.load(HOOK_HANG_FIXTURE);
      await host.runLifecycle('onEnable');
      await flushAsync();

      await host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 200 });
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(onUnresponsive).not.toHaveBeenCalled();
    } finally {
      await host.terminate();
    }
  });

  it('a worker working through a burst of short synchronous handlers is not reported', async () => {
    const onUnresponsive = jest.fn();
    const host = probingHost(onUnresponsive);
    try {
      await host.load(BUSY_HOOK_FIXTURE);
      await host.runLifecycle('onEnable');
      await flushAsync();

      // ~1 s of queued work against a 300 ms hook budget and a 300 ms probe: most dispatches time out
      // and the ping waits behind the backlog, but results keep arriving the whole time.
      const burst = Array.from({ length: 100 }, () =>
        host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 300 }),
      );
      await Promise.all(burst);
      await expect(host.healthCheck(5000)).resolves.toMatchObject({ healthy: true });
      expect(onUnresponsive).not.toHaveBeenCalled();
    } finally {
      await host.terminate();
    }
  });

  it('reports a worker whose event loop is blocked, and terminate() reclaims it', async () => {
    let reported!: () => void;
    const unresponsive = new Promise<void>(resolve => (reported = resolve));
    const host = probingHost(() => reported());
    try {
      await host.load(RUNAWAY_FIXTURE);
      const wedged = host.runLifecycle('onEnable');
      wedged.catch(() => undefined); // terminate() rejects this pending call

      // The dispatch queues behind the spinning onEnable and times out; the ping behind it is never read.
      await host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 200 });
      await unresponsive;
    } finally {
      await expect(host.terminate()).resolves.toBeUndefined();
    }
  });

  it('a throwing worker hook handler is reported back on the hook-result (not silently swallowed)', async () => {
    const host = new PluginWorkerHost(makeChannel(), undefined, () => undefined);
    await host.load(HOOK_ERROR_FIXTURE);
    await host.runLifecycle('onEnable');
    await flushAsync();

    // The chain still fails open (continue:true) — but the worker's error crosses the wire so the
    // host can log it and record it for the plugin's health surface. `data` round-trips untouched.
    const result = await host.dispatchHook({
      event: 'message:received',
      data: {},
      source: 'Engine',
      timeoutMs: 5000,
    });
    expect(result).toEqual({ continue: true, data: {}, error: 'intentional hook failure' });
    await host.terminate();
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

  it('keeps the worker alive when a timer logs a meta the structured clone cannot copy', async () => {
    const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
    const host = new PluginWorkerHost(makeChannel(), undefined, undefined, undefined, (level, message, meta) =>
      logs.push({ level, message, meta }),
    );

    try {
      await host.load(UNCLONEABLE_LOG_FIXTURE, { pluginId: 'uncloneable-log', config: {} });
      await host.runLifecycle('onEnable');

      // A DataCloneError thrown from the timer used to be uncaught in the worker, so the worker exited.
      await expect(host.healthCheck(3000)).resolves.toEqual({ healthy: true, message: 'alive' });
      expect(logs).toContainEqual({ level: 'warn', message: 'timer log', meta: undefined });
      // The error reason is a string, so it still crosses when the rest of the meta cannot.
      expect(logs).toContainEqual({ level: 'error', message: 'timer error', meta: { error: 'upstream down' } });
    } finally {
      await host.terminate();
    }
  });

  it('keeps the worker alive when a synchronous onConfigChange throws, and logs why', async () => {
    const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
    const onExit = jest.fn();
    const host = new PluginWorkerHost(
      makeChannel(),
      undefined,
      undefined,
      undefined,
      (level, message, meta) => logs.push({ level, message, meta }),
      undefined,
      undefined,
      undefined,
      onExit,
    );
    try {
      await host.load(CONFIG_THROW_FIXTURE, { pluginId: 'config-throw', config: { mode: 'ok' } });
      await host.runLifecycle('onEnable');

      host.sendConfigChange({ mode: 'bad' });

      await expect(host.healthCheck(3000)).resolves.toEqual({ healthy: true, message: 'alive' });
      expect(logs).toContainEqual({
        level: 'error',
        message: 'onConfigChange threw',
        meta: { error: 'unsupported mode: bad' },
      });
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      await host.terminate();
    }
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

  it('round-trips a search: the worker registers a provider and the host dispatches a query', async () => {
    let registered = false;
    const host = new PluginWorkerHost(
      makeChannel(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        registered = true;
      },
    );

    await host.load(SEARCH_FIXTURE, { pluginId: 'search-fixture', config: {} });
    await host.runLifecycle('onEnable'); // the plugin calls ctx.registerSearchProvider here
    await flushAsync(); // let search-provider-register land
    expect(registered).toBe(true);

    const reply = await host.dispatchSearch({ query: { q: 'hello' }, timeoutMs: 5000 });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.results.provider).toBe('plugin:search-fixture');
      expect(reply.results.hits).toHaveLength(1);
      expect(reply.results.hits[0].body).toBe('match for hello');
      expect(reply.results.hits[0].snippet).toBe('<mark>hello</mark>');
    }

    // Empty query → empty hits (structured-clone-safe SearchResults round-trip).
    const empty = await host.dispatchSearch({ query: { q: '' }, timeoutMs: 5000 });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.results.hits).toEqual([]);

    await host.terminate();
  });

  it('keeps serving capability calls after webhook handlers awaiting one ran past the dispatch budget', async () => {
    // net.fetch is an upstream that never answers but honours its AbortSignal; storage.get answers at once.
    const host = new PluginWorkerHost(makeChannel(), (verb, _args, _ctx, signal) =>
      verb === 'storage.get'
        ? Promise.resolve('stored')
        : new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    const deliver = (route: string, deliveryId: string, timeoutMs: number) =>
      host.dispatchWebhook({
        instanceId: 'inst-1',
        route,
        method: 'POST',
        headers: {},
        query: {},
        body: '{}',
        rawBody: '{}',
        verified: true,
        deliveryId,
        sessionId: 's1',
        timeoutMs,
      });
    try {
      await host.load(WEBHOOK_SLOW_CAP_FIXTURE);
      await host.runLifecycle('onEnable');

      // Twice as many overrunning deliveries as the worker leaves unanswered at once, a few at a time.
      const perRound = 16;
      for (let round = 0; round < (SANDBOX_MAX_PENDING_CAPS * 2) / perRound; round++) {
        const overrun = await Promise.all(
          Array.from({ length: perRound }, (_unused, i) => deliver('slow', `slow-${round}-${i}`, 100)),
        );
        // Each fails as the dispatch timeout, whichever of its two timers ran first.
        expect(overrun.filter(result => result.ok || result.status !== 504)).toEqual([]);
      }

      // Each overrun call was answered, so the worker still has room to post this one.
      await expect(deliver('fast', 'fast-1', 5000)).resolves.toMatchObject({ ok: true, status: 200, body: 'stored' });
    } finally {
      await host.terminate();
    }
  });

  it('detects an idle worker spinning in while(true) with zero hooks dispatched via periodic livenessIntervalMs', async () => {
    let reported!: () => void;
    const unresponsive = new Promise<void>(resolve => (reported = resolve));
    const host = new PluginWorkerHost(
      makeChannel(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      300,
      () => reported(),
      150,
    );
    try {
      await host.load(IDLE_SPIN_FIXTURE);
      await host.runLifecycle('onEnable');
      // Dispatch zero hooks: the worker enters while(true) on its own timer and must be caught by
      // the periodic idle liveness probe.
      await unresponsive;
    } finally {
      await expect(host.terminate()).resolves.toBeUndefined();
    }
  });

  it('suppresses message:sent echo loops for a sandboxed worker plugin calling ctx.messages.sendText', async () => {
    const db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    let host: PluginWorkerHost | undefined;
    try {
      const repo = db.getRepository(Message);
      const hm = new HookManager();
      const engines = new EngineRegistry();
      const emitMessageSent = jest.fn();
      const webhookDispatch = jest.fn().mockResolvedValue(undefined);
      let nextSeq = 2;

      const sendTextMessage = jest.fn((chatId: string, text: string) => {
        const id = `SANDBOX-MSG-${nextSeq++}`;
        const timestamp = Math.floor(Date.now() / 1000);
        setImmediate(() => {
          const echo: IncomingMessage = {
            id,
            chatId,
            from: '620000@c.us',
            to: chatId,
            fromMe: true,
            body: text,
            type: 'text',
            timestamp,
            isGroup: false,
            kind: 'individual',
          };
          projector.handleOwnSendEcho('s1', engine, echo);
        });
        return Promise.resolve({ id, timestamp });
      });
      const engine = {
        sendTextMessage,
        sendChatState: jest.fn().mockResolvedValue(undefined),
      } as unknown as IWhatsAppEngine;
      engines.set('s1', engine);

      const sessionRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>;
      const projector = new MessageProjector(
        repo,
        sessionRepo,
        engines,
        { emitMessage: jest.fn(), emitMessageSent } as unknown as EventsGateway,
        { dispatch: webhookDispatch } as unknown as WebhookService,
        hm,
        {} as StatusStoreService,
        { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      );

      const config = new ConfigService({ features: { simulateTyping: false } });
      const sender = new MessageSendService(
        repo,
        { findOne: jest.fn().mockResolvedValue({ id: 's1', phone: '620000' }) } as unknown as SessionService,
        engines,
        hm,
        {} as TemplateService,
        new SendPacingService(repo, sessionRepo),
        config,
      );

      const dispatchedToWorker: string[] = [];
      host = new PluginWorkerHost(
        makeChannel(),
        async (verb, args) => {
          if (verb === 'messages.sendText') {
            return sender.sendText(args[0] as string, {
              chatId: args[1] as string,
              text: args[2] as string,
            });
          }
          throw new Error(`unexpected verb: ${verb}`);
        },
        event => {
          hm.register('sent-echo', event as HookEvent, async hookCtx => {
            dispatchedToWorker.push((hookCtx.data as IncomingMessage).id);
            const result = await host!.dispatchHook({
              event,
              data: hookCtx.data,
              sessionId: hookCtx.sessionId,
              source: hookCtx.source,
              inFlight: hm.currentInFlight(),
              timeoutMs: 5000,
            });
            return { continue: result.continue, data: result.data };
          });
        },
        undefined,
        undefined,
        (events, run) => hm.runInFlight(events as HookEvent[], run),
      );

      await host.load(SENT_ECHO_FIXTURE);
      await host.runLifecycle('onEnable');
      await flushAsync();

      projector.handleOwnSendEcho('s1', engine, {
        id: 'SANDBOX-MSG-1',
        chatId: '628111@c.us',
        from: '620000@c.us',
        to: '628111@c.us',
        fromMe: true,
        body: 'initial',
        type: 'text',
        timestamp: 1_700_000_000,
        isGroup: false,
        kind: 'individual',
      });

      // Wait for async worker IPC + echo cycle to settle.
      const deadline = Date.now() + 5000;
      while (emitMessageSent.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(dispatchedToWorker).toEqual(['SANDBOX-MSG-1']);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(emitMessageSent).toHaveBeenCalledTimes(2);
      expect(webhookDispatch).toHaveBeenCalledTimes(2);
      const rows = await repo.find({ order: { waMessageId: 'ASC' } });
      expect(rows.map(r => r.waMessageId)).toEqual(['SANDBOX-MSG-1', 'SANDBOX-MSG-2']);
    } finally {
      await host?.terminate();
      await db.destroy();
    }
  });

  it('suppresses early own-send echo arriving before engine.sendTextMessage resolves for a sandboxed worker', async () => {
    const runAtRoot = AsyncLocalStorage.snapshot();
    const db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    let host: PluginWorkerHost | undefined;
    try {
      const repo = db.getRepository(Message);
      const hm = new HookManager();
      const engines = new EngineRegistry();
      const emitMessageSent = jest.fn();
      const webhookDispatch = jest.fn().mockResolvedValue(undefined);
      let nextSeq = 2;

      const sendTextMessage = jest.fn((chatId: string, text: string) => {
        const id = `SANDBOX-EARLY-${nextSeq++}`;
        const timestamp = Math.floor(Date.now() / 1000);
        // Simulate whatsapp-web.js emitting message_create at 5ms in a root ALS context
        // before sendTextMessage resolves { id, timestamp } at 40ms.
        runAtRoot(() => {
          setTimeout(() => {
            projector.handleOwnSendEcho('s1', engine, {
              id,
              chatId,
              from: '620000@c.us',
              to: chatId,
              fromMe: true,
              body: text,
              type: 'text',
              timestamp,
              isGroup: false,
              kind: 'individual',
            });
          }, 5);
        });
        return new Promise<{ id: string; timestamp: number }>(resolve => {
          setTimeout(() => resolve({ id, timestamp }), 40);
        });
      });
      const engine = {
        sendTextMessage,
        sendChatState: jest.fn().mockResolvedValue(undefined),
      } as unknown as IWhatsAppEngine;
      engines.set('s1', engine);

      const sessionRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>;
      const projector = new MessageProjector(
        repo,
        sessionRepo,
        engines,
        { emitMessage: jest.fn(), emitMessageSent } as unknown as EventsGateway,
        { dispatch: webhookDispatch } as unknown as WebhookService,
        hm,
        {} as StatusStoreService,
        { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      );

      const config = new ConfigService({ features: { simulateTyping: false } });
      const sender = new MessageSendService(
        repo,
        { findOne: jest.fn().mockResolvedValue({ id: 's1', phone: '620000' }) } as unknown as SessionService,
        engines,
        hm,
        {} as TemplateService,
        new SendPacingService(repo, sessionRepo),
        config,
      );

      const dispatchedToWorker: string[] = [];
      host = new PluginWorkerHost(
        makeChannel(),
        async (verb, args) => {
          if (verb === 'messages.sendText') {
            return sender.sendText(args[0] as string, {
              chatId: args[1] as string,
              text: args[2] as string,
            });
          }
          throw new Error(`unexpected verb: ${verb}`);
        },
        event => {
          hm.register('sent-echo', event as HookEvent, async hookCtx => {
            dispatchedToWorker.push((hookCtx.data as IncomingMessage).id);
            if (dispatchedToWorker.length > 3) {
              return { continue: true, data: hookCtx.data };
            }
            const result = await host!.dispatchHook({
              event,
              data: hookCtx.data,
              sessionId: hookCtx.sessionId,
              source: hookCtx.source,
              inFlight: hm.currentInFlight(),
              timeoutMs: 5000,
            });
            return { continue: result.continue, data: result.data };
          });
        },
        undefined,
        undefined,
        (events, run) => hm.runInFlight(events as HookEvent[], run),
      );

      await host.load(SENT_ECHO_FIXTURE);
      await host.runLifecycle('onEnable');
      await flushAsync();

      projector.handleOwnSendEcho('s1', engine, {
        id: 'SANDBOX-EARLY-1',
        chatId: '628111@c.us',
        from: '620000@c.us',
        to: '628111@c.us',
        fromMe: true,
        body: 'initial',
        type: 'text',
        timestamp: 1_700_000_000,
        isGroup: false,
        kind: 'individual',
      });

      const deadline = Date.now() + 5000;
      while (emitMessageSent.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(dispatchedToWorker).toEqual(['SANDBOX-EARLY-1']);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(emitMessageSent).toHaveBeenCalledTimes(2);
      expect(webhookDispatch).toHaveBeenCalledTimes(2);
      expect(hm.consumeEchoOrigin('s1', 'SANDBOX-EARLY-2')).toBe(false);
    } finally {
      await host?.terminate();
      await db.destroy();
    }
  });
});
