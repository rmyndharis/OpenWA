import { DataSource, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IngressReconcilerService, IngressReconcilerOptions } from './ingress-reconciler.service';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { RedriveService } from './redrive.service';
import { IngressJobData } from '../queue/processors/ingress.processor';

const OPTS: IngressReconcilerOptions = { intervalMs: 60_000, graceMs: 60_000, batchSize: 50, maxAttempts: 5 };

const minutesAgo = (m: number): Date => new Date(Date.now() - m * 60_000);
const secondsAgo = (s: number): Date => new Date(Date.now() - s * 1000);

describe('IngressReconcilerService.sweep', () => {
  let ds: DataSource;
  let events: Repository<IngressEvent>;
  let failures: Repository<IntegrationDeliveryFailure>;
  let enqueue: jest.Mock;
  let getPlugin: jest.Mock;
  let resolveInstance: jest.Mock;
  let service: IngressReconcilerService;
  let seq: number;

  beforeEach(async () => {
    seq = 0;
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [IngressEvent, IntegrationDeliveryFailure],
      synchronize: true,
    });
    await ds.initialize();
    events = ds.getRepository(IngressEvent);
    failures = ds.getRepository(IntegrationDeliveryFailure);
    enqueue = jest.fn().mockResolvedValue({ outcome: 'queued' });
    getPlugin = jest.fn().mockReturnValue(undefined);
    resolveInstance = jest.fn().mockResolvedValue({ enabled: true });
    service = new IngressReconcilerService(
      events,
      failures,
      { enqueue } as unknown as IngressEnqueueService,
      { getPlugin } as unknown as PluginLoaderService,
      { resolve: resolveInstance } as unknown as PluginInstanceService,
    );
  });

  afterEach(async () => {
    service.onModuleDestroy();
    if (ds.isInitialized) await ds.destroy();
  });

  // queryBuilder insert (not repo.save) so createdAt is set explicitly and the test controls the
  // grace window rather than the @CreateDateColumn "now" default.
  const insertEvent = async (over: Partial<IngressEvent> = {}): Promise<string> => {
    const n = ++seq;
    await events
      .createQueryBuilder()
      .insert()
      .values({
        id: `ev-${n}`,
        instanceId: 'inst',
        pluginId: 'plug',
        providerDeliveryId: `d-${n}`,
        route: 'chatwoot',
        payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        sessionId: 'sess-1',
        dispatchState: 'pending',
        dispatchAttempts: 0,
        createdAt: minutesAgo(5),
        ...over,
      })
      .execute();
    return `ev-${n}`;
  };
  const stored = (id: string) => events.findOneByOrFail({ id });
  const enqueuedJobs = () => enqueue.mock.calls as Array<[IngressJobData, string]>;

  it('replays a stale pending event with its original deliveryId as jobId, then marks it dispatched', async () => {
    const id = await insertEvent();

    const stats = await service.sweep(OPTS);

    expect(stats).toMatchObject({ scanned: 1, replayed: 1, failed: 0 });
    expect(enqueuedJobs()).toHaveLength(1);
    const [data, jobId] = enqueuedJobs()[0];
    expect(jobId).toBe('d-1'); // idempotent against a job the crashed live path may have enqueued
    expect(data).toMatchObject({
      pluginId: 'plug',
      instanceId: 'inst',
      route: 'chatwoot',
      deliveryId: 'd-1',
      sessionId: 'sess-1',
      payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
    });
    const event = await stored(id);
    expect(event.dispatchState).toBe('dispatched');
    expect(event.lastDispatchAt).toBeInstanceOf(Date);
  });

  it('retires the row payload once the replay is dispatched (the job data already carried it)', async () => {
    const id = await insertEvent();

    await service.sweep(OPTS);

    // The replay itself was built from the full stored payload…
    expect(enqueuedJobs()[0][0].payload).toEqual({ headers: {}, query: {}, body: '{}', rawBody: '{}' });
    // …and the dedup row then slimmed down — the dispatch tier owns the payload from here.
    expect((await stored(id)).payload).toBeNull();
  });

  it('skips a pending row whose payload is gone (nothing to replay from) without burning its budget', async () => {
    const id = await insertEvent({ payload: null });

    const stats = await service.sweep(OPTS);

    expect(stats).toMatchObject({ scanned: 0, skipped: 1 });
    expect(enqueue).not.toHaveBeenCalled();
    const event = await stored(id);
    expect(event.dispatchState).toBe('pending');
    expect(event.dispatchAttempts).toBe(0);
  });

  it('re-derives the conversation lane from the manifest route instead of degrading per-instance', async () => {
    getPlugin.mockReturnValue({
      manifest: { ingress: [{ route: 'chatwoot', conversationId: { jsonPointer: '/conversation/id' } }] },
    });
    await insertEvent({ payload: { headers: {}, query: {}, body: '{}', rawBody: '{"conversation":{"id":"conv-9"}}' } });

    await service.sweep(OPTS);

    expect(enqueuedJobs()[0][0].providerConversationId).toBe('conv-9');
  });

  it('never touches dispatched or failed rows', async () => {
    await insertEvent({ dispatchState: 'dispatched' });
    await insertEvent({ dispatchState: 'failed', dispatchAttempts: 5 });

    const stats = await service.sweep(OPTS);

    expect(stats.scanned).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not sweep a pending row younger than the grace period', async () => {
    await insertEvent({ createdAt: secondsAgo(10) });

    const stats = await service.sweep(OPTS);

    expect(stats.scanned).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('cools down a row whose last attempt is still inside the grace window', async () => {
    await insertEvent({ createdAt: minutesAgo(5), lastDispatchAt: secondsAgo(10), dispatchAttempts: 1 });

    const stats = await service.sweep(OPTS);

    expect(stats).toMatchObject({ scanned: 0, skipped: 1 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('bounds the sweep to the batch size, oldest first', async () => {
    for (let i = 0; i < 5; i++) await insertEvent();
    const tight = { ...OPTS, batchSize: 3 };

    const stats = await service.sweep(tight);

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(stats.replayed).toBe(3);
    expect(await events.count({ where: { dispatchState: 'pending' } })).toBe(2);
  });

  it('keeps a failed replay pending under the attempt budget and writes no DLQ row yet', async () => {
    const id = await insertEvent();
    enqueue.mockResolvedValue({ outcome: 'failed', error: 'sandbox 5xx' });

    const stats = await service.sweep(OPTS);

    expect(stats).toMatchObject({ scanned: 1, replayed: 0, failed: 1 });
    const event = await stored(id);
    expect(event.dispatchState).toBe('pending');
    expect(event.dispatchAttempts).toBe(1);
    expect(event.payload).not.toBeNull(); // the next sweep replays from it
    expect(await failures.count()).toBe(0);
  });

  it('marks the row failed (terminal) at the attempt budget, writes exactly one DLQ row, and never re-queues it', async () => {
    const id = await insertEvent({ dispatchAttempts: 4 });
    enqueue.mockResolvedValue({ outcome: 'failed', error: 'sandbox 5xx' });

    await service.sweep(OPTS);

    const event = await stored(id);
    expect(event.dispatchState).toBe('failed');
    expect(event.dispatchAttempts).toBe(5);
    expect(event.payload).toBeNull(); // retired — the DLQ row is the payload's new home
    const dlq = await failures.find({ where: { deliveryId: 'd-1' } });
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({
      direction: 'inbound',
      pluginId: 'plug',
      instanceId: 'inst',
      sessionId: 'sess-1',
      attempts: 5,
      lastError: 'sandbox 5xx',
      redriven: false,
    });
    expect((dlq[0].payload as { route?: string })?.route).toBe('chatwoot');

    // Terminal rows are out of the reconciler's scope for good: the next sweep leaves them alone.
    enqueue.mockClear();
    const stats = await service.sweep(OPTS);
    expect(stats.scanned).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('writes the DLQ row BEFORE retiring the payload on terminal failure (redrive never loses the payload)', async () => {
    await insertEvent({ dispatchAttempts: 4 });
    enqueue.mockResolvedValue({ outcome: 'failed', error: 'sandbox 5xx' });
    const saveSpy = jest.spyOn(failures, 'save');
    const updateSpy = jest.spyOn(events, 'update');

    await service.sweep(OPTS);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.invocationCallOrder[0]).toBeLessThan(updateSpy.mock.invocationCallOrder[0]);
    saveSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it('does not write a second DLQ row when the live path already dead-lettered the delivery', async () => {
    await insertEvent({ dispatchAttempts: 4 });
    await failures.save(
      failures.create({
        direction: 'inbound',
        pluginId: 'plug',
        instanceId: 'inst',
        sessionId: 'sess-1',
        deliveryId: 'd-1',
        attempts: 1,
        lastError: 'inline dispatch failed',
        payload: null,
        redriven: false,
      }),
    );
    enqueue.mockResolvedValue({ outcome: 'failed', error: 'still down' });

    await service.sweep(OPTS);

    expect(await failures.count({ where: { deliveryId: 'd-1' } })).toBe(1);
  });

  it('retires the live-path DLQ row when the replay succeeds (no double delivery via redrive)', async () => {
    await insertEvent();
    const dlq = await failures.save(
      failures.create({
        direction: 'inbound',
        pluginId: 'plug',
        instanceId: 'inst',
        sessionId: 'sess-1',
        deliveryId: 'd-1',
        attempts: 1,
        lastError: 'inline dispatch failed',
        payload: null,
        redriven: false,
      }),
    );
    enqueue.mockResolvedValue({ outcome: 'dispatched' });

    await service.sweep(OPTS);

    expect((await failures.findOneByOrFail({ id: dlq.id })).redriven).toBe(true);
  });

  it('does not replay an event a manual redrive already delivered', async () => {
    // Live-path shape after a swallowed inline failure: the event row is still 'pending' and a DLQ
    // row carries the payload. A successful manual redrive must close the event row too, or this
    // sweep replays the same delivery a second time.
    const id = await insertEvent();
    await failures.save(
      failures.create({
        direction: 'inbound',
        pluginId: 'plug',
        instanceId: 'inst',
        sessionId: 'sess-1',
        deliveryId: 'd-1',
        attempts: 1,
        lastError: 'inline dispatch failed',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
        redriven: false,
      }),
    );
    const redrive = new RedriveService(failures, events, { enqueue } as unknown as IngressEnqueueService);

    const res = await redrive.redriveInstance('plug', 'inst', null);

    expect(res.redriven).toBe(1);
    expect((await stored(id)).dispatchState).toBe('dispatched');
    enqueue.mockClear();
    const stats = await service.sweep(OPTS);
    expect(stats.scanned).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skips a row whose instance was disabled after persist, and replays it once re-enabled', async () => {
    const id = await insertEvent();
    resolveInstance.mockResolvedValue({ enabled: false });

    const stats = await service.sweep(OPTS);

    expect(stats).toMatchObject({ scanned: 0, skipped: 1 });
    expect(enqueue).not.toHaveBeenCalled();
    const event = await stored(id);
    expect(event.dispatchState).toBe('pending');
    expect(event.dispatchAttempts).toBe(0); // an ineligible row does not burn its replay budget

    // The row is not terminal: a re-enabled instance receives the event on a later sweep.
    resolveInstance.mockResolvedValue({ enabled: true });
    const stats2 = await service.sweep(OPTS);
    expect(stats2.replayed).toBe(1);
    expect((await stored(id)).dispatchState).toBe('dispatched');
  });

  it('skips a row whose instance was deleted after persist', async () => {
    await insertEvent();
    resolveInstance.mockResolvedValue(null);

    const stats = await service.sweep(OPTS);

    expect(stats).toMatchObject({ scanned: 0, skipped: 1 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(await failures.count()).toBe(0);
  });

  it('keeps the batch alive when one row throws during bookkeeping', async () => {
    await insertEvent();
    await insertEvent();
    // First row's state update blows up; the second row must still be replayed.
    const updateSpy = jest
      .spyOn(events, 'update')
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValue({ affected: 1, raw: {}, generatedMaps: [] });

    const stats = await service.sweep(OPTS);

    expect(stats).toMatchObject({ replayed: 1, skipped: 1 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    updateSpy.mockRestore();
  });
});

describe('IngressReconcilerService.onModuleInit (scheduling)', () => {
  const original = process.env.INGRESS_RECONCILE_INTERVAL_MS;
  const repos = () =>
    [
      { find: jest.fn(), update: jest.fn() } as unknown as Repository<IngressEvent>,
      { update: jest.fn(), count: jest.fn(), save: jest.fn() } as unknown as Repository<IntegrationDeliveryFailure>,
    ] as const;

  afterEach(() => {
    if (original === undefined) delete process.env.INGRESS_RECONCILE_INTERVAL_MS;
    else process.env.INGRESS_RECONCILE_INTERVAL_MS = original;
  });

  it('does not schedule a timer when INGRESS_RECONCILE_INTERVAL_MS <= 0', () => {
    process.env.INGRESS_RECONCILE_INTERVAL_MS = '0';
    const [events, failures] = repos();
    const svc = new IngressReconcilerService(
      events,
      failures,
      {} as IngressEnqueueService,
      {} as PluginLoaderService,
      {} as PluginInstanceService,
    );

    jest.useFakeTimers();
    try {
      const sweepSpy = jest.spyOn(svc, 'sweep');
      svc.onModuleInit();
      jest.advanceTimersByTime(10 * 60_000);
      expect(sweepSpy).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a blank INGRESS_RECONCILE_INTERVAL_MS as unset and sweeps on the default interval', () => {
    process.env.INGRESS_RECONCILE_INTERVAL_MS = '';
    const [events, failures] = repos();
    const svc = new IngressReconcilerService(
      events,
      failures,
      {} as IngressEnqueueService,
      {} as PluginLoaderService,
      {} as PluginInstanceService,
    );

    jest.useFakeTimers();
    try {
      const sweepSpy = jest.spyOn(svc, 'sweep').mockResolvedValue({ scanned: 0, replayed: 0, failed: 0, skipped: 0 });
      svc.onModuleInit();
      jest.advanceTimersByTime(60_000);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      svc.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sweeps on the configured interval and stops after onModuleDestroy', () => {
    delete process.env.INGRESS_RECONCILE_INTERVAL_MS;
    const [events, failures] = repos();
    const svc = new IngressReconcilerService(
      events,
      failures,
      {} as IngressEnqueueService,
      {} as PluginLoaderService,
      {} as PluginInstanceService,
    );

    jest.useFakeTimers();
    try {
      const sweepSpy = jest.spyOn(svc, 'sweep').mockResolvedValue({ scanned: 0, replayed: 0, failed: 0, skipped: 0 });
      svc.onModuleInit();
      jest.advanceTimersByTime(60_000);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
      svc.onModuleDestroy();
      sweepSpy.mockClear();
      jest.advanceTimersByTime(60_000);
      expect(sweepSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
