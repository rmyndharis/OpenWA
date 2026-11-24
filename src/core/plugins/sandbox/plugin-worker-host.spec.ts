import { MessageChannel } from 'worker_threads';
import { PluginWorkerHost } from './plugin-worker-host';
import { PluginWorkerChannel, HostToWorkerMessage, WorkerToHostMessage, SANDBOX_MAX_PENDING_CAPS } from './protocol';
import { WorkerCapabilityClient } from './worker-capability';
import { WorkerHookRegistry } from './worker-hooks';
import { WebhookRegistry } from './worker-webhooks';
import { HookManager } from '../../hooks/hook-manager.service';
import { HookEvent } from '../../hooks/hook.interfaces';
import { leastCpuMsAsync } from '../../../../test/helpers/cpu-time';

/** In-memory channel double: records what the host posts, lets the test push worker replies back. */
class FakeChannel implements PluginWorkerChannel {
  sent: HostToWorkerMessage[] = [];
  terminated = false;
  private onMsg?: (m: WorkerToHostMessage) => void;
  private onExitCb?: (code: number) => void;

  postMessage(message: HostToWorkerMessage): void {
    this.sent.push(message);
  }
  onMessage(handler: (message: WorkerToHostMessage) => void): void {
    this.onMsg = handler;
  }
  onExit(handler: (code: number) => void): void {
    this.onExitCb = handler;
  }
  terminate(): Promise<void> {
    this.terminated = true;
    return Promise.resolve();
  }

  // test triggers
  reply(message: WorkerToHostMessage): void {
    this.onMsg?.(message);
  }
  crash(code = 1): void {
    this.onExitCb?.(code);
  }
  last(): HostToWorkerMessage {
    return this.sent[this.sent.length - 1];
  }
}

const lastLifecycle = (ch: FakeChannel) => ch.last() as Extract<HostToWorkerMessage, { kind: 'lifecycle' }>;

describe('PluginWorkerHost', () => {
  it('drops a malformed worker message instead of throwing out of the channel listener', async () => {
    // Plugin code can post to parentPort directly; a throw here would be an uncaught exception in the host.
    const ch = new FakeChannel();
    const onLog = jest.fn(() => {
      throw new TypeError('logger[level] is not a function');
    });
    const host = new PluginWorkerHost(ch, undefined, undefined, undefined, onLog);
    const p = host.load('/p/index.js');

    expect(() => ch.reply(null as unknown as WorkerToHostMessage)).not.toThrow();
    expect(() => ch.reply({ kind: 'log', level: 'log', message: 'x' })).not.toThrow();
    expect(onLog).toHaveBeenCalledTimes(1);

    // The host keeps serving the worker afterwards.
    ch.reply({ kind: 'ready' });
    await expect(p).resolves.toBeUndefined();
  });

  it('posts a load message and resolves load() when the worker reports ready', async () => {
    const ch = new FakeChannel();
    const host = new PluginWorkerHost(ch);

    const p = host.load('/plugins/demo/index.js');
    expect(ch.last()).toEqual({ kind: 'load', mainPath: '/plugins/demo/index.js' });

    ch.reply({ kind: 'ready' });
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects load() when the worker errors before becoming ready', async () => {
    const ch = new FakeChannel();
    const host = new PluginWorkerHost(ch);

    const p = host.load('/plugins/broken/index.js');
    ch.reply({ kind: 'error', error: 'Cannot find module' });

    await expect(p).rejects.toThrow('Cannot find module');
  });

  it('runLifecycle() sends a correlated id and resolves on a matching ok result', async () => {
    const ch = new FakeChannel();
    const host = new PluginWorkerHost(ch);
    void host.load('/p/index.js');
    ch.reply({ kind: 'ready' });

    const p = host.runLifecycle('onEnable');
    const msg = lastLifecycle(ch);
    expect(msg.kind).toBe('lifecycle');
    expect(msg.method).toBe('onEnable');

    ch.reply({ kind: 'lifecycle-result', id: msg.id, ok: true });
    await expect(p).resolves.toBeUndefined();
  });

  it('runLifecycle() rejects on an error result, surfacing the worker error message', async () => {
    const ch = new FakeChannel();
    const host = new PluginWorkerHost(ch);
    void host.load('/p/index.js');
    ch.reply({ kind: 'ready' });

    const p = host.runLifecycle('onEnable');
    ch.reply({ kind: 'lifecycle-result', id: lastLifecycle(ch).id, ok: false, error: 'onEnable threw' });

    await expect(p).rejects.toThrow('onEnable threw');
  });

  it('correlates concurrent lifecycle calls by id (no cross-resolution)', async () => {
    const ch = new FakeChannel();
    const host = new PluginWorkerHost(ch);
    void host.load('/p/index.js');
    ch.reply({ kind: 'ready' });

    const enable = host.runLifecycle('onEnable');
    const enableId = lastLifecycle(ch).id;
    const disable = host.runLifecycle('onDisable');
    const disableId = lastLifecycle(ch).id;
    expect(disableId).not.toBe(enableId);

    // Resolve the second call first; the first must stay pending.
    ch.reply({ kind: 'lifecycle-result', id: disableId, ok: true });
    await expect(disable).resolves.toBeUndefined();
    ch.reply({ kind: 'lifecycle-result', id: enableId, ok: true });
    await expect(enable).resolves.toBeUndefined();
  });

  it('rejects all pending calls when the worker exits unexpectedly', async () => {
    const ch = new FakeChannel();
    const host = new PluginWorkerHost(ch);
    void host.load('/p/index.js');
    ch.reply({ kind: 'ready' });

    const p = host.runLifecycle('onEnable');
    ch.crash(1);

    await expect(p).rejects.toThrow(/exit/i);
  });

  // A worker that dies from an exception after it enabled reports the real reason as an error message
  // just before it exits: with no load() waiting, the exit used to be all the host kept.
  describe('the error a worker reports before it exits', () => {
    const hostWithExit = (ch: FakeChannel, onExit: jest.Mock): PluginWorkerHost =>
      new PluginWorkerHost(ch, undefined, undefined, undefined, undefined, undefined, undefined, undefined, onExit);

    it('is named by the rejection of a call the exit drains and by the exit callback', async () => {
      const ch = new FakeChannel();
      const onExit = jest.fn();
      const host = hostWithExit(ch, onExit);
      void host.load('/p/index.js');
      ch.reply({ kind: 'ready' });
      const p = host.runLifecycle('onEnable');

      ch.reply({ kind: 'error', error: 'boom: relay answered 500' });
      ch.crash(1);

      await expect(p).rejects.toThrow('plugin worker exited unexpectedly (code 1): boom: relay answered 500');
      expect(onExit).toHaveBeenCalledWith(1, false, 'boom: relay answered 500');
    });

    it('is cut to one bounded line, since the plugin chose it', () => {
      const ch = new FakeChannel();
      const onExit = jest.fn();
      hostWithExit(ch, onExit);

      ch.reply({ kind: 'error', error: `first\nsecond ${'x'.repeat(2000)}` });
      ch.crash(1);

      const reason = (onExit.mock.calls[0] as [number, boolean, string])[2];
      expect(reason.startsWith('first second x')).toBe(true);
      expect(reason.length).toBeLessThanOrEqual(500);
    });

    it('leaves the message and the callback as they were when the worker reported nothing', async () => {
      const ch = new FakeChannel();
      const onExit = jest.fn();
      const host = hostWithExit(ch, onExit);
      void host.load('/p/index.js');
      ch.reply({ kind: 'ready' });
      const p = host.runLifecycle('onEnable');

      ch.crash(1);

      await expect(p).rejects.toThrow(/^plugin worker exited unexpectedly \(code 1\)$/);
      expect(onExit).toHaveBeenCalledWith(1, false, undefined);
    });
  });

  it('terminate() terminates the underlying channel', async () => {
    const ch = new FakeChannel();
    const host = new PluginWorkerHost(ch);

    await host.terminate();
    expect(ch.terminated).toBe(true);
  });

  describe('capability requests from the worker', () => {
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('dispatches a cap request and posts the result back', async () => {
      const ch = new FakeChannel();
      const dispatcher = jest.fn().mockResolvedValue({ messageId: 'wamid' });
      new PluginWorkerHost(ch, dispatcher);

      ch.reply({ kind: 'cap', id: 5, verb: 'messages.sendText', args: ['s1', 'c1', 'hi'] });
      await flush();

      expect(dispatcher).toHaveBeenCalledWith(
        'messages.sendText',
        ['s1', 'c1', 'hi'],
        undefined,
        expect.any(AbortSignal),
      );
      expect(ch.sent).toContainEqual({ kind: 'cap-result', id: 5, ok: true, result: { messageId: 'wamid' } });
    });

    it('posts an error cap-result when the dispatcher rejects (e.g. permission denied)', async () => {
      const ch = new FakeChannel();
      const dispatcher = jest.fn().mockRejectedValue(new Error('missing permission'));
      new PluginWorkerHost(ch, dispatcher);

      ch.reply({ kind: 'cap', id: 7, verb: 'messages.sendText', args: [] });
      await flush();

      expect(ch.sent).toContainEqual({ kind: 'cap-result', id: 7, ok: false, error: 'missing permission' });
    });

    it('fails a cap request when no dispatcher is configured', async () => {
      const ch = new FakeChannel();
      new PluginWorkerHost(ch);

      ch.reply({ kind: 'cap', id: 9, verb: 'messages.sendText', args: [] });
      await flush();

      expect(ch.sent.find(m => m.kind === 'cap-result')).toMatchObject({ id: 9, ok: false });
    });

    it('rejects a cap request over the in-flight limit and recovers after the in-flight one settles', async () => {
      const ch = new FakeChannel();
      let resolveFirst: (v: unknown) => void = () => undefined;
      const dispatcher = jest
        .fn()
        .mockImplementationOnce(() => new Promise(r => (resolveFirst = r))) // first cap hangs, holding the slot
        .mockResolvedValue({ ok: true });
      // maxInFlightCaps = 1 (7th positional arg)
      new PluginWorkerHost(ch, dispatcher, undefined, undefined, undefined, undefined, 1);

      ch.reply({ kind: 'cap', id: 1, verb: 'messages.sendText', args: [] }); // takes the only slot
      await flush();
      ch.reply({ kind: 'cap', id: 2, verb: 'messages.sendText', args: [] }); // over the limit
      await flush();

      expect(dispatcher).toHaveBeenCalledTimes(1); // the over-limit cap is rejected before dispatch
      const rejected = ch.sent.find(m => m.kind === 'cap-result' && m.id === 2) as
        { ok: boolean; error?: string } | undefined;
      expect(rejected?.ok).toBe(false);
      expect(rejected?.error).toMatch(/too many concurrent/);

      resolveFirst({ ok: true }); // free the slot
      await flush();
      ch.reply({ kind: 'cap', id: 3, verb: 'messages.sendText', args: [] });
      await flush();

      expect(dispatcher).toHaveBeenCalledTimes(2); // slot released → a fresh cap dispatches
      const ok3 = ch.sent.find(m => m.kind === 'cap-result' && m.id === 3) as { ok: boolean } | undefined;
      expect(ok3?.ok).toBe(true);
    });
  });

  describe('capability call host timeout', () => {
    // Microtask-only flush: these tests run under fake timers, where setImmediate is faked too.
    const microFlush = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it('times out a hung call: errors the worker, frees the slot, and warns (once) on late settle', async () => {
      jest.useFakeTimers();
      try {
        const ch = new FakeChannel();
        let settleHung: (v: unknown) => void = () => undefined;
        const dispatcher = jest
          .fn()
          .mockImplementationOnce(() => new Promise(r => (settleHung = r))) // hangs past the timeout
          .mockResolvedValue({ ok: true });
        const onLog = jest.fn();
        // maxInFlightCaps = 1 (7th arg) so the freed slot is observable; capTimeoutMs = 100 (10th arg).
        new PluginWorkerHost(ch, dispatcher, undefined, undefined, onLog, undefined, 1, undefined, undefined, 100);

        ch.reply({ kind: 'cap', id: 1, verb: 'engine.getContacts', args: [] });
        await microFlush();
        expect(dispatcher).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(100);
        await microFlush();

        // The worker sees a timeout error for the hung call.
        const timedOut = ch.sent.find(m => m.kind === 'cap-result' && m.id === 1) as
          { ok: boolean; error?: string } | undefined;
        expect(timedOut?.ok).toBe(false);
        expect(timedOut?.error).toMatch(/timed out after 100ms/);

        // The slot is freed: a fresh call dispatches immediately and resolves normally.
        ch.reply({ kind: 'cap', id: 2, verb: 'engine.getContacts', args: [] });
        await microFlush();
        expect(dispatcher).toHaveBeenCalledTimes(2);
        expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 2)).toMatchObject({ ok: true });

        // The hung work eventually settles: no second cap-result for id 1, only a WARN via onLog.
        settleHung({ late: true });
        await microFlush();
        expect(ch.sent.filter(m => m.kind === 'cap-result' && m.id === 1)).toHaveLength(1);
        expect(onLog).toHaveBeenCalledTimes(1);
        expect(onLog).toHaveBeenCalledWith(
          'warn',
          expect.stringMatching(/late result was discarded/),
          expect.objectContaining({ action: 'sandbox_cap_late_settle', verb: 'engine.getContacts' }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('gives a send verb a wider budget: a send outrunning the base budget still reports success', async () => {
      jest.useFakeTimers();
      try {
        const ch = new FakeChannel();
        // A send that runs longer than the base budget but inside the send budget must NOT be
        // reported as failed to the worker (the send would still land → a retry would duplicate it).
        let settleSend: (v: unknown) => void = () => undefined;
        const dispatcher = jest.fn().mockImplementation(() => new Promise(r => (settleSend = r)));
        const onLog = jest.fn();
        // capTimeoutMs = 100 (10th arg) → send budget 400.
        new PluginWorkerHost(
          ch,
          dispatcher,
          undefined,
          undefined,
          onLog,
          undefined,
          undefined,
          undefined,
          undefined,
          100,
        );

        ch.reply({ kind: 'cap', id: 1, verb: 'conversation.send', args: [{ type: 'image' }] });
        await microFlush();
        jest.advanceTimersByTime(100); // a lookup would be timed out here
        await microFlush();
        expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toBeUndefined();

        settleSend({ messageId: 'wamid' }); // lands at ~100ms, inside the send budget
        await microFlush();
        expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toMatchObject({
          ok: true,
          result: { messageId: 'wamid' },
        });
        jest.advanceTimersByTime(1000); // the timer was cleared — no late timeout, no warn
        await microFlush();
        expect(onLog).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('still bounds a wedged send — it times out at the send budget and frees the slot', async () => {
      jest.useFakeTimers();
      try {
        const ch = new FakeChannel();
        const dispatcher = jest.fn().mockImplementation(() => new Promise(() => undefined)); // never settles
        const onLog = jest.fn();
        // maxInFlightCaps = 1 (7th arg) so the freed slot is observable; capTimeoutMs = 100 → send budget 400.
        new PluginWorkerHost(ch, dispatcher, undefined, undefined, onLog, undefined, 1, undefined, undefined, 100);

        ch.reply({ kind: 'cap', id: 1, verb: 'messages.sendText', args: ['s1', 'c1', 'hi'] });
        await microFlush();
        jest.advanceTimersByTime(399);
        await microFlush();
        expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toBeUndefined();

        jest.advanceTimersByTime(1); // 400: the send budget elapses
        await microFlush();
        const timedOut = ch.sent.find(m => m.kind === 'cap-result' && m.id === 1) as
          { ok: boolean; error?: string } | undefined;
        expect(timedOut?.ok).toBe(false);
        expect(timedOut?.error).toMatch(/timed out after 400ms/);

        ch.reply({ kind: 'cap', id: 2, verb: 'engine.getContacts', args: [] });
        await microFlush();
        expect(dispatcher).toHaveBeenCalledTimes(2); // slot freed at the send timeout
      } finally {
        jest.useRealTimers();
      }
    });

    it('warns (not crashes) when the hung work fails after the timeout', async () => {
      jest.useFakeTimers();
      try {
        const ch = new FakeChannel();
        let failHung: (e: unknown) => void = () => undefined;
        const dispatcher = jest.fn().mockImplementationOnce(() => new Promise((_, rej) => (failHung = rej)));
        const onLog = jest.fn();
        new PluginWorkerHost(
          ch,
          dispatcher,
          undefined,
          undefined,
          onLog,
          undefined,
          undefined,
          undefined,
          undefined,
          100,
        );

        ch.reply({ kind: 'cap', id: 1, verb: 'engine.getContacts', args: [] });
        await microFlush();
        jest.advanceTimersByTime(100);
        await microFlush();
        expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toMatchObject({ ok: false });

        failHung(new Error('engine blew up'));
        await microFlush();
        expect(onLog).toHaveBeenCalledWith(
          'warn',
          expect.stringMatching(/failed after the 100ms host timeout: engine blew up/),
          expect.objectContaining({ action: 'sandbox_cap_late_settle' }),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves a call that settles within the budget untouched (no timeout, no warn)', async () => {
      jest.useFakeTimers();
      try {
        const ch = new FakeChannel();
        const dispatcher = jest.fn().mockResolvedValue({ messageId: 'wamid' });
        const onLog = jest.fn();
        new PluginWorkerHost(
          ch,
          dispatcher,
          undefined,
          undefined,
          onLog,
          undefined,
          undefined,
          undefined,
          undefined,
          1000,
        );

        ch.reply({ kind: 'cap', id: 1, verb: 'messages.sendText', args: [] });
        await microFlush();
        expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toMatchObject({
          ok: true,
          result: { messageId: 'wamid' },
        });

        jest.advanceTimersByTime(5000); // budget long past — the timer must have been cleared
        await microFlush();
        expect(ch.sent.filter(m => m.kind === 'cap-result' && m.id === 1)).toHaveLength(1);
        expect(onLog).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('hook bridge', () => {
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('calls onHookSubscribe when the worker subscribes to an event', async () => {
      const ch = new FakeChannel();
      const onHookSubscribe = jest.fn();
      new PluginWorkerHost(ch, undefined, onHookSubscribe);

      ch.reply({ kind: 'hook-subscribe', event: 'message:received', priority: 50 });
      await flush();

      expect(onHookSubscribe).toHaveBeenCalledWith('message:received', 50);
    });

    it('dispatchHook posts a hook and resolves on the matching hook-result', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.dispatchHook({
        event: 'message:received',
        data: { body: 'hi' },
        source: 'Engine',
        timeoutMs: 1000,
      });
      const sent = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;
      expect(sent).toMatchObject({ kind: 'hook', event: 'message:received', data: { body: 'hi' }, source: 'Engine' });

      ch.reply({ kind: 'hook-result', id: sent.id, continue: false, data: { body: 'modified' } });
      await expect(pending).resolves.toEqual({ continue: false, data: { body: 'modified' } });
    });

    it('dispatchHook resolves continue:true on timeout so the chain is not stalled', async () => {
      jest.useFakeTimers();
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);
      const onTimeout = jest.fn();

      const pending = host.dispatchHook({
        event: 'message:received',
        data: {},
        source: 'Engine',
        timeoutMs: 100,
        onTimeout,
      });
      jest.advanceTimersByTime(100);

      await expect(pending).resolves.toEqual({ continue: true, error: 'hook timed out after 100ms' });
      expect(onTimeout).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('dispatchHook surfaces a worker-reported handler error on the resolved result', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 1000 });
      const sent = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;

      ch.reply({ kind: 'hook-result', id: sent.id, continue: true, error: 'handler blew up' });
      await expect(pending).resolves.toEqual({ continue: true, error: 'handler blew up' });
    });

    it('dispatchHook forwards failClosed:true on the IPC hook message when requested', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.dispatchHook({
        event: 'message:sending',
        data: {},
        source: 'MessageService',
        timeoutMs: 1000,
        failClosed: true,
      });
      const sent = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;
      expect(sent.failClosed).toBe(true);
      ch.reply({ kind: 'hook-result', id: sent.id, continue: true });
      await expect(pending).resolves.toEqual({ continue: true });
    });

    it.each([undefined, null, 'yes', 1])(
      'dispatchHook surfaces a malformed-result error when hook-result.continue is non-boolean (%p)',
      async badContinue => {
        const ch = new FakeChannel();
        const host = new PluginWorkerHost(ch);

        const pending = host.dispatchHook({ event: 'message:sending', data: {}, source: 'Engine', timeoutMs: 1000 });
        const sent = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;

        ch.reply({
          kind: 'hook-result',
          id: sent.id,
          continue: badContinue as unknown as boolean,
        });
        await expect(pending).resolves.toEqual({
          continue: true,
          error: 'malformed hook-result: continue must be a boolean',
        });
      },
    );

    it('dispatchHook normalizes an empty error string on hook-result to a non-empty fallback message', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.dispatchHook({ event: 'message:sending', data: {}, source: 'Engine', timeoutMs: 1000 });
      const sent = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;

      ch.reply({ kind: 'hook-result', id: sent.id, continue: true, error: '' });
      await expect(pending).resolves.toEqual({ continue: true, error: 'sandbox hook failed' });
    });

    it('drains an in-flight hook immediately on worker exit with an error reason', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      // A long timeout: only the worker-exit drain (not the timer) can settle this promptly.
      const pending = host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 5000 });
      ch.crash(1);

      await expect(pending).resolves.toEqual({ continue: true, error: 'plugin worker exited during hook dispatch' });
    });
  });

  describe('logger + static context', () => {
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('load() forwards the static context (pluginId, config) to the worker', () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      void host.load('/p/index.js', { pluginId: 'p', config: { a: 1 } });

      expect(ch.last()).toMatchObject({
        kind: 'load',
        mainPath: '/p/index.js',
        context: { pluginId: 'p', config: { a: 1 } },
      });
    });

    it('load() omits context when none is supplied', () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      void host.load('/p/index.js');

      expect(ch.last()).toEqual({ kind: 'load', mainPath: '/p/index.js' });
    });

    it('routes a worker log message to onLog', async () => {
      const ch = new FakeChannel();
      const onLog = jest.fn();
      new PluginWorkerHost(ch, undefined, undefined, undefined, onLog);

      ch.reply({ kind: 'log', level: 'warn', message: 'heads up', meta: { x: 1 } });
      await flush();

      expect(onLog).toHaveBeenCalledWith('warn', 'heads up', { x: 1 });
    });
  });

  describe('config change + health check', () => {
    it('sendConfigChange posts a config-change message to the worker', () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      host.sendConfigChange({ apiKey: 'rotated' });

      expect(ch.last()).toEqual({ kind: 'config-change', config: { apiKey: 'rotated' } });
    });

    it('healthCheck round-trips and resolves on the worker result', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.healthCheck(1000);
      const sent = ch.last() as Extract<HostToWorkerMessage, { kind: 'health-check' }>;
      expect(sent.kind).toBe('health-check');

      ch.reply({ kind: 'health-result', id: sent.id, healthy: false, message: 'missing credentials' });
      await expect(pending).resolves.toEqual({ healthy: false, message: 'missing credentials' });
    });

    // Plugin code decides what its healthCheck returns, and a string or a missing field must not read as healthy.
    it.each([['false'], [undefined], [1]])('resolves unhealthy for a healthy value of %p', async healthy => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.healthCheck(1000);
      const sent = ch.last() as Extract<HostToWorkerMessage, { kind: 'health-check' }>;
      ch.reply({ kind: 'health-result', id: sent.id, healthy: healthy as unknown as boolean });

      await expect(pending).resolves.toEqual({ healthy: false, message: undefined });
    });

    it('healthCheck resolves unhealthy on timeout so a wedged plugin never hangs the endpoint', async () => {
      jest.useFakeTimers();
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.healthCheck(100);
      jest.advanceTimersByTime(100);

      const result = await pending;
      expect(result.healthy).toBe(false);
      expect(result.message).toMatch(/timed out/i);
      jest.useRealTimers();
    });

    it('healthCheck resolves unhealthy when the worker has exited', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);
      ch.crash(1);

      await expect(host.healthCheck(1000)).resolves.toMatchObject({ healthy: false });
    });
  });

  describe('search bridge', () => {
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('calls onSearchProviderRegister when the worker declares itself a search provider', async () => {
      const ch = new FakeChannel();
      const onSearchProviderRegister = jest.fn();
      // 8th positional arg (after maxInFlightCaps) is onSearchProviderRegister.
      new PluginWorkerHost(
        ch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onSearchProviderRegister,
      );

      ch.reply({ kind: 'search-provider-register' });
      await flush();

      expect(onSearchProviderRegister).toHaveBeenCalledTimes(1);
    });

    it('dispatchSearch posts a search and resolves ok:true on the matching search-result', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.dispatchSearch({ query: { q: 'hello' }, timeoutMs: 1000 });
      const sent = ch.sent.find(m => m.kind === 'search') as Extract<HostToWorkerMessage, { kind: 'search' }>;
      expect(sent).toMatchObject({ kind: 'search', query: { q: 'hello' } });

      ch.reply({
        kind: 'search-result',
        id: sent.id,
        ok: true,
        results: { hits: [], total: 0, tookMs: 1, provider: 'plugin:p' },
      });
      await expect(pending).resolves.toMatchObject({ ok: true, results: { provider: 'plugin:p' } });
    });

    it('dispatchSearch resolves ok:false with the error on a failed search-result', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.dispatchSearch({ query: { q: 'x' }, timeoutMs: 1000 });
      const sent = ch.sent.find(m => m.kind === 'search') as Extract<HostToWorkerMessage, { kind: 'search' }>;

      ch.reply({ kind: 'search-result', id: sent.id, ok: false, error: 'backend down' });
      await expect(pending).resolves.toEqual({ ok: false, error: 'backend down' });
    });

    it('dispatchSearch resolves ok:false on timeout so /search is not hung', async () => {
      jest.useFakeTimers();
      try {
        const ch = new FakeChannel();
        const host = new PluginWorkerHost(ch);

        const pending = host.dispatchSearch({ query: { q: 'x' }, timeoutMs: 100 });
        jest.advanceTimersByTime(100);

        await expect(pending).resolves.toMatchObject({ ok: false, error: /timed out/i });
      } finally {
        jest.useRealTimers();
      }
    });

    it('drains an in-flight search to ok:false on worker exit (no stall for the full timeout)', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.dispatchSearch({ query: { q: 'x' }, timeoutMs: 5000 });
      ch.crash(1);

      await expect(pending).resolves.toMatchObject({ ok: false, error: /exit/i });
    });
  });

  describe('lifecycle timeouts', () => {
    it('rejects load() when the worker never reports ready within the timeout', async () => {
      jest.useFakeTimers();
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.load('/p/index.js', undefined, 100);
      jest.advanceTimersByTime(100);

      await expect(pending).rejects.toThrow(/timed out/i);
      jest.useRealTimers();
    });

    it('clears the load timer when ready arrives in time (no late rejection)', async () => {
      jest.useFakeTimers();
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      const pending = host.load('/p/index.js', undefined, 100);
      ch.reply({ kind: 'ready' });
      await expect(pending).resolves.toBeUndefined();

      jest.advanceTimersByTime(1000); // timer must have been cleared; advancing has no effect
      jest.useRealTimers();
    });

    it('rejects runLifecycle() when no result arrives within the timeout', async () => {
      jest.useFakeTimers();
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);
      void host.load('/p/index.js');
      ch.reply({ kind: 'ready' });

      const pending = host.runLifecycle('onEnable', 100);
      jest.advanceTimersByTime(100);

      await expect(pending).rejects.toThrow(/timed out/i);
      jest.useRealTimers();
    });

    it('clears the lifecycle timer when the result arrives in time', async () => {
      jest.useFakeTimers();
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);
      void host.load('/p/index.js');
      ch.reply({ kind: 'ready' });

      const pending = host.runLifecycle('onEnable', 100);
      ch.reply({ kind: 'lifecycle-result', id: lastLifecycle(ch).id, ok: true });
      await expect(pending).resolves.toBeUndefined();

      jest.advanceTimersByTime(1000); // no late rejection
      jest.useRealTimers();
    });
  });

  describe('hook re-entrancy across the worker IPC boundary (amplification guard)', () => {
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('a worker capability that re-fires the in-flight hook event is not re-dispatched into the worker', async () => {
      const hm = new HookManager();
      const ch = new FakeChannel();
      const EVENT = 'message:sending' as HookEvent;

      // A worker capability call (messages.sendText) that re-fires message:sending on the host — the
      // exact amplification loop: without the guard the re-fire dispatches into the worker again, which
      // sends again, unboundedly.
      const capDispatcher = async (verb: string): Promise<unknown> => {
        if (verb === 'messages.sendText') {
          await hm.execute(EVENT, { reentrant: true }, { source: 'cap' });
        }
        return { messageId: 'wamid' };
      };

      const host = new PluginWorkerHost(ch, capDispatcher, undefined, undefined, undefined, (events, run) =>
        hm.runInFlight(events as HookEvent[], run),
      );

      // The host-side shim the loader registers: dispatch the event into the worker, await its result.
      hm.register('plg', EVENT, async ctx => {
        const r = await host.dispatchHook({
          event: 'message:sending',
          data: ctx.data,
          source: ctx.source,
          timeoutMs: 5000,
        });
        return { continue: r.continue, data: r.data };
      });

      // Fire the event: the shim posts exactly ONE 'hook' message into the worker.
      const exec = hm.execute(EVENT, { n: 1 }, { source: 'test' });
      await flush();
      const firstHooks = ch.sent.filter(m => m.kind === 'hook');
      expect(firstHooks).toHaveLength(1);
      const hookId = firstHooks[0].id;
      expect(firstHooks[0].inFlight).toEqual(['message:sending']);

      // The worker, mid-handler, issues a capability that re-fires message:sending on the host. A call
      // made inside a hook handler echoes that dispatch's id and chain (WorkerCapabilityClient does this).
      ch.reply({
        kind: 'cap',
        id: 99,
        verb: 'messages.sendText',
        args: ['s1', 'c1', 'hi'],
        dispatchId: firstHooks[0].dispatchId,
        inFlight: firstHooks[0].inFlight,
      });
      await flush();
      await flush();

      // The guard must short-circuit the re-fire: still exactly ONE dispatch into the worker.
      expect(ch.sent.filter(m => m.kind === 'hook')).toHaveLength(1);

      // The worker completes the original hook; the chain resolves normally.
      ch.reply({ kind: 'hook-result', id: hookId, continue: true });
      await expect(exec).resolves.toEqual({ continue: true, data: { n: 1 } });
    });
  });

  describe('hook re-entrancy guard is scoped to the causal chain, not the worker', () => {
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
    const SENDING = 'message:sending' as HookEvent;

    // A worker with a message:sending dispatch still pending, plus an in-process moderation hook that
    // vetoes every send. The cap dispatcher reports what the veto chain decided for its send.
    const setup = (pendingEvent = 'message:sending') => {
      const hm = new HookManager();
      const ch = new FakeChannel();
      hm.register('moderation', SENDING, () => Promise.resolve({ continue: false }));
      const capDispatcher = async (): Promise<unknown> => (await hm.execute(SENDING, {}, { source: 'cap' })).continue;
      const host = new PluginWorkerHost(ch, capDispatcher, undefined, undefined, undefined, (events, run) =>
        hm.runInFlight(events as HookEvent[], run),
      );
      void host.dispatchHook({ event: pendingEvent, data: {}, source: 'test', timeoutMs: 60_000 });
      const hook = ch.sent.find((m): m is Extract<HostToWorkerMessage, { kind: 'hook' }> => m.kind === 'hook')!;
      const result = async (id: number): Promise<unknown> => {
        await flush();
        await flush();
        const reply = ch.sent.find(m => m.kind === 'cap-result' && m.id === id);
        return reply && reply.kind === 'cap-result' && reply.ok ? reply.result : reply;
      };
      return { ch, result, dispatchId: hook.dispatchId };
    };

    it('a capability call outside any hook handler still runs every message:sending veto', async () => {
      const { ch, result } = setup();
      // e.g. an ingress handler sending while the worker's own message:sending hook is pending.
      ch.reply({ kind: 'cap', id: 1, verb: 'messages.sendText', args: [] });
      await expect(result(1)).resolves.toBe(false); // vetoed, not short-circuited to continue:true
      ch.crash(); // drains the pending dispatch and its timer
    });

    it('a capability call carrying the pending dispatch id is still short-circuited', async () => {
      const { ch, result, dispatchId } = setup();
      ch.reply({ kind: 'cap', id: 2, verb: 'messages.sendText', args: [], dispatchId, inFlight: ['message:sending'] });
      await expect(result(2)).resolves.toBe(true);
      ch.crash(); // drains the pending dispatch and its timer
    });

    it('ignores a claimed event the host never dispatched to this worker', async () => {
      // Only message:sent is pending; the worker claims message:sending, the chain the send would skip.
      const { ch, result, dispatchId } = setup('message:sent');
      ch.reply({ kind: 'cap', id: 3, verb: 'messages.sendText', args: [], dispatchId, inFlight: ['message:sending'] });
      await expect(result(3)).resolves.toBe(false);
      ch.crash(); // drains the pending dispatch and its timer
    });

    it('forwards the host ancestor chain on the hook message and honours it on the way back', async () => {
      const hm = new HookManager();
      const ch = new FakeChannel();
      hm.register('moderation', SENDING, () => Promise.resolve({ continue: false }));
      const capDispatcher = async (): Promise<unknown> => (await hm.execute(SENDING, {}, { source: 'cap' })).continue;
      const host = new PluginWorkerHost(ch, capDispatcher, undefined, undefined, undefined, (events, run) =>
        hm.runInFlight(events as HookEvent[], run),
      );
      void host.dispatchHook({
        event: 'message:sent',
        data: {},
        source: 'test',
        inFlight: ['message:sending', 'message:sent'],
        timeoutMs: 60_000,
      });
      const hook = ch.sent.find((m): m is Extract<HostToWorkerMessage, { kind: 'hook' }> => m.kind === 'hook')!;
      expect(hook.inFlight).toEqual(['message:sending', 'message:sent']);
      ch.reply({
        kind: 'cap',
        id: 4,
        verb: 'messages.sendText',
        args: [],
        dispatchId: hook.dispatchId,
        inFlight: ['message:sending'],
      });
      await flush();
      await flush();
      expect(ch.sent).toContainEqual({ kind: 'cap-result', id: 4, ok: true, result: true });
      ch.crash(); // drains the pending dispatch and its timer
    });

    // A handler slower than the host's hook timeout keeps running in the worker, and what it sends from
    // there names the dispatch that timed out. Honouring that claim only until the timeout let the send
    // run outside the guard, fire message:sending again and dispatch the same slow handler once more.
    describe('a handler that outlives the host timeout', () => {
      const fakeTimers = (): void => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      };
      const guardedResult = async (
        ch: FakeChannel,
        id: number,
        inFlight: string[],
        dispatchId?: string,
      ): Promise<unknown> => {
        ch.reply({
          kind: 'cap',
          id,
          verb: 'messages.sendText',
          args: [],
          inFlight,
          ...(dispatchId === undefined ? {} : { dispatchId }),
        });
        await flush();
        await flush();
        const reply = ch.sent.find(m => m.kind === 'cap-result' && m.id === id);
        return reply && reply.kind === 'cap-result' && reply.ok ? reply.result : reply;
      };
      const build = () => {
        const hm = new HookManager();
        const ch = new FakeChannel();
        hm.register('moderation', SENDING, () => Promise.resolve({ continue: false }));
        const capDispatcher = jest.fn(
          async (): Promise<unknown> => (await hm.execute(SENDING, {}, { source: 'cap' })).continue,
        );
        const host = new PluginWorkerHost(ch, capDispatcher, undefined, undefined, undefined, (events, run) =>
          hm.runInFlight(events as HookEvent[], run),
        );
        const dispatch = (event: string) => host.dispatchHook({ event, data: {}, source: 'test', timeoutMs: 5000 });
        return { ch, dispatch, host, capDispatcher };
      };

      afterEach(() => jest.useRealTimers());

      it('keeps guarding its capability calls after the timeout, until the worker answers', async () => {
        fakeTimers();
        const { ch, dispatch } = build();
        const timedOut = dispatch('message:sending');
        const hook = ch.sent.find((m): m is Extract<HostToWorkerMessage, { kind: 'hook' }> => m.kind === 'hook')!;
        await jest.advanceTimersByTimeAsync(5000);
        await expect(timedOut).resolves.toEqual({ continue: true, error: 'hook timed out after 5000ms' });

        // The late send still short-circuits (true), rather than running the veto chain (false).
        await expect(guardedResult(ch, 1, ['message:sending'], hook.dispatchId)).resolves.toBe(true);

        // The handler finally returns: the claim is given back, so the expired dispatchId is refused
        // and an unguarded call runs the veto chain (false).
        ch.reply({ kind: 'hook-result', id: hook.id, continue: true });
        await expect(guardedResult(ch, 2, ['message:sending'], hook.dispatchId)).resolves.toMatchObject({
          kind: 'cap-result',
          id: 2,
          ok: false,
        });
        await expect(guardedResult(ch, 3, ['message:sending'])).resolves.toBe(false);
        ch.crash();
      });

      it('gives the claim back when the worker exits', async () => {
        fakeTimers();
        const { ch, dispatch, host, capDispatcher } = build();
        const timedOut = dispatch('message:sending');
        const hook = ch.sent.find((m): m is Extract<HostToWorkerMessage, { kind: 'hook' }> => m.kind === 'hook')!;
        await jest.advanceTimersByTimeAsync(5000);
        await timedOut;
        await expect(guardedResult(ch, 1, ['message:sending'], hook.dispatchId)).resolves.toBe(true);
        expect(capDispatcher).toHaveBeenCalledTimes(1);

        ch.crash();

        // Exit drains all in-flight dispatches and ignores any further caps from the dead worker.
        const internals = host as unknown as {
          inFlightDispatches: Map<string, unknown>;
          lateHookClaims: Map<number, unknown>;
        };
        expect(internals.inFlightDispatches.size).toBe(0);
        expect(internals.lateHookClaims.size).toBe(0);
        await expect(guardedResult(ch, 2, ['message:sending'], hook.dispatchId)).resolves.toBeUndefined();
        expect(capDispatcher).toHaveBeenCalledTimes(1);
      });

      it('holds a bounded number of late claims, giving the oldest back first', async () => {
        fakeTimers();
        const { ch, dispatch, host } = build();
        const first = dispatch('message:sending');
        const firstHook = ch.sent.find((m): m is Extract<HostToWorkerMessage, { kind: 'hook' }> => m.kind === 'hook')!;
        await jest.advanceTimersByTimeAsync(5000);
        await first;
        await expect(guardedResult(ch, 1, ['message:sending'], firstHook.dispatchId)).resolves.toBe(true);

        // 32 more timed-out dispatches of another event push the first one past the bound.
        for (let i = 0; i < 32; i++) {
          const next = dispatch('message:sent');
          await jest.advanceTimersByTimeAsync(5000);
          await next;
        }

        await expect(guardedResult(ch, 2, ['message:sending'], firstHook.dispatchId)).resolves.toMatchObject({
          kind: 'cap-result',
          id: 2,
          ok: false,
        });
        await expect(guardedResult(ch, 3, ['message:sending'])).resolves.toBe(false);
        // The waiter of a dispatch whose claim was given back goes with it: an answer that late is ignored,
        // and one entry per timed-out dispatch would otherwise pile up for as long as the worker lives.
        expect((host as unknown as { hookPending: Map<number, unknown> }).hookPending.size).toBe(32);
        ch.crash();
      });
    });
  });

  describe('post-crash dead-check (fail-fast, no stall)', () => {
    it('dispatchHook resolves immediately with an error reason when the worker is already dead', async () => {
      jest.useFakeTimers();
      try {
        const ch = new FakeChannel();
        const host = new PluginWorkerHost(ch);
        ch.crash(1); // worker dead — handleExit sets this.dead
        // Without the dead-check this awaits the full timeoutMs (the setTimeout never fires under fake
        // timers → the test hangs). With it, resolves synchronously.
        const result = await host.dispatchHook({
          event: 'message:sending',
          data: {},
          source: 'test',
          timeoutMs: 5000,
        });
        expect(result).toEqual({ continue: true, error: 'plugin worker is no longer running' });
      } finally {
        jest.useRealTimers();
      }
    });

    it('dispatchWebhook resolves {ok:false,status:502} immediately when the worker is already dead', async () => {
      jest.useFakeTimers();
      try {
        const ch = new FakeChannel();
        const host = new PluginWorkerHost(ch);
        ch.crash(1);
        const result = await host.dispatchWebhook({
          instanceId: 'i',
          route: 'r',
          method: 'POST',
          headers: {},
          query: {},
          body: '',
          rawBody: '',
          verified: true,
          deliveryId: 'd',
          timeoutMs: 5000,
        });
        expect(result).toEqual({ ok: false, status: 502 });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('liveness probe after a dispatch timeout', () => {
    const PROBE_MS = 1000;
    const pings = (ch: FakeChannel) =>
      ch.sent.filter((m): m is Extract<HostToWorkerMessage, { kind: 'ping' }> => m.kind === 'ping');
    const probingHost = (ch: FakeChannel, onUnresponsive: () => void) =>
      new PluginWorkerHost(
        ch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        PROBE_MS,
        onUnresponsive,
      );
    const hook = (host: PluginWorkerHost) =>
      host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 500 });
    const webhook = (host: PluginWorkerHost) =>
      host.dispatchWebhook({
        instanceId: 'i',
        route: 'r',
        method: 'POST',
        headers: {},
        query: {},
        body: '',
        rawBody: '',
        verified: true,
        deliveryId: 'd',
        timeoutMs: 500,
      });

    // The verdict is given one loop turn after the window closes (see armProbe); a fake setImmediate
    // queued while timers are advancing runs on the next timer step.
    const verdict = () => jest.advanceTimersToNextTimer();

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('posts one ping on a hook timeout, and none while that probe is still in flight', async () => {
      const ch = new FakeChannel();
      const host = probingHost(ch, jest.fn());
      const first = hook(host);
      const second = hook(host);
      jest.advanceTimersByTime(500);
      await Promise.all([first, second]);
      expect(pings(ch)).toHaveLength(1);
    });

    it('a pong clears the probe: a slow async handler is not reported', async () => {
      const ch = new FakeChannel();
      const onUnresponsive = jest.fn();
      const host = probingHost(ch, onUnresponsive);
      const pending = hook(host);
      jest.advanceTimersByTime(500);
      await pending;
      ch.reply({ kind: 'pong', id: pings(ch)[0].id });
      jest.advanceTimersByTime(PROBE_MS * 3);
      expect(onUnresponsive).not.toHaveBeenCalled();

      // The next timeout probes again rather than being suppressed by the answered one.
      const next = hook(host);
      jest.advanceTimersByTime(500);
      await next;
      expect(pings(ch)).toHaveLength(2);
    });

    it('reports a worker that never answers the probe, exactly once', async () => {
      const ch = new FakeChannel();
      const onUnresponsive = jest.fn();
      const host = probingHost(ch, onUnresponsive);
      const pending = hook(host);
      jest.advanceTimersByTime(500);
      await pending;
      jest.advanceTimersByTime(PROBE_MS);
      verdict();
      expect(onUnresponsive).toHaveBeenCalledTimes(1);

      const again = hook(host);
      jest.advanceTimersByTime(500 + PROBE_MS * 2);
      await again;
      expect(onUnresponsive).toHaveBeenCalledTimes(1);
    });

    it('a worker still answering a backlog is not reported while its pong waits behind it', async () => {
      const ch = new FakeChannel();
      const onUnresponsive = jest.fn();
      const host = probingHost(ch, onUnresponsive);
      const pending = hook(host);
      jest.advanceTimersByTime(500);
      await pending;
      const hookId = (ch.sent.find(m => m.kind === 'hook') as { id: number }).id;

      // Late results keep arriving, each inside the window: the event loop is turning.
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(PROBE_MS - 100);
        ch.reply({ kind: 'hook-result', id: hookId, continue: true });
      }
      expect(onUnresponsive).not.toHaveBeenCalled();

      // A full window with no answer at all is still reported.
      jest.advanceTimersByTime(PROBE_MS);
      verdict();
      expect(onUnresponsive).toHaveBeenCalledTimes(1);
    });

    it('log lines do not count as progress: a synchronous loop can emit them', async () => {
      const ch = new FakeChannel();
      const onUnresponsive = jest.fn();
      const host = probingHost(ch, onUnresponsive);
      const pending = hook(host);
      jest.advanceTimersByTime(500);
      await pending;
      jest.advanceTimersByTime(PROBE_MS - 100);
      ch.reply({ kind: 'log', level: 'log', message: 'still spinning' });
      jest.advanceTimersByTime(100);
      verdict();
      expect(onUnresponsive).toHaveBeenCalledTimes(1);
    });

    it('webhook and search timeouts probe too', async () => {
      for (const dispatch of [
        webhook,
        (host: PluginWorkerHost) => host.dispatchSearch({ query: { q: 'x' }, timeoutMs: 500 }),
      ]) {
        const ch = new FakeChannel();
        const onUnresponsive = jest.fn();
        const host = probingHost(ch, onUnresponsive);
        const pending = dispatch(host);
        jest.advanceTimersByTime(500);
        await pending;
        expect(pings(ch)).toHaveLength(1);
        jest.advanceTimersByTime(PROBE_MS);
        verdict();
        expect(onUnresponsive).toHaveBeenCalledTimes(1);
      }
    });

    it('does not probe when no liveness budget is configured', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);
      const pending = hook(host);
      jest.advanceTimersByTime(500);
      await pending;
      expect(pings(ch)).toHaveLength(0);
    });

    // Real timers and a real MessagePort: the race lives in the event loop's phase order. After a host
    // stall the timers phase runs before the poll phase that delivers the port message, so a pong the
    // worker sent in time was read only after the probe timer had already fired.
    it('reads a pong that was queued while the host was stalled before giving its verdict', async () => {
      jest.useRealTimers();
      const SHORT_PROBE_MS = 50;
      const { port1, port2 } = new MessageChannel();
      const ch = new FakeChannel();
      ch.postMessage = (message: HostToWorkerMessage): void => {
        ch.sent.push(message);
        if (message.kind !== 'ping') return;
        setImmediate(() => {
          port2.postMessage({ kind: 'pong', id: message.id });
          const until = Date.now() + SHORT_PROBE_MS * 2;
          while (Date.now() < until); // the host's own loop is blocked past the probe window
        });
      };
      port1.on('message', (message: WorkerToHostMessage) => ch.reply(message));
      const onUnresponsive = jest.fn();
      const host = new PluginWorkerHost(
        ch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        SHORT_PROBE_MS,
        onUnresponsive,
      );
      try {
        await host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 10 });
        await new Promise(resolve => setTimeout(resolve, SHORT_PROBE_MS * 4));

        expect(pings(ch)).toHaveLength(1);
        expect(onUnresponsive).not.toHaveBeenCalled();
      } finally {
        port1.close();
      }
    });

    it('a worker exit cancels a probe in flight', async () => {
      const ch = new FakeChannel();
      const onUnresponsive = jest.fn();
      const host = probingHost(ch, onUnresponsive);
      const pending = hook(host);
      jest.advanceTimersByTime(500);
      await pending;
      ch.crash(1);
      jest.advanceTimersByTime(PROBE_MS * 2);
      expect(onUnresponsive).not.toHaveBeenCalled();
    });
  });
});

// The text a worker reports is whatever its code posts. The router keeps only a string, capped in length, and a
// fixed marker for anything else, before the value is used to build an Error, a log line or a health note.
describe('the text a worker reports in a result', () => {
  const MARKER = '[non-string worker value]';
  const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  // Each level holds the level below twice: written out by String() it is 2 ** levels pieces.
  const diamond = (levels: number): unknown => {
    let value: unknown = [];
    for (let level = 0; level < levels; level++) value = [value, value];
    return structuredClone(value);
  };
  const withTextOf = (calls: { count: number }): unknown => ({
    toString: (): string => {
      calls.count++;
      return 'password=value-text';
    },
  });
  const webhook = () => ({
    instanceId: 'i',
    route: 'r',
    method: 'POST',
    headers: {},
    query: {},
    body: '{}',
    rawBody: '{}',
    verified: true,
    deliveryId: 'd1',
    timeoutMs: 1000,
  });
  const sentOf = <K extends HostToWorkerMessage['kind']>(ch: FakeChannel, kind: K): { id: number } =>
    ch.sent.find(message => message.kind === kind) as unknown as { id: number };

  // One scenario per kind: it posts the worker's reply carrying `value` as the text and returns what the host settled.
  const scenarios: Array<[string, (ch: FakeChannel, value: unknown) => Promise<string | undefined>]> = [
    [
      "an 'error' before ready",
      async (ch, value) => {
        const host = new PluginWorkerHost(ch);
        const loading = host.load('/p/index.js');
        ch.reply({ kind: 'error', error: value as string });
        return loading.then(
          () => undefined,
          (error: Error) => error.message,
        );
      },
    ],
    [
      'a failed lifecycle-result',
      async (ch, value) => {
        const host = new PluginWorkerHost(ch);
        void host.load('/p/index.js');
        ch.reply({ kind: 'ready' });
        const running = host.runLifecycle('onEnable');
        ch.reply({ kind: 'lifecycle-result', id: lastLifecycle(ch).id, ok: false, error: value as string });
        return running.then(
          () => undefined,
          (error: Error) => error.message,
        );
      },
    ],
    [
      'a hook-result with an error',
      async (ch, value) => {
        const host = new PluginWorkerHost(ch);
        const dispatched = host.dispatchHook({
          event: 'message:received',
          data: {},
          source: 'Engine',
          timeoutMs: 1000,
        });
        ch.reply({ kind: 'hook-result', id: sentOf(ch, 'hook').id, continue: true, error: value as string });
        return (await dispatched).error;
      },
    ],
    [
      'a webhook-result with an error',
      async (ch, value) => {
        const host = new PluginWorkerHost(ch);
        const dispatched = host.dispatchWebhook(webhook());
        ch.reply({ kind: 'webhook-result', id: sentOf(ch, 'webhook').id, status: 500, error: value as string });
        return (await dispatched).error;
      },
    ],
    [
      'a failed search-result',
      async (ch, value) => {
        const host = new PluginWorkerHost(ch);
        const dispatched = host.dispatchSearch({ query: { q: 'x' }, timeoutMs: 1000 });
        ch.reply({ kind: 'search-result', id: sentOf(ch, 'search').id, ok: false, error: value as string });
        const result = await dispatched;
        return result.ok ? undefined : result.error;
      },
    ],
    [
      'a health-result with a message',
      async (ch, value) => {
        const host = new PluginWorkerHost(ch);
        const checked = host.healthCheck(1000);
        ch.reply({ kind: 'health-result', id: sentOf(ch, 'health-check').id, healthy: true, message: value as string });
        return (await checked).message;
      },
    ],
  ];

  it.each(scenarios)('keeps a fixed marker for a nested array shared at every level in %s', async (_name, run) => {
    let text: string | undefined;
    const cpuMs = await leastCpuMsAsync(async () => {
      text = await run(new FakeChannel(), diamond(22));
    });

    expect(cpuMs).toBeLessThan(500);
    expect(text).toBe(MARKER);
  });

  it.each(scenarios)('does not ask an object for its own text in %s', async (_name, run) => {
    const calls = { count: 0 };

    const text = await run(new FakeChannel(), withTextOf(calls));

    expect(text).toBe(MARKER);
    expect(calls.count).toBe(0);
  });

  it.each(scenarios)('keeps a string of 8192 characters and cuts a longer one in %s', async (_name, run) => {
    const kept = await run(new FakeChannel(), 'x'.repeat(8192));
    const cut = await run(new FakeChannel(), 'x'.repeat(100_000));
    const short = await run(new FakeChannel(), 'short text');

    expect(kept).toBe('x'.repeat(8192));
    expect(cut).toBe(`${'x'.repeat(8192)}…[truncated]`);
    expect(short).toBe('short text');
  });

  it('still resolves a webhook-result without an error as ok, with a null error read as none', async () => {
    const ch = new FakeChannel();
    const host = new PluginWorkerHost(ch);
    const dispatched = host.dispatchWebhook(webhook());

    ch.reply({ kind: 'webhook-result', id: sentOf(ch, 'webhook').id, status: 200, error: null as unknown as string });

    await expect(dispatched).resolves.toMatchObject({ ok: true, status: 200, error: undefined });
  });

  it('keeps a worker error that is not text out of the exit message too', () => {
    const ch = new FakeChannel();
    const onExit = jest.fn();
    new PluginWorkerHost(ch, undefined, undefined, undefined, undefined, undefined, undefined, undefined, onExit);

    ch.reply({ kind: 'error', error: diamond(22) as string });
    ch.crash(1);

    expect(onExit).toHaveBeenCalledWith(1, false, MARKER);
  });

  it('answers a capability request whose verb is not text with an error, without building text from it', async () => {
    const ch = new FakeChannel();
    const dispatcher = jest.fn();
    const calls = { count: 0 };
    new PluginWorkerHost(ch, dispatcher);

    ch.reply({ kind: 'cap', id: 7, verb: withTextOf(calls) as string, args: [] });
    await tick();

    expect(ch.last()).toEqual({ kind: 'cap-result', id: 7, ok: false, error: MARKER });
    expect(dispatcher).not.toHaveBeenCalled();
    expect(calls.count).toBe(0);
  });
});

describe('host-authoritative dispatch context propagation for capability calls', () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

  it('propagates hook sessionId via host-generated dispatchId and fails closed on expired dispatchId after hook-result', async () => {
    const ch = new FakeChannel();
    const dispatcher = jest.fn().mockResolvedValue({ ok: true });
    const host = new PluginWorkerHost(ch, dispatcher);

    const pending = host.dispatchHook({
      event: 'message:received',
      data: {},
      sessionId: 'sess-1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    const sent = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;
    expect(typeof sent.dispatchId).toBe('string');
    expect(sent.dispatchId).not.toBe('');

    ch.reply({
      kind: 'cap',
      id: 1,
      verb: 'net.fetch',
      args: ['https://s1.example/a'],
      dispatchId: sent.dispatchId,
    });
    await flush();
    expect(dispatcher).toHaveBeenNthCalledWith(
      1,
      'net.fetch',
      ['https://s1.example/a'],
      { sessionId: 'sess-1' },
      expect.any(AbortSignal),
    );

    // Reply finishes the dispatch: reusing the expired dispatchId must fail closed without invoking dispatcher.
    ch.reply({ kind: 'hook-result', id: sent.id, continue: true });
    await pending;

    ch.reply({
      kind: 'cap',
      id: 2,
      verb: 'net.fetch',
      args: ['https://s1.example/b'],
      dispatchId: sent.dispatchId,
    });
    await flush();
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 2)).toMatchObject({
      kind: 'cap-result',
      id: 2,
      ok: false,
      error: expect.stringMatching(/dispatch context/i) as string,
    });
  });

  it('propagates webhook sessionId and instanceId via host-generated dispatchId and fails closed after reply', async () => {
    const ch = new FakeChannel();
    const dispatcher = jest.fn().mockResolvedValue({ ok: true });
    const host = new PluginWorkerHost(ch, dispatcher);

    const pending = host.dispatchWebhook({
      instanceId: 'inst-A',
      route: 'events',
      method: 'POST',
      headers: {},
      query: {},
      body: '{}',
      rawBody: '{}',
      verified: true,
      deliveryId: 'd1',
      sessionId: 'sess-1',
      timeoutMs: 5000,
    });
    const sent = ch.sent.find(m => m.kind === 'webhook') as Extract<HostToWorkerMessage, { kind: 'webhook' }>;
    expect(typeof sent.dispatchId).toBe('string');

    ch.reply({
      kind: 'cap',
      id: 10,
      verb: 'net.fetch',
      args: ['https://inst-a.example/x'],
      dispatchId: sent.dispatchId,
    });
    await flush();
    expect(dispatcher).toHaveBeenNthCalledWith(
      1,
      'net.fetch',
      ['https://inst-a.example/x'],
      {
        sessionId: 'sess-1',
        instanceId: 'inst-A',
      },
      expect.any(AbortSignal),
    );

    ch.reply({ kind: 'webhook-result', id: sent.id, status: 200 });
    await pending;

    ch.reply({
      kind: 'cap',
      id: 11,
      verb: 'net.fetch',
      args: ['https://inst-a.example/y'],
      dispatchId: sent.dispatchId,
    });
    await flush();
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 11)).toMatchObject({
      kind: 'cap-result',
      id: 11,
      ok: false,
    });
  });

  it('fails closed on forged dispatchIds, retains late hook dispatchId until reply, and clears on termination', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    try {
      const ch = new FakeChannel();
      const dispatcher = jest.fn().mockResolvedValue({ ok: true });
      const host = new PluginWorkerHost(ch, dispatcher);

      const hook = host.dispatchHook({
        event: 'message:received',
        data: {},
        sessionId: 'sess-1',
        source: 'Engine',
        timeoutMs: 200,
      });
      const hookSent = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;

      // Forged dispatchId must fail closed without invoking dispatcher.
      ch.reply({
        kind: 'cap',
        id: 1,
        verb: 'net.fetch',
        args: ['https://forged.example'],
        dispatchId: 'sess-2',
        sessionId: 'sess-2',
        instanceId: 'inst-2',
      } as unknown as WorkerToHostMessage);
      await flush();
      expect(dispatcher).not.toHaveBeenCalled();
      expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toMatchObject({
        kind: 'cap-result',
        id: 1,
        ok: false,
      });

      // Hook timeout retains dispatchId under late claim so a slow handler stays scoped to sess-1.
      await jest.advanceTimersByTimeAsync(200);
      await hook;
      ch.reply({
        kind: 'cap',
        id: 2,
        verb: 'net.fetch',
        args: ['https://late-hook.example'],
        dispatchId: hookSent.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenNthCalledWith(
        1,
        'net.fetch',
        ['https://late-hook.example'],
        {
          sessionId: 'sess-1',
        },
        expect.any(AbortSignal),
      );

      // Late hook-result releases the dispatchId; subsequent reuse fails closed.
      ch.reply({ kind: 'hook-result', id: hookSent.id, continue: true });
      ch.reply({
        kind: 'cap',
        id: 3,
        verb: 'net.fetch',
        args: ['https://after-late-reply.example'],
        dispatchId: hookSent.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 3)).toMatchObject({
        kind: 'cap-result',
        id: 3,
        ok: false,
      });

      // Termination clears in-flight webhook dispatchIds too.
      void host.dispatchWebhook({
        instanceId: 'inst-B',
        route: 'events',
        method: 'POST',
        headers: {},
        query: {},
        body: '{}',
        rawBody: '{}',
        verified: true,
        deliveryId: 'd2',
        sessionId: 'sess-2',
        timeoutMs: 5000,
      });
      const webhookSent = ch.sent.find(m => m.kind === 'webhook') as Extract<HostToWorkerMessage, { kind: 'webhook' }>;
      expect(typeof webhookSent.dispatchId).toBe('string');

      await host.terminate();
      expect((host as unknown as { inFlightDispatches: Map<string, unknown> }).inFlightDispatches.size).toBe(0);
      ch.reply({
        kind: 'cap',
        id: 4,
        verb: 'net.fetch',
        args: ['https://after-terminate.example'],
        dispatchId: webhookSent.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 4)).toBeUndefined();
      ch.crash();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears inFlightDispatches on unexpected worker crash without prior terminate()', async () => {
    const ch = new FakeChannel();
    const dispatcher = jest.fn().mockResolvedValue({ ok: true });
    const host = new PluginWorkerHost(ch, dispatcher);

    const hook = host.dispatchHook({
      event: 'message:received',
      data: {},
      sessionId: 'sess-1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    const hookSent = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;

    ch.crash(1);
    await hook;
    expect((host as unknown as { inFlightDispatches: Map<string, unknown> }).inFlightDispatches.size).toBe(0);

    ch.reply({
      kind: 'cap',
      id: 1,
      verb: 'net.fetch',
      args: ['https://after-crash.example'],
      dispatchId: hookSent.dispatchId,
    });
    await flush();
    expect(dispatcher).not.toHaveBeenCalled();
    expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toBeUndefined();
  });

  it('cleans up inFlightDispatches, pending maps, and timers when postMessage throws', async () => {
    const ch = new FakeChannel();
    ch.postMessage = () => {
      throw new Error('DataCloneError: uncloneable value');
    };
    const host = new PluginWorkerHost(ch);

    await expect(
      host.dispatchHook({
        event: 'message:received',
        data: {},
        sessionId: 'sess-1',
        source: 'Engine',
        timeoutMs: 5000,
      }),
    ).rejects.toThrow('DataCloneError');

    await expect(
      host.dispatchWebhook({
        instanceId: 'inst-A',
        route: 'events',
        method: 'POST',
        headers: {},
        query: {},
        body: '{}',
        rawBody: '{}',
        verified: true,
        deliveryId: 'd1',
        sessionId: 'sess-1',
        timeoutMs: 5000,
      }),
    ).rejects.toThrow('DataCloneError');

    const internals = host as unknown as {
      inFlightDispatches: Map<string, unknown>;
      hookPending: Map<number, unknown>;
      webhookPending: Map<number, unknown>;
    };
    expect(internals.inFlightDispatches.size).toBe(0);
    expect(internals.hookPending.size).toBe(0);
    expect(internals.webhookPending.size).toBe(0);
  });

  it('refuses a held net.fetch that outlives its dispatch instead of posting it without dispatchId', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));
    const hooks = new WorkerHookRegistry(m => sent.push(m));

    for (let i = 0; i < SANDBOX_MAX_PENDING_CAPS; i++) {
      void client.call('storage.get', [i]);
    }
    let heldFetch!: Promise<unknown>;
    hooks.register('message:received', () => {
      heldFetch = client.call('net.fetch', ['https://s1.example/held']);
      heldFetch.catch(() => undefined);
      return { continue: true };
    });

    await hooks.handleHook({
      kind: 'hook',
      id: 1,
      dispatchId: 'disp-1',
      event: 'message:received',
      data: {},
      source: 'Engine',
    });

    // Free a slot after the dispatch has already returned.
    const firstCap = sent[0] as Extract<WorkerToHostMessage, { kind: 'cap' }>;
    client.handleResult({ kind: 'cap-result', id: firstCap.id, ok: true, result: null });

    await expect(heldFetch).rejects.toThrow(/net\.fetch/);
    const postedFetches = sent.filter(m => m.kind === 'cap' && m.verb === 'net.fetch');
    expect(postedFetches).toEqual([]);
  });

  it('wires worker hook and webhook handlers through WorkerCapabilityClient with automatic dispatchId echo', async () => {
    const seenContexts: Array<{ verb: string; url: unknown; ctx?: { sessionId?: string; instanceId?: string } }> = [];
    const dispatcher = jest.fn(
      (verb: string, args: unknown[], dispatchContext?: { sessionId?: string; instanceId?: string }) => {
        seenContexts.push({ verb, url: args[0], ctx: dispatchContext });
        return Promise.resolve({ ok: true });
      },
    );

    // Loopback channel connecting real PluginWorkerHost to real WorkerHookRegistry, WebhookRegistry,
    // and WorkerCapabilityClient without spawning a thread.
    let hostListener: ((m: WorkerToHostMessage) => void) | undefined;
    const workerSend = (m: WorkerToHostMessage): void => {
      setImmediate(() => hostListener?.(m));
    };
    const capClient = new WorkerCapabilityClient(workerSend);
    const hookReg = new WorkerHookRegistry(workerSend);
    const webhookReg = new WebhookRegistry(workerSend);

    const channel: PluginWorkerChannel = {
      postMessage: (msg: HostToWorkerMessage) => {
        if (msg.kind === 'cap-result') capClient.handleResult(msg);
        else if (msg.kind === 'hook') void hookReg.handleHook(msg);
        else if (msg.kind === 'webhook') void webhookReg.handleWebhook(msg);
      },
      onMessage: cb => {
        hostListener = cb;
      },
      onExit: () => undefined,
      terminate: () => Promise.resolve(),
    };

    const host = new PluginWorkerHost(channel, dispatcher);

    let deferredHookFetch!: () => Promise<unknown>;
    hookReg.register('message:received', async () => {
      await capClient.call('net.fetch', ['https://hook-s1.example/a']);
      deferredHookFetch = () => capClient.call('net.fetch', ['https://deferred.example/b']);
      return { continue: true };
    });

    // Even when webhook message carries no `config`, dispatchId must still flow through hookConfigStore.
    webhookReg.register('events', async () => {
      await capClient.call('net.fetch', ['https://webhook-inst.example/c']);
      return { status: 200 };
    });

    await host.dispatchHook({
      event: 'message:received',
      data: {},
      sessionId: 'sess-1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    await deferredHookFetch();
    await host.dispatchWebhook({
      instanceId: 'inst-A',
      route: 'events',
      method: 'POST',
      headers: {},
      query: {},
      body: '{}',
      rawBody: '{}',
      verified: true,
      deliveryId: 'd1',
      sessionId: 'sess-2',
      timeoutMs: 5000,
    });

    expect(seenContexts).toEqual([
      { verb: 'net.fetch', url: 'https://hook-s1.example/a', ctx: { sessionId: 'sess-1' } },
      { verb: 'net.fetch', url: 'https://deferred.example/b', ctx: undefined },
      { verb: 'net.fetch', url: 'https://webhook-inst.example/c', ctx: { sessionId: 'sess-2', instanceId: 'inst-A' } },
    ]);
  });
});

describe('capability cancellation, unsettled zombie cap, idle liveness, and originHook guard', () => {
  const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  const microFlush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const pings = (ch: FakeChannel) =>
    ch.sent.filter((m): m is Extract<HostToWorkerMessage, { kind: 'ping' }> => m.kind === 'ping');

  it('aborts the AbortSignal passed to capDispatcher on capTimeoutMs timeout', async () => {
    jest.useFakeTimers();
    try {
      const ch = new FakeChannel();
      let capturedSignal: AbortSignal | undefined;
      const dispatcher = jest.fn(
        (_verb: string, _args: unknown[], _ctx?: unknown, signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            capturedSignal = signal;
            signal?.addEventListener('abort', () => reject(new Error('aborted by host')));
          }),
      );
      new PluginWorkerHost(ch, dispatcher, undefined, undefined, undefined, undefined, 2, undefined, undefined, 100);

      ch.reply({ kind: 'cap', id: 1, verb: 'net.fetch', args: ['https://example.com'] });
      await microFlush();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);

      jest.advanceTimersByTime(100);
      await microFlush();
      expect(capturedSignal?.aborted).toBe(true);
      expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/timed out after 100ms/) as string,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts in-flight capability AbortSignals on terminate() and worker exit', async () => {
    const ch1 = new FakeChannel();
    let sig1: AbortSignal | undefined;
    const d1 = jest.fn((_v: string, _a: unknown[], _c?: unknown, signal?: AbortSignal) => {
      sig1 = signal;
      return new Promise(() => undefined);
    });
    const host1 = new PluginWorkerHost(ch1, d1);
    ch1.reply({ kind: 'cap', id: 1, verb: 'net.fetch', args: ['https://example.com'] });
    await flush();
    expect(sig1?.aborted).toBe(false);
    await host1.terminate();
    expect(sig1?.aborted).toBe(true);

    const ch2 = new FakeChannel();
    let sig2: AbortSignal | undefined;
    const d2 = jest.fn((_v: string, _a: unknown[], _c?: unknown, signal?: AbortSignal) => {
      sig2 = signal;
      return new Promise(() => undefined);
    });
    new PluginWorkerHost(ch2, d2);
    ch2.reply({ kind: 'cap', id: 2, verb: 'net.fetch', args: ['https://example.com'] });
    await flush();
    expect(sig2?.aborted).toBe(false);
    ch2.crash(1);
    expect(sig2?.aborted).toBe(true);
  });

  it('bounds repeated hung non-cancellable caps and recovers once zombies settle', async () => {
    jest.useFakeTimers();
    try {
      const ch = new FakeChannel();
      const settlers: Array<(v: unknown) => void> = [];
      const dispatcher = jest.fn(() => new Promise(resolve => settlers.push(resolve)));
      // maxInFlightCaps = 2, capTimeoutMs = 100 -> ceiling for active + unsettled = 4.
      new PluginWorkerHost(ch, dispatcher, undefined, undefined, undefined, undefined, 2, undefined, undefined, 100);

      // Accumulate 4 hung non-cancellable timed-out calls across 2 rounds.
      ch.reply({ kind: 'cap', id: 1, verb: 'engine.getContacts', args: [] });
      ch.reply({ kind: 'cap', id: 2, verb: 'engine.getContacts', args: [] });
      await microFlush();
      jest.advanceTimersByTime(100);
      await microFlush();

      ch.reply({ kind: 'cap', id: 3, verb: 'engine.getContacts', args: [] });
      ch.reply({ kind: 'cap', id: 4, verb: 'engine.getContacts', args: [] });
      await microFlush();
      jest.advanceTimersByTime(100);
      await microFlush();
      expect(dispatcher).toHaveBeenCalledTimes(4);

      // 5th call hits the unsettled zombie ceiling and is rejected without invoking dispatcher.
      ch.reply({ kind: 'cap', id: 5, verb: 'engine.getContacts', args: [] });
      await microFlush();
      expect(dispatcher).toHaveBeenCalledTimes(4);
      expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 5)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/timed-out|unsettled|too many/i) as string,
      });

      // Settling one zombie frees room for a new capability call.
      settlers[0]({ late: true });
      await microFlush();
      ch.reply({ kind: 'cap', id: 6, verb: 'engine.getContacts', args: [] });
      await microFlush();
      expect(dispatcher).toHaveBeenCalledTimes(5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('invokes probeLiveness() when healthCheck() times out', async () => {
    jest.useFakeTimers();
    try {
      const ch = new FakeChannel();
      const onUnresponsive = jest.fn();
      const host = new PluginWorkerHost(
        ch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1000,
        onUnresponsive,
      );

      const pending = host.healthCheck(250);
      jest.advanceTimersByTime(250);
      await expect(pending).resolves.toEqual({ healthy: false, message: 'health check timed out' });
      expect(pings(ch)).toHaveLength(1);

      jest.advanceTimersByTime(1000);
      jest.advanceTimersToNextTimer();
      expect(onUnresponsive).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('probes an idle worker periodically when livenessIntervalMs is set and clears the timer on terminate', async () => {
    jest.useFakeTimers();
    try {
      const ch = new FakeChannel();
      const onUnresponsive = jest.fn();
      const host = new PluginWorkerHost(
        ch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        500,
        onUnresponsive,
        2000,
      );

      // No periodic ping before load resolves ready.
      jest.advanceTimersByTime(5000);
      expect(pings(ch)).toHaveLength(0);

      const loading = host.load('/fake/plugin.js');
      ch.reply({ kind: 'ready' });
      await loading;

      // Worker activity resets idle timer; ping fires once idle >= livenessIntervalMs.
      jest.advanceTimersByTime(1999);
      expect(pings(ch)).toHaveLength(0);

      jest.advanceTimersByTime(1);
      expect(pings(ch)).toHaveLength(1);

      // Answering pong keeps the worker healthy and resets activity.
      ch.reply({ kind: 'pong', id: pings(ch)[0].id });
      jest.advanceTimersByTime(1500);
      expect(onUnresponsive).not.toHaveBeenCalled();

      // Next idle window triggers another probe; unanswered triggers onUnresponsive.
      jest.advanceTimersByTime(500);
      expect(pings(ch)).toHaveLength(2);
      jest.advanceTimersByTime(500);
      jest.advanceTimersToNextTimer();
      expect(onUnresponsive).toHaveBeenCalledTimes(1);

      await host.terminate();
      jest.advanceTimersByTime(10_000);
      expect(pings(ch)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a forged originHook when no matching hook dispatch is in flight', async () => {
    const ch = new FakeChannel();
    const hm = new HookManager();
    const seenInFlight: boolean[] = [];
    const dispatcher = jest.fn(() => {
      seenInFlight.push(hm.isEventInFlight('message:sent'));
      return Promise.resolve({ ok: true });
    });
    const host = new PluginWorkerHost(ch, dispatcher, undefined, undefined, undefined, (events, run) =>
      hm.runInFlight(events as HookEvent[], run),
    );

    // Case 1: no active dispatch at all -> forged originHook ignored.
    ch.reply({
      kind: 'cap',
      id: 1,
      verb: 'messages.sendText',
      args: ['s1', 'c1', 'hi'],
      originHook: 'message:sent',
    });
    await flush();

    // Case 2: active message:received dispatch -> forging originHook: 'message:sent' ignored.
    const recv = host.dispatchHook({
      event: 'message:received',
      data: {},
      sessionId: 's1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    const recvMsg = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;
    ch.reply({
      kind: 'cap',
      id: 2,
      verb: 'messages.sendText',
      args: ['s1', 'c1', 'hi'],
      dispatchId: recvMsg.dispatchId,
      originHook: 'message:sent',
    });
    await flush();
    ch.reply({ kind: 'hook-result', id: recvMsg.id, continue: true });
    await recv;

    // Case 3: active message:sent dispatch -> matching originHook accepted.
    const sentHook = host.dispatchHook({
      event: 'message:sent',
      data: {},
      sessionId: 's1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    const sentMsg = ch.sent
      .filter((m): m is Extract<HostToWorkerMessage, { kind: 'hook' }> => m.kind === 'hook')
      .at(-1)!;
    ch.reply({
      kind: 'cap',
      id: 3,
      verb: 'messages.sendText',
      args: ['s1', 'c1', 'hi'],
      dispatchId: sentMsg.dispatchId,
      originHook: 'message:sent',
    });
    await flush();
    ch.reply({ kind: 'hook-result', id: sentMsg.id, continue: true });
    await sentHook;

    expect(seenInFlight).toEqual([false, false, true]);
  });

  it('enforces host-recorded hook guard even when the worker omits originHook and inFlight', async () => {
    const ch = new FakeChannel();
    const hm = new HookManager();
    const seenInFlight: boolean[] = [];
    const dispatcher = jest.fn(() => {
      seenInFlight.push(hm.isEventInFlight('message:sent'));
      return Promise.resolve({ ok: true });
    });
    const host = new PluginWorkerHost(ch, dispatcher, undefined, undefined, undefined, (events, run) =>
      hm.runInFlight(events as HookEvent[], run),
    );

    const sentHook = host.dispatchHook({
      event: 'message:sent',
      data: {},
      sessionId: 's1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    const sentMsg = ch.sent.find(m => m.kind === 'hook') as Extract<HostToWorkerMessage, { kind: 'hook' }>;

    // Worker sends a cap referencing the active message:sent dispatchId while omitting both
    // originHook and inFlight; the host must still guard using its recorded dispatch chain.
    ch.reply({
      kind: 'cap',
      id: 1,
      verb: 'messages.sendText',
      args: ['s1', 'c1', 'hi'],
      dispatchId: sentMsg.dispatchId,
    });
    await flush();

    ch.reply({ kind: 'hook-result', id: sentMsg.id, continue: true });
    await sentHook;

    expect(seenInFlight).toEqual([true]);
  });

  it('blocks cross-dispatch inFlight spoofing when message:sent and message:received are concurrently active', async () => {
    const ch = new FakeChannel();
    const hm = new HookManager();
    const observed: Array<{ received: boolean; sent: boolean }> = [];
    const dispatcher = jest.fn(() => {
      observed.push({
        received: hm.isEventInFlight('message:received'),
        sent: hm.isEventInFlight('message:sent'),
      });
      return Promise.resolve({ ok: true });
    });
    const host = new PluginWorkerHost(ch, dispatcher, undefined, undefined, undefined, (events, run) =>
      hm.runInFlight(events as HookEvent[], run),
    );

    const sentHook = host.dispatchHook({
      event: 'message:sent',
      data: {},
      sessionId: 's1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    const recvHook = host.dispatchHook({
      event: 'message:received',
      data: {},
      sessionId: 's1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    const webhook = host.dispatchWebhook({
      instanceId: 'inst-1',
      route: '/hook',
      method: 'POST',
      headers: {},
      query: {},
      body: '{}',
      rawBody: '{}',
      verified: true,
      deliveryId: 'd-1',
      sessionId: 's1',
      timeoutMs: 5000,
    });

    const hookMsgs = ch.sent.filter((m): m is Extract<HostToWorkerMessage, { kind: 'hook' }> => m.kind === 'hook');
    const sentMsg = hookMsgs.find(m => m.event === 'message:sent')!;
    const recvMsg = hookMsgs.find(m => m.event === 'message:received')!;
    const webhookMsg = ch.sent.find(m => m.kind === 'webhook') as Extract<HostToWorkerMessage, { kind: 'webhook' }>;

    // A cap from message:received attempts to spoof inFlight: ['message:sent'] while a
    // message:sent dispatch is active on the same worker.
    ch.reply({
      kind: 'cap',
      id: 1,
      verb: 'messages.sendText',
      args: ['s1', 'c1', 'reply'],
      dispatchId: recvMsg.dispatchId,
      inFlight: ['message:received', 'message:sent'],
      originHook: 'message:sent',
    });
    // A cap from an ingress webhook attempts to spoof inFlight: ['message:sent'].
    ch.reply({
      kind: 'cap',
      id: 2,
      verb: 'messages.sendText',
      args: ['s1', 'c1', 'ingress'],
      dispatchId: webhookMsg.dispatchId,
      inFlight: ['message:sent'],
      originHook: 'message:sent',
    });
    await flush();

    ch.reply({ kind: 'hook-result', id: recvMsg.id, continue: true });
    ch.reply({ kind: 'hook-result', id: sentMsg.id, continue: true });
    ch.reply({ kind: 'webhook-result', id: webhookMsg.id, status: 200 });
    await Promise.all([sentHook, recvHook, webhook]);

    expect(observed).toEqual([
      { received: true, sent: false },
      { received: false, sent: false },
    ]);
  });

  it('clears pending withCapTimeout timers on terminate() and worker exit with no late cap-result or warnings', async () => {
    jest.useFakeTimers();
    try {
      for (const mode of ['terminate', 'exit'] as const) {
        const ch = new FakeChannel();
        const signals: AbortSignal[] = [];
        const onLog = jest.fn();
        const dispatcher = jest.fn((_verb: string, _args: unknown[], _ctx?: unknown, signal?: AbortSignal) => {
          if (signal) signals.push(signal);
          // Never settles even after signal aborts (models an un-cancellable capability call).
          return new Promise(() => undefined);
        });
        const host = new PluginWorkerHost(
          ch,
          dispatcher,
          undefined,
          undefined,
          onLog,
          undefined,
          4,
          undefined,
          undefined,
          1_000,
        );

        ch.reply({ kind: 'cap', id: 1, verb: 'messages.sendText', args: ['s1', 'c1', 'hi'] });
        await microFlush();
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(false);
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        if (mode === 'terminate') {
          await host.terminate();
        } else {
          ch.crash(1);
        }
        await microFlush();

        expect(signals[0].aborted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);

        jest.advanceTimersByTime(10_000);
        await microFlush();

        expect(ch.sent.filter(m => m.kind === 'cap-result')).toHaveLength(0);
        expect(onLog).not.toHaveBeenCalled();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores worker-claimed inFlight when dispatchId is omitted even while matching hooks are active', async () => {
    const ch = new FakeChannel();
    const hm = new HookManager();
    const observed: Array<{ sending: boolean; sent: boolean }> = [];
    const dispatcher = jest.fn(() => {
      observed.push({
        sending: hm.isEventInFlight('message:sending'),
        sent: hm.isEventInFlight('message:sent'),
      });
      return Promise.resolve({ ok: true });
    });
    const host = new PluginWorkerHost(ch, dispatcher, undefined, undefined, undefined, (events, run) =>
      hm.runInFlight(events as HookEvent[], run),
    );

    const sendingHook = host.dispatchHook({
      event: 'message:sending',
      data: {},
      sessionId: 's1',
      source: 'MessageService',
      timeoutMs: 5000,
    });
    const sentHook = host.dispatchHook({
      event: 'message:sent',
      data: {},
      sessionId: 's1',
      source: 'Engine',
      timeoutMs: 5000,
    });
    const hookMsgs = ch.sent.filter((m): m is Extract<HostToWorkerMessage, { kind: 'hook' }> => m.kind === 'hook');

    // Worker omits dispatchId and attempts to spoof inFlight: ['message:sent', 'message:sending']
    // while both hooks are concurrently active on the worker.
    ch.reply({
      kind: 'cap',
      id: 1,
      verb: 'messages.sendText',
      args: ['s1', 'c1', 'spoof'],
      inFlight: ['message:sent', 'message:sending'],
      originHook: 'message:sent',
    });
    await flush();

    for (const msg of hookMsgs) {
      ch.reply({ kind: 'hook-result', id: msg.id, continue: true });
    }
    await Promise.all([sendingHook, sentHook]);

    expect(observed).toEqual([{ sending: false, sent: false }]);
  });

  it('ignores capability calls arriving while channel.terminate() is pending', async () => {
    const ch = new FakeChannel();
    let finishTerminate!: () => void;
    ch.terminate = () =>
      new Promise<void>(resolve => {
        finishTerminate = resolve;
      });
    const dispatcher = jest.fn().mockResolvedValue({ ok: true });
    const host = new PluginWorkerHost(ch, dispatcher);

    const terminating = host.terminate();

    // A late cap arrives from the worker before channel.terminate() finishes.
    ch.reply({
      kind: 'cap',
      id: 1,
      verb: 'messages.sendText',
      args: ['s1', 'c1', 'late'],
    });
    await flush();

    expect(dispatcher).not.toHaveBeenCalled();
    expect(ch.sent.filter(m => m.kind === 'cap-result')).toHaveLength(0);

    finishTerminate();
    await terminating;
  });

  describe('webhook capability deadline alignment, abort on timeout, and retry idempotency', () => {
    it('aborts an in-flight conversation.send cap when dispatchWebhook hits its timeout before capTimeoutMs * 4', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      try {
        const ch = new FakeChannel();
        let capturedSignal: AbortSignal | undefined;
        const dispatcher = jest.fn(
          (_verb: string, _args: unknown[], _ctx?: unknown, signal?: AbortSignal) =>
            new Promise((_resolve, reject) => {
              capturedSignal = signal;
              signal?.addEventListener('abort', () => reject(new Error('aborted by webhook timeout')));
            }),
        );
        // capTimeoutMs=30000 -> SEND_CAP_VERBS would otherwise allow 120000ms while webhook timeoutMs=5000.
        const host = new PluginWorkerHost(
          ch,
          dispatcher,
          undefined,
          undefined,
          undefined,
          undefined,
          4,
          undefined,
          undefined,
          30000,
        );

        const pending = host.dispatchWebhook({
          instanceId: 'inst-1',
          route: 'chatwoot',
          method: 'POST',
          headers: {},
          query: {},
          body: '{}',
          rawBody: '{}',
          verified: true,
          deliveryId: 'del-abort-1',
          sessionId: 'sess-1',
          timeoutMs: 5000,
        });
        const sent = ch.sent.find(m => m.kind === 'webhook') as Extract<HostToWorkerMessage, { kind: 'webhook' }>;

        ch.reply({
          kind: 'cap',
          id: 1,
          verb: 'conversation.send',
          args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'hello' }],
          dispatchId: sent.dispatchId,
        });
        await microFlush();
        expect(capturedSignal?.aborted).toBe(false);

        jest.advanceTimersByTime(5000);
        await microFlush();

        await expect(pending).resolves.toMatchObject({ ok: false, status: 504 });
        expect(capturedSignal?.aborted).toBe(true);
        // Stale cap-result must not be posted back after the webhook dispatch timed out.
        expect(ch.sent.filter(m => m.kind === 'cap-result')).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    });

    it('caps conversation.send timeout to remaining webhook dispatch deadline rather than 120s', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      try {
        const ch = new FakeChannel();
        let capturedSignal: AbortSignal | undefined;
        const dispatcher = jest.fn(
          (_verb: string, _args: unknown[], _ctx?: unknown, signal?: AbortSignal) =>
            new Promise((_resolve, reject) => {
              capturedSignal = signal;
              signal?.addEventListener('abort', () => reject(new Error('aborted on remaining deadline')));
            }),
        );
        const host = new PluginWorkerHost(
          ch,
          dispatcher,
          undefined,
          undefined,
          undefined,
          undefined,
          4,
          undefined,
          undefined,
          30000,
        );

        const pending = host.dispatchWebhook({
          instanceId: 'inst-1',
          route: 'chatwoot',
          method: 'POST',
          headers: {},
          query: {},
          body: '{}',
          rawBody: '{}',
          verified: true,
          deliveryId: 'del-rem-1',
          sessionId: 'sess-1',
          timeoutMs: 5000,
        });
        const sent = ch.sent.find(m => m.kind === 'webhook') as Extract<HostToWorkerMessage, { kind: 'webhook' }>;

        jest.advanceTimersByTime(3000);
        ch.reply({
          kind: 'cap',
          id: 1,
          verb: 'conversation.send',
          args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'late cap' }],
          dispatchId: sent.dispatchId,
        });
        await microFlush();
        expect(capturedSignal?.aborted).toBe(false);

        jest.advanceTimersByTime(2000);
        await microFlush();

        await expect(pending).resolves.toMatchObject({ ok: false, status: 504 });
        expect(capturedSignal?.aborted).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('deduplicates outbound send caps across webhook retry boundaries using a deterministic per-dispatch key', async () => {
      const ch = new FakeChannel();
      const dispatcher = jest.fn().mockResolvedValue({ messageId: 'wamid-once' });
      const host = new PluginWorkerHost(ch, dispatcher);

      const baseOpts = {
        instanceId: 'inst-1',
        route: 'chatwoot',
        method: 'POST',
        headers: {},
        query: {},
        body: '{}',
        rawBody: '{}',
        verified: true,
        deliveryId: 'del-retry-1',
        sessionId: 'sess-1',
        timeoutMs: 5000,
      };

      // Attempt 1 executes the outbound send, then returns 500 so BullMQ retries the delivery.
      const attempt1 = host.dispatchWebhook(baseOpts);
      const msg1 = ch.sent.find(m => m.kind === 'webhook') as Extract<HostToWorkerMessage, { kind: 'webhook' }>;
      ch.reply({
        kind: 'cap',
        id: 1,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'hello' }],
        dispatchId: msg1.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 1)).toMatchObject({
        ok: true,
        result: { messageId: 'wamid-once' },
      });
      ch.reply({ kind: 'webhook-result', id: msg1.id, status: 500, error: 'transient downstream' });
      await expect(attempt1).resolves.toMatchObject({ ok: false, status: 500 });

      // Attempt 2 replays the same deliveryId: ordinal #0 send must reuse the prior outcome, while ordinal #1 runs fresh.
      const attempt2 = host.dispatchWebhook(baseOpts);
      const msg2 = ch.sent.filter(
        (m): m is Extract<HostToWorkerMessage, { kind: 'webhook' }> => m.kind === 'webhook',
      )[1];
      ch.reply({
        kind: 'cap',
        id: 2,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'hello' }],
        dispatchId: msg2.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(ch.sent.find(m => m.kind === 'cap-result' && m.id === 2)).toMatchObject({
        ok: true,
        result: { messageId: 'wamid-once' },
      });

      ch.reply({
        kind: 'cap',
        id: 3,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'second msg' }],
        dispatchId: msg2.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenCalledTimes(2);
      ch.reply({ kind: 'webhook-result', id: msg2.id, status: 200 });
      await expect(attempt2).resolves.toMatchObject({ ok: true, status: 200 });
    });

    it('honors caller-supplied idempotencyKey and does not poison retries after a rejected send', async () => {
      const ch = new FakeChannel();
      const dispatcher = jest
        .fn()
        .mockRejectedValueOnce(new Error('engine offline'))
        .mockResolvedValueOnce({ messageId: 'wamid-k1' })
        .mockResolvedValueOnce({ messageId: 'wamid-k2' });
      const host = new PluginWorkerHost(ch, dispatcher);

      const opts = {
        instanceId: 'inst-1',
        route: 'chatwoot',
        method: 'POST',
        headers: {},
        query: {},
        body: '{}',
        rawBody: '{}',
        verified: true,
        deliveryId: 'del-retry-2',
        sessionId: 'sess-1',
        timeoutMs: 5000,
      };

      const attempt1 = host.dispatchWebhook(opts);
      const msg1 = ch.sent.find(m => m.kind === 'webhook') as Extract<HostToWorkerMessage, { kind: 'webhook' }>;
      ch.reply({
        kind: 'cap',
        id: 1,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'hi' }],
        dispatchId: msg1.dispatchId,
      });
      await flush();
      ch.reply({ kind: 'webhook-result', id: msg1.id, status: 500, error: 'send failed' });
      await expect(attempt1).resolves.toMatchObject({ ok: false, status: 500 });

      // Failed send did not poison the retry; explicit distinct idempotencyKey also runs independently.
      const attempt2 = host.dispatchWebhook(opts);
      const msg2 = ch.sent.filter(
        (m): m is Extract<HostToWorkerMessage, { kind: 'webhook' }> => m.kind === 'webhook',
      )[1];
      ch.reply({
        kind: 'cap',
        id: 2,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'hi', idempotencyKey: 'custom-1' }],
        dispatchId: msg2.dispatchId,
      });
      ch.reply({
        kind: 'cap',
        id: 3,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'hi', idempotencyKey: 'custom-2' }],
        dispatchId: msg2.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenCalledTimes(3);
      ch.reply({ kind: 'webhook-result', id: msg2.id, status: 200 });
      await expect(attempt2).resolves.toMatchObject({ ok: true, status: 200 });
    });

    it('isolates distinct dedupKey values sharing a provider deliveryId (dedupBodyMismatchAsNew) while deduplicating retries', async () => {
      const ch = new FakeChannel();
      const dispatcher = jest
        .fn()
        .mockResolvedValueOnce({ messageId: 'wamid-body-1' })
        .mockResolvedValueOnce({ messageId: 'wamid-body-2' });
      const host = new PluginWorkerHost(ch, dispatcher);

      const common = {
        instanceId: 'inst-1',
        route: 'chatwoot',
        method: 'POST',
        headers: {},
        query: {},
        body: '{}',
        rawBody: '{}',
        verified: true,
        deliveryId: 'provider-shared',
        sessionId: 'sess-1',
        timeoutMs: 5000,
      };

      const d1 = host.dispatchWebhook({ ...common, dedupKey: 'provider-shared:hash-a' });
      const w1 = ch.sent.filter((m): m is Extract<HostToWorkerMessage, { kind: 'webhook' }> => m.kind === 'webhook')[0];
      ch.reply({
        kind: 'cap',
        id: 1,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'first body' }],
        dispatchId: w1.dispatchId,
      });
      await flush();
      ch.reply({ kind: 'webhook-result', id: w1.id, status: 500, error: 'transient failure' });
      await expect(d1).resolves.toMatchObject({ ok: false, status: 500 });

      // Retry of hash-a must deduplicate, while distinct body hash-b with the same deliveryId runs fresh.
      const d1Retry = host.dispatchWebhook({ ...common, dedupKey: 'provider-shared:hash-a' });
      const w1Retry = ch.sent.filter(
        (m): m is Extract<HostToWorkerMessage, { kind: 'webhook' }> => m.kind === 'webhook',
      )[1];
      ch.reply({
        kind: 'cap',
        id: 2,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'first body' }],
        dispatchId: w1Retry.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenCalledTimes(1);
      ch.reply({ kind: 'webhook-result', id: w1Retry.id, status: 200 });
      await expect(d1Retry).resolves.toMatchObject({ ok: true, status: 200 });

      const d2 = host.dispatchWebhook({ ...common, dedupKey: 'provider-shared:hash-b' });
      const w2 = ch.sent.filter((m): m is Extract<HostToWorkerMessage, { kind: 'webhook' }> => m.kind === 'webhook')[2];
      ch.reply({
        kind: 'cap',
        id: 3,
        verb: 'conversation.send',
        args: [{ sessionId: 'sess-1', chatId: '123@c.us', type: 'text', text: 'second body' }],
        dispatchId: w2.dispatchId,
      });
      await flush();
      expect(dispatcher).toHaveBeenCalledTimes(2);
      ch.reply({ kind: 'webhook-result', id: w2.id, status: 200 });
      await expect(d2).resolves.toMatchObject({ ok: true, status: 200 });
    });
  });
});
