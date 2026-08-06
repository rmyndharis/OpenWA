import { RedriveService } from './redrive.service';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { Repository } from 'typeorm';

describe('RedriveService', () => {
  let repo: jest.Mocked<Partial<Repository<IntegrationDeliveryFailure>>>;
  let events: jest.Mocked<Partial<Repository<IngressEvent>>>;
  let ingressEnqueue: jest.Mocked<Partial<IngressEnqueueService>>;

  beforeEach(() => {
    repo = { find: jest.fn(), update: jest.fn().mockResolvedValue(undefined), count: jest.fn().mockResolvedValue(0) };
    events = { update: jest.fn().mockResolvedValue(undefined) };
    ingressEnqueue = { enqueue: jest.fn().mockResolvedValue({ outcome: 'queued' }) };
  });

  function makeSvc(): RedriveService {
    return new RedriveService(
      repo as Repository<IntegrationDeliveryFailure>,
      events as Repository<IngressEvent>,
      ingressEnqueue as IngressEnqueueService,
    );
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

    const res = await svc.redriveInstance('p', 'i', null);

    expect(res.redriven).toBe(2);
    expect(res).toEqual({ redriven: 2, remaining: 0, batchSize: 100 });
    expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(2);
    expect(ingressEnqueue.enqueue).toHaveBeenNthCalledWith(
      1,
      {
        pluginId: 'p',
        instanceId: 'i',
        route: 'chatwoot',
        method: 'POST',
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

  it('retires the matching pending ingress_events row on a successful redrive (the reconciler must not replay it)', async () => {
    // A live-path inline failure leaves the event row 'pending' next to the DLQ row; marking only
    // the DLQ row redriven would let the reconciler sweep the event row and deliver it a second time.
    const rows = [
      {
        id: 'f1',
        direction: 'inbound',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd1',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
        sessionId: 's',
        redriven: false,
      },
    ];
    (repo.find as jest.Mock).mockResolvedValue(rows);
    const svc = makeSvc();

    const res = await svc.redriveInstance('p', 'i', null);

    expect(res.redriven).toBe(1);
    expect(events.update).toHaveBeenCalledTimes(1);
    const [criteria, patch] = (events.update as jest.Mock).mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(criteria).toEqual({ pluginId: 'p', instanceId: 'i', providerDeliveryId: 'd1', dispatchState: 'pending' });
    expect(patch).toMatchObject({ dispatchState: 'dispatched', payload: null });
    expect(patch.lastDispatchAt).toBeInstanceOf(Date);
  });

  it('leaves the row redrivable (does not mark redriven) when the inline re-dispatch is swallowed as failed', async () => {
    // A queue-disabled fallback that silently fails must NOT retire the DLQ row, or the event is lost
    // permanently with no way to redrive it again.
    const rows = [
      {
        id: 'f9',
        direction: 'inbound',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd9',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
        sessionId: 's',
        redriven: false,
      },
    ];
    (repo.find as jest.Mock).mockResolvedValue(rows);
    (ingressEnqueue.enqueue as jest.Mock).mockResolvedValue({ outcome: 'failed' });
    const svc = makeSvc();

    const res = await svc.redriveInstance('p', 'i', null);

    expect(res.redriven).toBe(0);
    expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith({ id: 'f9' }, { attempts: 1, lastError: 'redrive dispatch failed' });
    expect(events.update).not.toHaveBeenCalled(); // nothing was delivered, so the event row stays as-is
  });

  it('queries only non-redriven inbound rows for the instance and returns 0 when none are found', async () => {
    (repo.find as jest.Mock).mockResolvedValue([]);
    const svc = makeSvc();

    const res = await svc.redriveInstance('p', 'i', null);

    expect(repo.find).toHaveBeenCalledWith({
      where: { pluginId: 'p', instanceId: 'i', direction: 'inbound', redriven: false },
      order: { attempts: 'ASC', createdAt: 'ASC' },
      take: 100,
    });
    expect(res.redriven).toBe(0);
    expect(ingressEnqueue.enqueue).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('filters the DLQ batch by the session provenance so a rebind cannot replay foreign historical rows', async () => {
    // After an instance is rebound sess-old -> sess-current, a key scoped to sess-current must NOT
    // replay retained rows that still carry sessionId 'sess-old'. The authorized binding is threaded
    // in as a concrete filter that enters BOTH the find() and count() query — foreign rows neither
    // consume the batch nor leak through `remaining`.
    (repo.find as jest.Mock).mockResolvedValue([]);
    const svc = makeSvc();

    await svc.redriveInstance('p', 'i', 'sess-current');

    expect(repo.find).toHaveBeenCalledWith({
      where: {
        pluginId: 'p',
        instanceId: 'i',
        direction: 'inbound',
        redriven: false,
        sessionId: 'sess-current',
      },
      order: { attempts: 'ASC', createdAt: 'ASC' },
      take: 100,
    });
    const [countCall] = (repo.count as jest.Mock).mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(countCall.where).toMatchObject({ sessionId: 'sess-current' });
  });

  it('leaves the sessionId predicate ABSENT for an unrestricted (null) caller so legacy/null-session rows stay replayable', async () => {
    // null means the caller is unrestricted: the DLQ is drained across every sessionId, including
    // legacy rows written before sessionId provenance existed (sessionId null). The where object must
    // NOT carry a sessionId key at all — emitting `sessionId: null` would exclude those legacy rows.
    (repo.find as jest.Mock).mockResolvedValue([]);
    const svc = makeSvc();

    await svc.redriveInstance('p', 'i', null);

    expect(repo.find).toHaveBeenCalledWith({
      where: { pluginId: 'p', instanceId: 'i', direction: 'inbound', redriven: false },
      order: { attempts: 'ASC', createdAt: 'ASC' },
      take: 100,
    });
    const [countArg] = (repo.count as jest.Mock).mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(countArg.where).not.toHaveProperty('sessionId');
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

    await svc.redriveInstance('p', 'i', null);

    expect(ingressEnqueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'f3', sessionId: undefined }),
      'redrive:f3',
    );
    // A legacy row without a deliveryId predates persist-before-ack — there is no event row to retire.
    expect(events.update).not.toHaveBeenCalled();
  });
});
