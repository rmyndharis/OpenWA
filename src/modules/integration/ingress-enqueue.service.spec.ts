import { IngressEnqueueService } from './ingress-enqueue.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { ConfigService } from '@nestjs/config';

describe('IngressEnqueueService', () => {
  const data = {
    pluginId: 'chatwoot',
    instanceId: 'acct1',
    route: 'chatwoot',
    deliveryId: 'd1',
    sessionId: 'sess-1',
    payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
  };

  let loader: jest.Mocked<Partial<PluginLoaderService>>;
  let config: jest.Mocked<Partial<ConfigService>>;
  let queue: { add: jest.Mock };

  beforeEach(() => {
    loader = { dispatchWebhookForInstance: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
  });

  it('adds a job to the ingress queue with the given jobId when queueing is enabled and a queue is present', async () => {
    (config.get as jest.Mock).mockReturnValue(true);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, queue as never);

    await svc.enqueue(data, 'd1');

    expect(queue.add).toHaveBeenCalledWith('ingress', data, { jobId: 'd1' });
    expect(loader.dispatchWebhookForInstance).not.toHaveBeenCalled();
  });

  it('dispatches inline when queueing is disabled, even if a queue instance is present', async () => {
    (config.get as jest.Mock).mockReturnValue(false);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, queue as never);

    await svc.enqueue(data, 'd1');

    expect(queue.add).not.toHaveBeenCalled();
    expect(loader.dispatchWebhookForInstance).toHaveBeenCalledWith(data);
  });

  it('dispatches inline when no queue instance is injected (QUEUE_ENABLED unset)', async () => {
    (config.get as jest.Mock).mockReturnValue(true);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, undefined);

    await svc.enqueue(data, 'd1');

    expect(loader.dispatchWebhookForInstance).toHaveBeenCalledWith(data);
  });

  it('swallows an inline dispatch error and logs it rather than throwing (row already persisted for redrive)', async () => {
    (loader.dispatchWebhookForInstance as jest.Mock).mockRejectedValue(new Error('boom'));
    (config.get as jest.Mock).mockReturnValue(false);
    const svc = new IngressEnqueueService(loader as PluginLoaderService, config as ConfigService, undefined);

    await expect(svc.enqueue(data, 'd1')).resolves.toBeUndefined();
  });
});
