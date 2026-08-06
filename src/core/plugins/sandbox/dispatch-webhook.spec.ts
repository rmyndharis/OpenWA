import { PluginWorkerHost } from './plugin-worker-host';
import { WebhookRegistry } from './worker-webhooks';
import { hookConfigStore } from './worker-hooks';

/**
 * A fake worker channel mirroring the IPC surface the host talks to. It conforms to
 * PluginWorkerChannel so the real PluginWorkerHost constructor accepts it (channel-only), and lets a
 * test drive the worker side: capture posted messages, replay a `webhook-result`, or simulate a crash.
 */
function fakeChannel() {
  const handlers: { message?: (m: unknown) => void; exit?: (code: number) => void } = {};
  const posted: unknown[] = [];
  return {
    posted,
    postMessage: (m: unknown) => {
      posted.push(m);
    },
    onMessage: (cb: (m: unknown) => void) => {
      handlers.message = cb;
    },
    onExit: (cb: (code: number) => void) => {
      handlers.exit = cb;
    },
    terminate: () => Promise.resolve(),
    emitMessage: (m: unknown) => handlers.message?.(m),
    emitExit: (code: number) => handlers.exit?.(code),
  };
}

const webhookOptions = () => ({
  instanceId: 'i',
  route: 'chatwoot',
  method: 'POST',
  headers: {},
  query: {},
  body: '{}',
  rawBody: '{}',
  verified: true,
  deliveryId: 'd1',
  timeoutMs: 1000,
});

describe('PluginWorkerHost.dispatchWebhook', () => {
  it('resolves with the worker webhook-result when the worker replies', async () => {
    const channel = fakeChannel();
    const host = new PluginWorkerHost(channel as never);
    const promise = host.dispatchWebhook(webhookOptions());

    const sent = channel.posted.find(m => (m as { kind: string }).kind === 'webhook') as { id: number };
    channel.emitMessage({ kind: 'webhook-result', id: sent.id, status: 200, body: 'ok' });

    await expect(promise).resolves.toMatchObject({ ok: true, status: 200, body: 'ok' });
  });

  it('fail-opens to 504 when the worker never replies before the timeout', async () => {
    jest.useFakeTimers();
    try {
      const host = new PluginWorkerHost(fakeChannel() as never);
      const promise = host.dispatchWebhook(webhookOptions());

      jest.advanceTimersByTime(1001);

      await expect(promise).resolves.toMatchObject({ ok: false, status: 504 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('invokes onTimeout when the fail-open timeout fires', async () => {
    jest.useFakeTimers();
    try {
      const onTimeout = jest.fn();
      const host = new PluginWorkerHost(fakeChannel() as never);
      const promise = host.dispatchWebhook({ ...webhookOptions(), onTimeout });

      jest.advanceTimersByTime(1001);
      await promise;

      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drains pending webhooks to 502 when the worker crashes mid-request', async () => {
    const channel = fakeChannel();
    const host = new PluginWorkerHost(channel as never);
    const promise = host.dispatchWebhook({ ...webhookOptions(), timeoutMs: 100000 });

    channel.emitExit(1);

    await expect(promise).resolves.toMatchObject({ ok: false, status: 502 });
  });

  it('surfaces a worker handler error as ok:false with the reported status', async () => {
    const channel = fakeChannel();
    const host = new PluginWorkerHost(channel as never);
    const promise = host.dispatchWebhook(webhookOptions());

    const sent = channel.posted.find(m => (m as { kind: string }).kind === 'webhook') as { id: number };
    channel.emitMessage({ kind: 'webhook-result', id: sent.id, status: 500, error: 'boom' });

    await expect(promise).resolves.toMatchObject({ ok: false, status: 500, error: 'boom' });
  });
});

describe('WebhookRegistry config scoping', () => {
  it('exposes the webhook message config via hookConfigStore during the handler', async () => {
    let seen: Record<string, unknown> | undefined;
    const reg = new WebhookRegistry(() => {});
    reg.register('r', () => {
      seen = hookConfigStore.getStore()?.config;
    });
    await reg.handleWebhook({
      kind: 'webhook',
      id: 1,
      instanceId: 'i',
      route: 'r',
      method: 'POST',
      headers: {},
      query: {},
      body: '',
      rawBody: '',
      verified: true,
      deliveryId: 'd',
      config: { baseUrl: 'https://x' },
    });
    expect(seen).toEqual({ baseUrl: 'https://x' });
  });
});
