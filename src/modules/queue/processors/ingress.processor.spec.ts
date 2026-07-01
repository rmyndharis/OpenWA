import { IngressProcessor } from './ingress.processor';

function job(overrides = {}) {
  return {
    data: {
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      deliveryId: 'd1',
      payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
    },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  } as never;
}

describe('IngressProcessor', () => {
  it('dispatches the event into the worker via dispatchWebhook', async () => {
    const dispatchWebhook = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const loader = { dispatchWebhookForInstance: dispatchWebhook };
    const failures = { save: jest.fn() };
    const proc = new IngressProcessor(loader as never, failures as never, { execute: jest.fn() } as never);
    await proc.process(job());
    expect(dispatchWebhook).toHaveBeenCalled();
  });

  it('records a DLQ failure row and fires ingress:error on the final attempt', async () => {
    const loader = { dispatchWebhookForInstance: jest.fn().mockRejectedValue(new Error('boom')) };
    const failures = { save: jest.fn().mockResolvedValue(undefined) };
    const hooks = { execute: jest.fn().mockResolvedValue({ continue: true }) };
    const proc = new IngressProcessor(loader as never, failures as never, hooks as never);
    await expect(proc.process(job({ attemptsMade: 2, opts: { attempts: 3 } }))).rejects.toThrow('boom');
    expect(failures.save).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'inbound', deliveryId: 'd1', pluginId: 'chatwoot' }),
    );
    expect(hooks.execute).toHaveBeenCalledWith('ingress:error', expect.anything(), expect.anything());
  });
});
