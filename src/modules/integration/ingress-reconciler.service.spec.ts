import { DataSource, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { PluginInstance } from './entities/plugin-instance.entity';
import { IngressReconcilerService, IngressReconcilerOptions } from './ingress-reconciler.service';
import { IngressEnqueueService, sanitizeIngressJobId } from './ingress-enqueue.service';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { RedriveService } from './redrive.service';
import { INGRESS_DISPATCH_TIMEOUT_MS } from './integration.constants';
import { IngressJobData } from '../queue/processors/ingress.processor';
import { ConfigService } from '@nestjs/config';

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
      entities: [IngressEvent, IntegrationDeliveryFailure, PluginInstance],
      synchronize: true,
    });
    await ds.initialize();
    events = ds.getRepository(IngressEvent);
    failures = ds.getRepository(IntegrationDeliveryFailure);
    await ds
      .getRepository(PluginInstance)
      .save({ id: 'plug:inst', pluginId: 'plug', instanceId: 'inst', secret: 's', enabled: true });
    enqueue = jest.fn().mockResolvedValue({ outcome: 'queued' });
    getPlugin = jest.fn().mockReturnValue(undefined);
    resolveInstance = jest.fn().mockResolvedValue({ enabled: true });
    service = new IngressReconcilerService(
      events,
      failures,
      { enqueue, existingJobState: jest.fn().mockResolvedValue(undefined) } as unknown as IngressEnqueueService,
      { getPlugin } as unknown as PluginLoaderService,
      { resolve: resolveInstance } as unknown as PluginInstanceService,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
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

  it('replays the persisted HTTP method, and carries it into the dead-letter row', async () => {
    await insertEvent({
      payload: { headers: {}, query: {}, body: '{}', rawBody: '{}', method: 'PUT' },
      dispatchAttempts: 4,
    });
    enqueue.mockResolvedValue({ outcome: 'failed', error: 'sandbox 5xx' });

    await service.sweep(OPTS);

    const [data] = enqueuedJobs()[0];
    expect(data.method).toBe('PUT');
    expect(data.payload).toEqual({ headers: {}, query: {}, body: '{}', rawBody: '{}' });
    const [dlq] = await failures.find({ where: { deliveryId: 'd-1' } });
    expect((dlq.payload as { method?: string }).method).toBe('PUT');
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

    expect(stats).toMatchObject({ scanned: 0, skipped: 0 }); // filtered out before it can hold a batch slot
    expect(enqueue).not.toHaveBeenCalled();
    const event = await stored(id);
    expect(event.dispatchState).toBe('pending');
    expect(event.dispatchAttempts).toBe(0);
  });

  it('does not let rows it cannot replay starve a later row of an enabled instance', async () => {
    await ds
      .getRepository(PluginInstance)
      .save({ id: 'plug:off', pluginId: 'plug', instanceId: 'off', secret: 's', enabled: false });
    resolveInstance.mockImplementation((_p: string, i: string) =>
      Promise.resolve(i === 'off' ? { enabled: false } : { enabled: true }),
    );
    const disabled = await insertEvent({ instanceId: 'off', createdAt: minutesAgo(10) });
    await insertEvent({ instanceId: 'gone', createdAt: minutesAgo(9) }); // instance deleted
    await insertEvent({ payload: null, createdAt: minutesAgo(8) });
    const live = await insertEvent({ createdAt: minutesAgo(5) });

    const stats = await service.sweep({ ...OPTS, batchSize: 3 });

    expect(stats.replayed).toBe(1);
    expect(enqueuedJobs().map(([d]) => d.instanceId)).toEqual(['inst']);
    expect((await stored(live)).dispatchState).toBe('dispatched');
    expect((await stored(disabled)).dispatchState).toBe('pending'); // replayed once re-enabled
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

  it('writes no redrivable DLQ row when the live-path row is redriven during the final replay', async () => {
    const id = await insertEvent({ dispatchAttempts: 4 });
    const live = await failures.save(
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
    // An operator redrive delivers the live-path row while this replay is failing: it closes the
    // pending event, then the row (RedriveService's order).
    enqueue.mockImplementation(async () => {
      await events.update({ id, dispatchState: 'pending' }, { dispatchState: 'dispatched', payload: null });
      await failures.update({ id: live.id }, { redriven: true });
      return { outcome: 'failed', error: 'still down' };
    });

    await service.sweep(OPTS);

    expect((await stored(id)).dispatchState).toBe('dispatched');
    expect(await failures.count({ where: { deliveryId: 'd-1', redriven: false } })).toBe(0);
  });

  it('writes a redrivable DLQ row on terminal failure when the only row for the id was already redriven', async () => {
    // An earlier delivery under the same id was dead-lettered and redriven; its event row aged out of
    // the dedup window, so the id was accepted again and this new event exhausted its replay budget.
    const old = await failures.save(
      failures.create({
        direction: 'inbound',
        pluginId: 'plug',
        instanceId: 'inst',
        sessionId: 'sess-1',
        deliveryId: 'd-1',
        attempts: 1,
        lastError: 'inline dispatch failed',
        payload: null,
        redriven: true,
      }),
    );
    const id = await insertEvent({ dispatchAttempts: 4 });
    enqueue.mockResolvedValue({ outcome: 'failed', error: 'sandbox 5xx' });

    await service.sweep(OPTS);

    const event = await stored(id);
    expect(event.dispatchState).toBe('failed');
    expect(event.payload).toBeNull();
    const open = await failures.find({ where: { deliveryId: 'd-1', redriven: false } });
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(old.id);
    expect(open[0]).toMatchObject({ attempts: 5, lastError: 'sandbox 5xx' });
    expect(open[0].payload).toMatchObject({ route: 'chatwoot', ingress: { rawBody: '{}' } });
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

  // The live path's add() succeeded but its outcome mark was lost, and the job then failed every
  // attempt: IngressProcessor already dead-lettered it. A replay under the same jobId is swallowed by
  // BullMQ as a duplicate (add() still resolves), so it must not count as delivered.
  describe('when the live path already queued a job for the delivery', () => {
    let queue: { add: jest.Mock; getJobState: jest.Mock; waitUntilReady: jest.Mock };

    beforeEach(() => {
      queue = {
        add: jest.fn().mockResolvedValue(undefined),
        getJobState: jest.fn(),
        waitUntilReady: jest.fn().mockResolvedValue(undefined),
      };
      const realEnqueue = new IngressEnqueueService(
        { dispatchWebhookForInstance: jest.fn() } as unknown as PluginLoaderService,
        { get: jest.fn().mockReturnValue(true) } as unknown as ConfigService,
        queue as never,
      );
      service = new IngressReconcilerService(
        events,
        failures,
        realEnqueue,
        { getPlugin } as unknown as PluginLoaderService,
        { resolve: resolveInstance } as unknown as PluginInstanceService,
      );
    });

    const processorDeadLetter = () =>
      failures.save(
        failures.create({
          direction: 'inbound',
          pluginId: 'plug',
          instanceId: 'inst',
          sessionId: 'sess-1',
          deliveryId: 'd-1',
          attempts: 3,
          lastError: 'no live sandbox host',
          payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
          redriven: false,
        }),
      );

    it('keeps the dead-letter row of a failed job redrivable and does not re-add the job', async () => {
      const id = await insertEvent();
      const dlq = await processorDeadLetter();
      queue.getJobState.mockResolvedValue('failed');

      const stats = await service.sweep(OPTS);

      expect(queue.getJobState).toHaveBeenCalledWith(sanitizeIngressJobId('d-1', 'plug\u0000inst'));
      expect(queue.add).not.toHaveBeenCalled();
      expect(stats).toMatchObject({ scanned: 1, replayed: 0, failed: 1 });
      expect((await failures.findOneByOrFail({ id: dlq.id })).redriven).toBe(false);
      expect(await failures.count({ where: { deliveryId: 'd-1' } })).toBe(1);
      const event = await stored(id);
      expect(event.dispatchState).toBe('failed');
      expect(event.payload).toBeNull();
    });

    it('writes the dead-letter row itself when the failed job left none, before retiring the payload', async () => {
      const id = await insertEvent();
      queue.getJobState.mockResolvedValue('failed');

      await service.sweep(OPTS);

      const [row] = await failures.find({ where: { deliveryId: 'd-1' } });
      expect(row).toMatchObject({ direction: 'inbound', redriven: false });
      expect(row.payload).toMatchObject({ route: 'chatwoot', ingress: { rawBody: '{}' } });
      expect((await stored(id)).dispatchState).toBe('failed');
    });

    it('writes its own dead-letter row when the only row for the id was already redriven', async () => {
      await failures.save(
        failures.create({
          direction: 'inbound',
          pluginId: 'plug',
          instanceId: 'inst',
          sessionId: 'sess-1',
          deliveryId: 'd-1',
          attempts: 3,
          lastError: 'no live sandbox host',
          payload: null,
          redriven: true,
        }),
      );
      const id = await insertEvent();
      queue.getJobState.mockResolvedValue('failed');

      await service.sweep(OPTS);

      const open = await failures.find({ where: { deliveryId: 'd-1', redriven: false } });
      expect(open).toHaveLength(1);
      expect(open[0].payload).toMatchObject({ route: 'chatwoot', ingress: { rawBody: '{}' } });
      expect((await stored(id)).dispatchState).toBe('failed');
    });

    it('retires its dead-letter row when a re-queued copy settles the event during the sweep', async () => {
      const id = await insertEvent();
      // The copy dispatches after the state read, before the dead-letter write, while no row is open.
      queue.getJobState.mockImplementation(async () => {
        await events.update({ id }, { dispatchState: 'dispatched', payload: null });
        return 'failed';
      });

      await service.sweep(OPTS);

      expect((await stored(id)).dispatchState).toBe('dispatched');
      expect(await failures.count({ where: { deliveryId: 'd-1', redriven: false } })).toBe(0);
    });

    it('keeps the dead-letter row open when another sweep already marked the event failed', async () => {
      const id = await insertEvent();
      queue.getJobState
        .mockImplementationOnce(async () => {
          await processorDeadLetter();
          await events.update({ id }, { dispatchState: 'failed', payload: null });
          return 'failed';
        })
        .mockResolvedValue('unknown');

      await service.sweep(OPTS);

      expect((await stored(id)).dispatchState).toBe('failed');
      expect(await failures.count({ where: { deliveryId: 'd-1', redriven: false } })).toBe(1);
    });

    // 'dispatched' does not mean delivered: another node can mark it for a job that was still live, and
    // the job can then spend its attempts and be dead-lettered by the processor.
    it('keeps the processor dead-letter row open when the event was marked dispatched for a job that failed', async () => {
      const id = await insertEvent();
      queue.getJobState
        .mockImplementationOnce(async () => {
          await events.update({ id }, { dispatchState: 'dispatched', payload: null });
          await processorDeadLetter();
          return 'failed';
        })
        .mockResolvedValue('unknown');

      const stats = await service.sweep(OPTS);

      expect(stats).toMatchObject({ scanned: 1, replayed: 0, failed: 1 });
      expect(await failures.count({ where: { deliveryId: 'd-1', redriven: false } })).toBe(1);
    });

    it('leaves a delivery to its live re-queued copy instead of writing a dead-letter row', async () => {
      const id = await insertEvent();
      const base = sanitizeIngressJobId('d-1', 'plug\u0000inst');
      queue.getJobState.mockImplementation((jobId: string) =>
        Promise.resolve(jobId === `${base}-requeued-1` ? 'delayed' : 'failed'),
      );

      const stats = await service.sweep(OPTS);

      expect(queue.add).not.toHaveBeenCalled();
      expect(stats.replayed).toBe(1);
      expect(await failures.count({ where: { deliveryId: 'd-1' } })).toBe(0);
      expect((await stored(id)).dispatchState).toBe('dispatched');
    });

    it('does not re-add a pruned original job while its re-queued copy is live', async () => {
      await insertEvent();
      const base = sanitizeIngressJobId('d-1', 'plug\u0000inst');
      queue.getJobState.mockImplementation((jobId: string) =>
        Promise.resolve(jobId === `${base}-requeued-2` ? 'waiting' : 'unknown'),
      );

      await service.sweep(OPTS);

      expect(queue.add).not.toHaveBeenCalled();
    });

    it('does not re-add a job that is still live, and closes the event row', async () => {
      const id = await insertEvent();
      queue.getJobState.mockResolvedValue('delayed');

      const stats = await service.sweep(OPTS);

      expect(queue.add).not.toHaveBeenCalled();
      expect(stats.replayed).toBe(1);
      expect((await stored(id)).dispatchState).toBe('dispatched');
    });

    it('re-adds the job when the queue holds none for the delivery', async () => {
      const id = await insertEvent();
      queue.getJobState.mockResolvedValue('unknown');

      await service.sweep(OPTS);

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect((await stored(id)).dispatchState).toBe('dispatched');
    });
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

  // Plugin sandboxes stop right after this module is torn down: a replay landing later fails,
  // spends an attempt, and dead-letters a row on its last one.
  it('stops a running sweep on destroy and finishes the replay in hand before destroy resolves', async () => {
    const first = await insertEvent({ createdAt: minutesAgo(6) });
    const rest = [await insertEvent(), await insertEvent({ dispatchAttempts: 4 })];
    let dispatching!: () => void;
    const started = new Promise<void>(resolve => (dispatching = resolve));
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    enqueue.mockImplementationOnce(async () => {
      dispatching();
      await held;
      return { outcome: 'queued' };
    });
    enqueue.mockResolvedValue({ outcome: 'failed', error: 'no live sandbox host' });

    const sweep = service.sweep(OPTS);
    await started;
    const destroyed = service.onModuleDestroy();
    release();
    await destroyed;
    const firstAtDestroy = (await stored(first)).dispatchState;
    const stats = await sweep;

    expect(firstAtDestroy).toBe('dispatched');
    expect(stats).toMatchObject({ scanned: 1, replayed: 1, failed: 0 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    for (const [i, id] of rest.entries()) {
      const event = await stored(id);
      expect(event.dispatchState).toBe('pending');
      expect(event.dispatchAttempts).toBe([0, 4][i]);
    }
    expect(await failures.count()).toBe(0);
  });

  // The queue add in hand can be refused once teardown closes its connection, and the inline fallback
  // then runs against plugins being stopped: neither failure may spend the row's last attempt.
  it('spends no attempt on a replay that fails after destroy began', async () => {
    const id = await insertEvent({ dispatchAttempts: 4 });
    let dispatching!: () => void;
    const started = new Promise<void>(resolve => (dispatching = resolve));
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    enqueue.mockImplementationOnce(async () => {
      dispatching();
      await held;
      return { outcome: 'failed', error: 'no live sandbox host' };
    });

    const sweep = service.sweep(OPTS);
    await started;
    const destroyed = service.onModuleDestroy();
    release();
    await destroyed;
    const stats = await sweep;

    expect(stats).toMatchObject({ scanned: 1, replayed: 0, failed: 0, skipped: 1 });
    expect(await stored(id)).toMatchObject({ dispatchState: 'pending', dispatchAttempts: 4 });
    expect((await stored(id)).payload).not.toBeNull();
    expect(await failures.count()).toBe(0);
  });

  // A job-state lookup against a stalled Redis may only return once the queue connection is closed
  // later in shutdown. Waiting for it kept every later destroy hook from running; dispatching
  // once it returns would land after plugin teardown and dead-letter a row on its last attempt.
  it('stops waiting for a job-state lookup that does not return, and leaves its row pending', async () => {
    const id = await insertEvent({ dispatchAttempts: 4 });
    let lookedUp!: () => void;
    const reached = new Promise<void>(resolve => (lookedUp = resolve));
    let closeConnection!: (error: Error) => void;
    const getJobState = jest.fn(() => {
      lookedUp();
      return new Promise<never>((_resolve, reject) => (closeConnection = reject));
    });
    const dispatchWebhookForInstance = jest.fn().mockRejectedValue(new Error('no live sandbox host'));
    service = new IngressReconcilerService(
      events,
      failures,
      new IngressEnqueueService(
        { dispatchWebhookForInstance } as unknown as PluginLoaderService,
        { get: jest.fn().mockReturnValue(true) } as unknown as ConfigService,
        {
          getJobState,
          add: jest.fn().mockRejectedValue(new Error('Connection is closed')),
          waitUntilReady: jest.fn().mockResolvedValue(undefined),
        } as never,
      ),
      { getPlugin } as unknown as PluginLoaderService,
      { resolve: resolveInstance } as unknown as PluginInstanceService,
    );

    const sweep = service.sweep(OPTS);
    await reached;
    let destroyed = false;
    let destroyedBeforeDeadline: boolean;
    let destroyedAtDeadline: boolean;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      void service.onModuleDestroy().then(() => (destroyed = true));
      await jest.advanceTimersByTimeAsync(INGRESS_DISPATCH_TIMEOUT_MS - 1);
      await new Promise(setImmediate);
      destroyedBeforeDeadline = destroyed;
      await jest.advanceTimersByTimeAsync(1);
      await new Promise(setImmediate);
      destroyedAtDeadline = destroyed;
    } finally {
      jest.useRealTimers();
    }
    closeConnection(new Error('Connection is closed'));
    const stats = await sweep;

    expect(destroyedBeforeDeadline).toBe(false);
    expect(destroyedAtDeadline).toBe(true);
    expect(stats).toMatchObject({ replayed: 0, failed: 0, skipped: 1 });
    expect(dispatchWebhookForInstance).not.toHaveBeenCalled();
    expect(await stored(id)).toMatchObject({ dispatchState: 'pending', dispatchAttempts: 4 });
    expect((await stored(id)).payload).not.toBeNull();
    expect(await failures.count()).toBe(0);
  });

  // A queue add held by a stalled Redis can fail after destroy has begun. Its inline fallback would then
  // race plugin teardown and, on the row's last attempt, dead-letter it.
  it('does not dispatch inline when the queue add fails after shutdown began', async () => {
    const id = await insertEvent({ dispatchAttempts: 4 });
    let failAdd!: (error: Error) => void;
    let onAdd!: () => void;
    const adding = new Promise<void>(resolve => (onAdd = resolve));
    const queue = {
      getJobState: jest.fn().mockResolvedValue('unknown'),
      add: jest.fn(() => {
        onAdd();
        return new Promise<never>((_resolve, reject) => (failAdd = reject));
      }),
      waitUntilReady: jest.fn().mockResolvedValue(undefined),
    };
    const dispatchWebhookForInstance = jest.fn().mockRejectedValue(new Error('no live sandbox host'));
    service = new IngressReconcilerService(
      events,
      failures,
      new IngressEnqueueService(
        { dispatchWebhookForInstance } as unknown as PluginLoaderService,
        { get: jest.fn().mockReturnValue(true) } as unknown as ConfigService,
        queue as never,
      ),
      { getPlugin } as unknown as PluginLoaderService,
      { resolve: resolveInstance } as unknown as PluginInstanceService,
    );

    const sweep = service.sweep(OPTS);
    await adding;
    const destroyed = service.onModuleDestroy();
    failAdd(new Error('Connection is closed.'));
    const stats = await sweep;
    await destroyed;

    expect(stats).toMatchObject({ replayed: 0, failed: 0, skipped: 1 });
    expect(dispatchWebhookForInstance).not.toHaveBeenCalled();
    expect(await stored(id)).toMatchObject({ dispatchState: 'pending', dispatchAttempts: 4 });
    expect((await stored(id)).payload).not.toBeNull();
    expect(await failures.count()).toBe(0);
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

  it('does not schedule a timer when INGRESS_RECONCILE_INTERVAL_MS=0', () => {
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
      void svc.onModuleDestroy();
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
      void svc.onModuleDestroy();
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
      void svc.onModuleDestroy();
      sweepSpy.mockClear();
      jest.advanceTimersByTime(60_000);
      expect(sweepSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
