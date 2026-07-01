import { RedriveService } from './redrive.service';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { Repository } from 'typeorm';

describe('RedriveService', () => {
  let repo: jest.Mocked<Partial<Repository<IntegrationDeliveryFailure>>>;
  let ingressEnqueue: jest.Mocked<Partial<IngressEnqueueService>>;

  beforeEach(() => {
    repo = { find: jest.fn(), update: jest.fn().mockResolvedValue(undefined) };
    ingressEnqueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
  });

  function makeSvc(): RedriveService {
    return new RedriveService(repo as Repository<IntegrationDeliveryFailure>, ingressEnqueue as IngressEnqueueService);
  }

  it('re-enqueues non-redriven inbound failures for an instance and marks them redriven', async () => {
    const rows = [
      {
        id: 'f1',
        direction: 'inbound',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd1',
        payload: {
          route: 'chatwoot',
          providerConversationId: 'conv-1',
          ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        },
        sessionId: 's',
        redriven: false,
      },
      {
        id: 'f2',
        direction: 'inbound',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd2',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
        sessionId: 's',
        redriven: false,
      },
    ];
    (repo.find as jest.Mock).mockResolvedValue(rows);
    const svc = makeSvc();

    const res = await svc.redriveInstance('p', 'i');

    expect(res.redriven).toBe(2);
    expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(2);
    expect(ingressEnqueue.enqueue).toHaveBeenNthCalledWith(
      1,
      {
        pluginId: 'p',
        instanceId: 'i',
        route: 'chatwoot',
        deliveryId: 'd1',
        sessionId: 's',
        providerConversationId: 'conv-1',
        payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
      },
      'redrive:f1',
    );
    expect(repo.update).toHaveBeenCalledWith({ id: 'f1' }, { redriven: true });
    expect(repo.update).toHaveBeenCalledWith({ id: 'f2' }, { redriven: true });
  });

  it('queries only non-redriven inbound rows for the instance and returns 0 when none are found', async () => {
    (repo.find as jest.Mock).mockResolvedValue([]);
    const svc = makeSvc();

    const res = await svc.redriveInstance('p', 'i');

    expect(repo.find).toHaveBeenCalledWith({
      where: { pluginId: 'p', instanceId: 'i', direction: 'inbound', redriven: false },
    });
    expect(res.redriven).toBe(0);
    expect(ingressEnqueue.enqueue).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('falls back to the failure row id as deliveryId when deliveryId is null', async () => {
    const rows = [
      {
        id: 'f3',
        direction: 'inbound',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: null,
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
        sessionId: null,
        redriven: false,
      },
    ];
    (repo.find as jest.Mock).mockResolvedValue(rows);
    const svc = makeSvc();

    await svc.redriveInstance('p', 'i');

    expect(ingressEnqueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'f3', sessionId: undefined }),
      'redrive:f3',
    );
  });
});
