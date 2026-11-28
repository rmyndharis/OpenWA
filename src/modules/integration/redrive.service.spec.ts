import { RedriveService } from './redrive.service';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressEvent } from './entities/ingress-event.entity';
import { Repository } from 'typeorm';
import { INGRESS_SHUTDOWN_WAIT_MS } from './integration.constants';
import { LoggerService } from '../../common/services/logger.service';

describe('RedriveService', () => {
  let repo: jest.Mocked<Partial<Repository<IntegrationDeliveryFailure>>>;
  let events: jest.Mocked<Partial<Repository<IngressEvent>>>;
  let ingressEnqueue: jest.Mocked<Partial<IngressEnqueueService>>;

  beforeEach(() => {
    repo = {
      find: jest.fn(),
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      increment: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
    };
    events = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    ingressEnqueue = { enqueue: jest.fn().mockResolvedValue({ outcome: 'queued' }) };
  });

  function setRows(rows: Array<{ id: string }>): void {
    (repo.find as jest.Mock).mockResolvedValue(rows.map(({ id }) => ({ id })));
    (repo.findOneBy as jest.Mock).mockImplementation((criteria: { id: string } | Array<{ id: string }>) =>
      Promise.resolve(rows.find(row => row.id === (Array.isArray(criteria) ? criteria[0].id : criteria.id)) ?? null),
    );
  }

  // What a redrive writes to take a row before its dispatch, and to retire it once the dispatch went out.
  const unclaimed = expect.objectContaining({ _type: 'raw' }) as unknown;
  const claim = (id: string) => [
    { id, redriven: false, claimedAt: unclaimed },
    { claimedAt: expect.any(Date) as Date },
  ];
  const retire = (id: string) => [{ id }, { redriven: true, claimedAt: null }];

  function makeSvc(): RedriveService {
    return new RedriveService(
      repo as Repository<IntegrationDeliveryFailure>,
      events as Repository<IngressEvent>,
      ingressEnqueue as IngressEnqueueService,
    );
  }

  it('redrives the rows it can read when one stored payload does not parse', async () => {
    const ingress = { headers: {}, query: {}, body: '{}', rawBody: '{}' };
    const healthy = { id: 'f2', pluginId: 'p', instanceId: 'i', deliveryId: 'd2', payload: { route: 'r', ingress } };
    (repo.find as jest.Mock).mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]);
    (repo.findOneBy as jest.Mock).mockRejectedValueOnce(new SyntaxError('bad json')).mockResolvedValueOnce(healthy);
    const logged = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);

    try {
      const res = await makeSvc().redriveInstance('p', 'i', null);

      expect(res.redriven).toBe(1);
      expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
      expect(repo.update).toHaveBeenCalledWith(...claim('f2'));
      // The unreadable row goes behind the readable ones, so a batch of them cannot starve the rest.
      expect(repo.increment).toHaveBeenCalledWith({ id: 'f1' }, 'attempts', 1);
      // Its id and the action are fields of the log line, as an alert on the action reads them: not
      // folded into the trace argument.
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('could not be read'),
        expect.any(String),
        expect.objectContaining({ id: 'f1', action: 'ingress_redrive_row_unreadable' }),
      );
    } finally {
      logged.mockRestore();
    }
  });

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
    setRows(rows);
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
      expect.stringMatching(/^redrive:f1:0:.+/),
      expect.any(AbortSignal),
    );
    expect((repo.update as jest.Mock).mock.calls).toEqual([claim('f1'), retire('f1'), claim('f2'), retire('f2')]);
  });

  it('takes the row and holds its pending event before the dispatch, then retires the row and drops the event payload', async () => {
    // A live-path inline failure leaves the event row 'pending' next to the DLQ row; taking only the DLQ row would let
    // the reconciler sweep the event and deliver it a second time.
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
    setRows(rows);
    const svc = makeSvc();

    const res = await svc.redriveInstance('p', 'i', null);

    expect(res.redriven).toBe(1);
    expect(events.update).toHaveBeenCalledTimes(2);
    const [[held, hold], [dropped, drop]] = (events.update as jest.Mock).mock.calls as [
      Record<string, unknown>,
      Record<string, unknown>,
    ][];
    expect(held).toEqual({ pluginId: 'p', instanceId: 'i', providerDeliveryId: 'd1', dispatchState: 'pending' });
    expect(hold).toEqual({ dispatchState: 'dispatched', lastDispatchAt: expect.any(Date) as Date });
    expect(dropped).toEqual({ pluginId: 'p', instanceId: 'i', providerDeliveryId: 'd1', dispatchState: 'dispatched' });
    expect(drop).toEqual({ payload: null });
    expect((repo.update as jest.Mock).mock.calls).toEqual([claim('f1'), retire('f1')]);
    const [holdOrder] = (events.update as jest.Mock).mock.invocationCallOrder;
    const [claimOrder, retireOrder] = (repo.update as jest.Mock).mock.invocationCallOrder;
    const [dispatchOrder] = (ingressEnqueue.enqueue as jest.Mock).mock.invocationCallOrder;
    expect(holdOrder).toBeLessThan(claimOrder);
    expect(claimOrder).toBeLessThan(dispatchOrder);
    expect(dispatchOrder).toBeLessThan(retireOrder);
  });

  it('counts a row redriven though the database refused the writes after its dispatch', async () => {
    setRows([
      {
        id: 'f6',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd6',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      } as { id: string },
    ]);
    // The hold goes through; dropping the event payload once the row went out does not.
    (events.update as jest.Mock)
      .mockResolvedValueOnce({ affected: 1 })
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    await expect(makeSvc().redriveInstance('p', 'i', null)).resolves.toEqual({
      redriven: 1,
      remaining: 0,
      batchSize: 100,
    });
    expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('puts back the row, with one more attempt, and its event when the inline re-dispatch fails', async () => {
    // A queue-disabled fallback that silently fails sent nothing: leaving the DLQ row retired would lose the event
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
    setRows(rows);
    (ingressEnqueue.enqueue as jest.Mock).mockResolvedValue({ outcome: 'failed' });
    const svc = makeSvc();

    const res = await svc.redriveInstance('p', 'i', null);

    expect(res.redriven).toBe(0);
    expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenLastCalledWith(
      { id: 'f9' },
      { claimedAt: null, attempts: 1, lastError: 'redrive dispatch failed' },
    );
    expect(events.update).toHaveBeenLastCalledWith(
      { pluginId: 'p', instanceId: 'i', providerDeliveryId: 'd9', dispatchState: 'dispatched' },
      { dispatchState: 'pending' },
    );
  });

  it('leaves an event it did not take as it was when the re-dispatch fails', async () => {
    setRows([
      {
        id: 'f8',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd8',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      } as { id: string },
    ]);
    // The reconciler had settled the event already: the hold took nothing.
    (events.update as jest.Mock).mockResolvedValueOnce({ affected: 0 });
    (ingressEnqueue.enqueue as jest.Mock).mockResolvedValue({ outcome: 'failed' });

    await makeSvc().redriveInstance('p', 'i', null);

    expect(events.update).toHaveBeenCalledTimes(1);
  });

  it('skips a row another redrive took between the read and the claim, and dispatches nothing', async () => {
    setRows([
      {
        id: 'f7',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd7',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      } as { id: string },
    ]);
    (repo.update as jest.Mock).mockResolvedValueOnce({ affected: 0 });

    const res = await makeSvc().redriveInstance('p', 'i', null);

    expect(res.redriven).toBe(0);
    expect(ingressEnqueue.enqueue).not.toHaveBeenCalled();
    // The other redrive dispatches the delivery: its event stays retired.
    expect(events.update).toHaveBeenCalledTimes(1);
  });

  it('queries only non-redriven inbound rows of the current binding and returns 0 when none are found', async () => {
    (repo.find as jest.Mock).mockResolvedValue([]);
    const svc = makeSvc();

    const res = await svc.redriveInstance('p', 'i', 'sess-current');

    // The binding enters BOTH the find() and the count() query: rows of an earlier binding neither consume
    // the batch nor leak through `remaining`, since dispatch refuses them and a replay would only fail again.
    // A row another redrive holds is left out of the window, but still counted as remaining.
    expect(repo.find).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        pluginId: 'p',
        instanceId: 'i',
        direction: 'inbound',
        redriven: false,
        sessionId: 'sess-current',
        claimedAt: unclaimed,
      },
      order: { attempts: 'ASC', createdAt: 'ASC' },
      take: 100,
    });
    expect(repo.count).toHaveBeenCalledWith({
      where: { pluginId: 'p', instanceId: 'i', direction: 'inbound', redriven: false, sessionId: 'sess-current' },
    });
    expect(res.redriven).toBe(0);
    expect(ingressEnqueue.enqueue).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it.each([null, '*'])('takes a row with no session or "*" for an instance bound to all sessions (%s)', async scope => {
    (repo.find as jest.Mock).mockResolvedValue([]);
    const svc = makeSvc();

    await svc.redriveInstance('p', 'i', scope);

    const base = { pluginId: 'p', instanceId: 'i', direction: 'inbound', redriven: false };
    const where = [
      { ...base, sessionId: expect.objectContaining({ _type: 'isNull' }) as unknown },
      { ...base, sessionId: '*' },
    ];
    expect(repo.find).toHaveBeenCalledWith({
      select: { id: true },
      where: where.map(scope => ({ ...scope, claimedAt: unclaimed })),
      order: { attempts: 'ASC', createdAt: 'ASC' },
      take: 100,
    });
    expect(repo.count).toHaveBeenCalledWith({ where });
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
    setRows(rows);
    const svc = makeSvc();

    await svc.redriveInstance('p', 'i', null);

    expect(ingressEnqueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: 'f3', sessionId: undefined }),
      expect.stringMatching(/^redrive:f3:0:.+/),
      expect.any(AbortSignal),
    );
    // A legacy row without a deliveryId predates persist-before-ack — there is no event row to retire.
    expect(events.update).not.toHaveBeenCalled();
  });

  it('dispatches nothing when the database refuses the claim, and hands back its error', async () => {
    const refused = new Error('Connection terminated unexpectedly');
    setRows([
      {
        id: 'f4',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: null,
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      } as { id: string },
    ]);
    (repo.update as jest.Mock).mockRejectedValueOnce(refused);

    await expect(makeSvc().redriveInstance('p', 'i', null)).rejects.toBe(refused);
    expect(ingressEnqueue.enqueue).not.toHaveBeenCalled();
  });

  it('hands the held event back to the reconciler when the claim of its row fails', async () => {
    const refused = new Error('Connection terminated unexpectedly');
    setRows([
      {
        id: 'f3',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd3',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      } as { id: string },
    ]);
    (repo.update as jest.Mock).mockRejectedValueOnce(refused);

    await expect(makeSvc().redriveInstance('p', 'i', null)).rejects.toBe(refused);

    expect(ingressEnqueue.enqueue).not.toHaveBeenCalled();
    expect(events.update).toHaveBeenLastCalledWith(
      { pluginId: 'p', instanceId: 'i', providerDeliveryId: 'd3', dispatchState: 'dispatched' },
      { dispatchState: 'pending' },
    );
  });

  it('keeps a row it put back redrivable though its event could not be handed back, and says so', async () => {
    setRows([
      {
        id: 'f2',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd2',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      } as { id: string },
    ]);
    (ingressEnqueue.enqueue as jest.Mock).mockResolvedValue({ outcome: 'failed' });
    (events.update as jest.Mock)
      .mockResolvedValueOnce({ affected: 1 })
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const warned = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);

    try {
      await expect(makeSvc().redriveInstance('p', 'i', null)).resolves.toMatchObject({ redriven: 0 });
      expect(repo.update).toHaveBeenLastCalledWith(
        { id: 'f2' },
        { claimedAt: null, attempts: 1, lastError: 'redrive dispatch failed' },
      );
      expect(warned).toHaveBeenCalledWith(
        expect.stringContaining('could not be handed back'),
        expect.objectContaining({
          id: 'f2',
          deliveryId: 'd2',
          error: 'Connection terminated unexpectedly',
          action: 'ingress_redrive_event_restore_failed',
        }),
      );
    } finally {
      warned.mockRestore();
    }
  });

  it('logs a put back the database refused with both ids, and never answers it as a success', async () => {
    const refused = new Error('Connection terminated unexpectedly');
    setRows([
      {
        id: 'f5',
        pluginId: 'p',
        instanceId: 'i',
        deliveryId: 'd5',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      } as { id: string },
    ]);
    (ingressEnqueue.enqueue as jest.Mock).mockResolvedValue({ outcome: 'failed' });
    (repo.update as jest.Mock).mockResolvedValueOnce({ affected: 1 }).mockRejectedValueOnce(refused);
    const logged = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);

    try {
      await expect(makeSvc().redriveInstance('p', 'i', null)).rejects.toBe(refused);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('could not be put back'),
        refused.message,
        expect.objectContaining({ id: 'f5', deliveryId: 'd5', action: 'ingress_redrive_put_back_failed' }),
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('mints a jobId of its own for each dispatch of a row', async () => {
    const row = {
      id: 'f-again',
      direction: 'inbound',
      pluginId: 'p',
      instanceId: 'i',
      deliveryId: 'd-again',
      payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      sessionId: 's',
      redriven: false,
      attempts: 0,
    };
    setRows([row]);
    // The first dispatch fails and the row is put back; the fake keeps reading it as it was.
    (ingressEnqueue.enqueue as jest.Mock).mockResolvedValueOnce({ outcome: 'failed' });
    const svc = makeSvc();

    await svc.redriveInstance('p', 'i', null);
    await expect(svc.redriveInstance('p', 'i', null)).resolves.toEqual({ redriven: 1, remaining: 0, batchSize: 100 });

    const calls = (ingressEnqueue.enqueue as jest.Mock).mock.calls as [unknown, string, AbortSignal][];
    expect(calls[0][1]).toMatch(/^redrive:f-again:0:.+/);
    expect(calls[1][1]).toMatch(/^redrive:f-again:0:.+/);
    expect(calls[1][1]).not.toBe(calls[0][1]);
  });

  describe('shutdown', () => {
    const failure = (id: string, deliveryId: string) => ({
      id,
      direction: 'inbound',
      pluginId: 'p',
      instanceId: 'i',
      deliveryId,
      payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      sessionId: 's',
      redriven: false,
      attempts: 0,
    });
    const tick = () => new Promise<void>(resolve => setImmediate(resolve));

    it('stops at the next row and leaves the rows it did not reach open and unchanged', async () => {
      setRows([failure('f1', 'd1'), failure('f2', 'd2'), failure('f3', 'd3')]);
      (repo.count as jest.Mock).mockResolvedValue(2);
      let finishFirst!: () => void;
      (ingressEnqueue.enqueue as jest.Mock).mockImplementationOnce(
        () => new Promise(resolve => (finishFirst = () => resolve({ outcome: 'queued' }))),
      );
      const svc = makeSvc();
      const running = svc.redriveInstance('p', 'i', null);
      while (!finishFirst) await tick();

      const destroyed = svc.onModuleDestroy();
      finishFirst();

      expect(await running).toEqual({ redriven: 1, remaining: 2, batchSize: 100 });
      await destroyed;
      expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
      expect((repo.update as jest.Mock).mock.calls).toEqual([claim('f1'), retire('f1')]);
    });

    it('puts back the row and event it took when its enqueue is refused because shutdown began', async () => {
      setRows([failure('f1', 'd1'), failure('f2', 'd2')]);
      (repo.count as jest.Mock).mockResolvedValue(2);
      const svc = makeSvc();
      let destroyed: Promise<void> | undefined;
      (ingressEnqueue.enqueue as jest.Mock).mockImplementationOnce(() => {
        destroyed = svc.onModuleDestroy();
        return Promise.reject(new Error('The operation was aborted'));
      });

      expect(await svc.redriveInstance('p', 'i', null)).toEqual({ redriven: 0, remaining: 2, batchSize: 100 });
      await destroyed;
      expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
      // Nothing went out, so nothing is counted as an attempt either.
      expect((repo.update as jest.Mock).mock.calls).toEqual([claim('f1'), [{ id: 'f1' }, { claimedAt: null }]]);
      expect(events.update).toHaveBeenLastCalledWith(
        { pluginId: 'p', instanceId: 'i', providerDeliveryId: 'd1', dispatchState: 'dispatched' },
        { dispatchState: 'pending' },
      );
    });

    it('still surfaces an enqueue failure that is not a shutdown', async () => {
      setRows([failure('f1', 'd1')]);
      (ingressEnqueue.enqueue as jest.Mock).mockRejectedValueOnce(new Error('database is gone'));

      await expect(makeSvc().redriveInstance('p', 'i', null)).rejects.toThrow('database is gone');
    });

    it('settles its teardown when the redrive it waits for fails', async () => {
      setRows([failure('f1', 'd1')]);
      // A read after the enqueue is not covered by the shutdown refusal above, so the run rejects.
      (repo.count as jest.Mock).mockRejectedValueOnce(new Error('database is gone'));
      let finishFirst!: () => void;
      (ingressEnqueue.enqueue as jest.Mock).mockImplementationOnce(
        () => new Promise(resolve => (finishFirst = () => resolve({ outcome: 'queued' }))),
      );
      const svc = makeSvc();
      const running = svc.redriveInstance('p', 'i', null);
      const failed = expect(running).rejects.toThrow('database is gone');
      while (!finishFirst) await tick();

      const destroyed = svc.onModuleDestroy();
      finishFirst();

      // A rejecting destroy hook makes Nest skip every later one (plugin onDisable, the DataSource close).
      await expect(destroyed).resolves.toBeUndefined();
      await failed;
    });

    it('waits at most the dispatch timeout for a replay still in hand', async () => {
      jest.useFakeTimers();
      try {
        setRows([failure('f1', 'd1')]);
        (ingressEnqueue.enqueue as jest.Mock).mockReturnValueOnce(new Promise(() => undefined));
        const svc = makeSvc();
        void svc.redriveInstance('p', 'i', null);
        await jest.advanceTimersByTimeAsync(0);
        let settled = false;
        const destroyed = svc.onModuleDestroy().then(() => (settled = true));

        await jest.advanceTimersByTimeAsync(INGRESS_SHUTDOWN_WAIT_MS - 1);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await destroyed;
        expect(settled).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('has nothing to wait for when no redrive is running', async () => {
      await expect(makeSvc().onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
