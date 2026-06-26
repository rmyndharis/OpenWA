import { PluginWorkerHost } from './plugin-worker-host';
import { PluginWorkerChannel, HostToWorkerMessage, WorkerToHostMessage } from './protocol';

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

      expect(dispatcher).toHaveBeenCalledWith('messages.sendText', ['s1', 'c1', 'hi']);
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

      await expect(pending).resolves.toEqual({ continue: true });
      expect(onTimeout).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('drains an in-flight hook immediately on worker exit (no stall for the full hook timeout)', async () => {
      const ch = new FakeChannel();
      const host = new PluginWorkerHost(ch);

      // A long timeout: only the worker-exit drain (not the timer) can settle this promptly.
      const pending = host.dispatchHook({ event: 'message:received', data: {}, source: 'Engine', timeoutMs: 5000 });
      ch.crash(1);

      await expect(pending).resolves.toEqual({ continue: true });
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
      new PluginWorkerHost(ch, undefined, undefined, onLog);

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
});
