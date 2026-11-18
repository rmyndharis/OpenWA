import { WebhookRegistry } from './worker-webhooks';
import type { HostToWorkerMessage, WorkerToHostMessage } from './protocol';

const collect = () => {
  const sent: WorkerToHostMessage[] = [];
  return { sent, post: (message: WorkerToHostMessage) => sent.push(message) };
};

const delivery = (route: string, id = 1): Extract<HostToWorkerMessage, { kind: 'webhook' }> => ({
  kind: 'webhook',
  id,
  instanceId: 'i',
  route,
  method: 'POST',
  headers: {},
  query: {},
  body: '',
  rawBody: '',
  verified: true,
  deliveryId: 'd',
});

describe('WebhookRegistry', () => {
  it('tells the host about a route once, however many times the plugin registers it', () => {
    const { sent, post } = collect();
    const registry = new WebhookRegistry(post);

    for (let i = 0; i < 1000; i++) registry.register('chatwoot', () => undefined);

    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual({ kind: 'webhook-subscribe', route: 'chatwoot' });
  });

  it('tells the host about each distinct route', () => {
    const { sent, post } = collect();
    const registry = new WebhookRegistry(post);

    registry.register('chatwoot', () => undefined);
    registry.register('typebot', () => undefined);
    registry.register('chatwoot', () => undefined);

    expect(sent).toEqual([
      { kind: 'webhook-subscribe', route: 'chatwoot' },
      { kind: 'webhook-subscribe', route: 'typebot' },
    ]);
  });

  it('runs the handler registered last for a route', async () => {
    const { sent, post } = collect();
    const registry = new WebhookRegistry(post);
    const first = jest.fn(() => ({ status: 201 }));
    const second = jest.fn(() => ({ status: 202, body: 'second' }));

    registry.register('chatwoot', first);
    registry.register('chatwoot', second);
    await registry.handleWebhook(delivery('chatwoot'));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({
      kind: 'webhook-result',
      id: 1,
      status: 202,
      headers: undefined,
      body: 'second',
    });
  });

  it('answers 404 for a route no handler was registered for', async () => {
    const { sent, post } = collect();
    const registry = new WebhookRegistry(post);

    await registry.handleWebhook(delivery('unknown', 7));

    expect(sent).toEqual([{ kind: 'webhook-result', id: 7, status: 404, error: 'no handler for route' }]);
  });
});
