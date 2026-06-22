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
});
