import { DataSource, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IntegrationRetentionService } from './integration-retention.service';
import { IngressReconcilerService } from './ingress-reconciler.service';
import { IngressEnqueueService } from './ingress-enqueue.service';
import { INGRESS_DISPATCH_TIMEOUT_MS } from './integration.constants';
import { PluginInstanceService } from './plugin-instance.service';
import { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { Session } from '../session/entities/session.entity';
import { LoggerService } from '../../common/services/logger.service';

const daysAgo = (d: number): Date => {
  const dt = new Date();
  dt.setDate(dt.getDate() - d);
  return dt;
};

describe('IntegrationRetentionService.pruneOlderThan', () => {
  let ds: DataSource;
  let service: IntegrationRetentionService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [IngressEvent, IntegrationDeliveryFailure],
      synchronize: true,
    });
    await ds.initialize();
    service = new IntegrationRetentionService(
      ds.getRepository(IngressEvent),
      ds.getRepository(IntegrationDeliveryFailure),
      { deadLetterAgedPending: jest.fn().mockResolvedValue(0) } as unknown as IngressReconcilerService,
    );

    const events = ds.getRepository(IngressEvent);
    const failures = ds.getRepository(IntegrationDeliveryFailure);
    // Two old + two recent rows in each table. createdAt is set explicitly so the test controls the
    // window boundary rather than the @CreateDateColumn "now" default.
    await events
      .createQueryBuilder()
      .insert()
      .values([
        {
          id: 'ev-old-1',
          instanceId: 'i',
          pluginId: 'p',
          providerDeliveryId: 'd1',
          route: 'r',
          payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
          createdAt: daysAgo(30),
        },
        {
          id: 'ev-old-2',
          instanceId: 'i',
          pluginId: 'p',
          providerDeliveryId: 'd2',
          route: 'r',
          payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
          createdAt: daysAgo(15),
        },
        {
          id: 'ev-new-1',
          instanceId: 'i',
          pluginId: 'p',
          providerDeliveryId: 'd3',
          route: 'r',
          payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
          createdAt: daysAgo(3),
        },
        {
          id: 'ev-new-2',
          instanceId: 'i',
          pluginId: 'p',
          providerDeliveryId: 'd4',
          route: 'r',
          payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
          createdAt: daysAgo(1),
        },
      ])
      .execute();
    await failures
      .createQueryBuilder()
      .insert()
      .values([
        {
          direction: 'inbound',
          pluginId: 'p',
          instanceId: 'i',
          attempts: 1,
          lastError: 'x',
          redriven: false,
          createdAt: daysAgo(40),
        },
        {
          direction: 'outbound',
          pluginId: 'p',
          instanceId: 'i',
          attempts: 2,
          lastError: 'y',
          redriven: false,
          createdAt: daysAgo(20),
        },
        {
          direction: 'inbound',
          pluginId: 'p',
          instanceId: 'i',
          attempts: 1,
          lastError: 'z',
          redriven: false,
          createdAt: daysAgo(5),
        },
        {
          direction: 'inbound',
          pluginId: 'p',
          instanceId: 'i',
          attempts: 1,
          lastError: 'w',
          redriven: false,
          createdAt: daysAgo(2),
        },
      ])
      .execute();
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it('deletes only rows older than the window and keeps recent ones', async () => {
    const result = await service.pruneOlderThan(10);

    expect(result).toEqual({ events: 2, failures: 2 });

    const remainingEvents = await ds.getRepository(IngressEvent).find({ order: { id: 'ASC' } });
    const remainingFailures = await ds.getRepository(IntegrationDeliveryFailure).find({ order: { createdAt: 'ASC' } });
    expect(remainingEvents.map(e => e.id)).toEqual(['ev-new-1', 'ev-new-2']);
    expect(remainingFailures).toHaveLength(2);
    expect(remainingFailures.every(f => f.createdAt > daysAgo(10))).toBe(true);
  });

  it('applies independent windows per table (dedup short, failures long)', async () => {
    // Events older than 2d: 30d/15d/3d (3 rows). Failures older than 10d: 40d/20d (2 rows).
    const result = await service.pruneOlderThan(2, 10);

    expect(result).toEqual({ events: 3, failures: 2 });
    expect((await ds.getRepository(IngressEvent).find({ order: { id: 'ASC' } })).map(e => e.id)).toEqual(['ev-new-2']);
    expect(await ds.getRepository(IntegrationDeliveryFailure).count()).toBe(2);
  });

  it('skips the failures prune entirely when the failures window is null', async () => {
    const result = await service.pruneOlderThan(2, null);

    expect(result).toEqual({ events: 3, failures: 0 });
    expect(await ds.getRepository(IntegrationDeliveryFailure).count()).toBe(4);
  });

  it('deletes nothing when the window exceeds every row age', async () => {
    const result = await service.pruneOlderThan(365);
    expect(result).toEqual({ events: 0, failures: 0 });
    expect(await ds.getRepository(IngressEvent).count()).toBe(4);
    expect(await ds.getRepository(IntegrationDeliveryFailure).count()).toBe(4);
  });

  it('deletes everything when the window is 0 days', async () => {
    // A 0-day cutoff = everything strictly older than "now" is pruned. (onModuleInit never passes a
    // 0-day events window — INGRESS_DEDUP_RETENTION_DAYS <= 0 clamps to the default; here we confirm
    // the method itself is bounded by age.)
    const result = await service.pruneOlderThan(0);
    expect(result.events + result.failures).toBe(8);
  });

  // Note: the "deletes only rows older than the window" case above is itself the bounded-delete proof —
  // an unbounded DELETE would have removed all rows (counts of 4/4), not just the aged subset.
});

describe('IntegrationRetentionService.onModuleInit (retention scheduling)', () => {
  const original = process.env.INGRESS_RETENTION_DAYS;
  const originalDedup = process.env.INGRESS_DEDUP_RETENTION_DAYS;

  const mockRepos = () => {
    const eventsDelete = jest.fn().mockResolvedValue({ affected: 0 });
    const failuresDelete = jest.fn().mockResolvedValue({ affected: 0 });
    return {
      eventsDelete,
      failuresDelete,
      events: { delete: eventsDelete } as unknown as Repository<IngressEvent>,
      failures: { delete: failuresDelete } as unknown as Repository<IntegrationDeliveryFailure>,
      reconciler: { deadLetterAgedPending: jest.fn().mockResolvedValue(0) } as unknown as IngressReconcilerService,
    };
  };

  afterEach(() => {
    if (original === undefined) delete process.env.INGRESS_RETENTION_DAYS;
    else process.env.INGRESS_RETENTION_DAYS = original;
    if (originalDedup === undefined) delete process.env.INGRESS_DEDUP_RETENTION_DAYS;
    else process.env.INGRESS_DEDUP_RETENTION_DAYS = originalDedup;
  });

  it('disables only the failures prune when INGRESS_RETENTION_DAYS <= 0 — dedup pruning still applies', async () => {
    process.env.INGRESS_RETENTION_DAYS = '0';
    delete process.env.INGRESS_DEDUP_RETENTION_DAYS;
    const repos = mockRepos();
    const svc = new IntegrationRetentionService(repos.events, repos.failures, repos.reconciler);

    svc.onModuleInit();
    // Let the startup prune promise settle (the method runs before the log .then()).
    await new Promise(resolve => setImmediate(resolve));
    // Dedup rows are never an audit log — their prune cannot be disabled to infinity.
    expect(repos.eventsDelete).toHaveBeenCalled();
    expect(repos.failuresDelete).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('defaults to 7-day dedup + 90-day failures windows, prunes once at startup, and schedules daily', () => {
    delete process.env.INGRESS_RETENTION_DAYS;
    delete process.env.INGRESS_DEDUP_RETENTION_DAYS;
    const repos = mockRepos();
    const svc = new IntegrationRetentionService(repos.events, repos.failures, repos.reconciler);

    jest.useFakeTimers();
    try {
      const pruneSpy = jest.spyOn(svc, 'pruneOlderThan');
      svc.onModuleInit();
      // Startup prune fires immediately (7-day dedup + 90-day failures defaults).
      expect(pruneSpy).toHaveBeenCalledWith(7, 90);
      pruneSpy.mockClear();
      // The recurring timer fires daily thereafter.
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(pruneSpy).toHaveBeenCalledWith(7, 90);
      svc.onModuleDestroy();
      // After destroy, advancing the timer must NOT trigger further prunes.
      pruneSpy.mockClear();
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(pruneSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('honors an explicit INGRESS_DEDUP_RETENTION_DAYS window', () => {
    delete process.env.INGRESS_RETENTION_DAYS;
    process.env.INGRESS_DEDUP_RETENTION_DAYS = '21';
    const repos = mockRepos();
    const svc = new IntegrationRetentionService(repos.events, repos.failures, repos.reconciler);

    const pruneSpy = jest.spyOn(svc, 'pruneOlderThan');
    svc.onModuleInit();
    expect(pruneSpy).toHaveBeenCalledWith(21, 90);
    svc.onModuleDestroy();
  });

  it('clamps INGRESS_DEDUP_RETENTION_DAYS <= 0 to the default instead of disabling dedup pruning', () => {
    delete process.env.INGRESS_RETENTION_DAYS;
    process.env.INGRESS_DEDUP_RETENTION_DAYS = '0';
    const repos = mockRepos();
    const svc = new IntegrationRetentionService(repos.events, repos.failures, repos.reconciler);

    const pruneSpy = jest.spyOn(svc, 'pruneOlderThan');
    svc.onModuleInit();
    // <=0 would mean an unbounded dedup table — the trap this knob exists to avoid.
    expect(pruneSpy).toHaveBeenCalledWith(7, 90);
    svc.onModuleDestroy();
  });
});

describe('IntegrationRetentionService.pruneOlderThan with undispatched events', () => {
  let ds: DataSource;
  let events: Repository<IngressEvent>;
  let failures: Repository<IntegrationDeliveryFailure>;
  let reconciler: IngressReconcilerService;
  let service: IntegrationRetentionService;
  let resolveInstance: jest.Mock;
  let existingJobState: jest.Mock;
  let logError: jest.SpyInstance;
  let logWarn: jest.SpyInstance;
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [IngressEvent, IntegrationDeliveryFailure, Session],
      synchronize: true,
    });
    await ds.initialize();
    events = ds.getRepository(IngressEvent);
    failures = ds.getRepository(IntegrationDeliveryFailure);
    await ds.getRepository(Session).save({ id: SESSION_ID, name: 'sess-1' });
    // A disabled instance, no loaded plugin and the queue off: the hand-off must not depend on the
    // instance being enabled or its plugin being loaded.
    resolveInstance = jest.fn().mockResolvedValue({ enabled: false });
    existingJobState = jest.fn().mockResolvedValue(undefined);
    reconciler = new IngressReconcilerService(
      events,
      failures,
      { existingJobState } as unknown as IngressEnqueueService,
      { getPlugin: () => undefined } as unknown as PluginLoaderService,
      { resolve: resolveInstance } as unknown as PluginInstanceService,
    );
    service = new IntegrationRetentionService(events, failures, reconciler);
    logWarn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    logError = jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (ds.isInitialized) await ds.destroy();
  });

  const insertEvent = (id: string, over: Partial<IngressEvent>) =>
    events
      .createQueryBuilder()
      .insert()
      .values({
        id,
        instanceId: 'inst',
        pluginId: 'plug',
        providerDeliveryId: `d-${id}`,
        route: 'chatwoot',
        payload: { headers: {}, query: {}, body: '{"msg":"hello"}', rawBody: '{"msg":"hello"}', method: 'POST' },
        sessionId: SESSION_ID,
        dispatchState: 'pending',
        createdAt: daysAgo(8),
        ...over,
      })
      .execute();

  it('dead-letters an aged pending event with its payload instead of deleting it unrecoverably', async () => {
    await insertEvent('stranded', {});

    const first = await service.pruneOlderThan(7, 90);

    // The payload is not lost: it now lives in a redrivable dead-letter row, written before the marker
    // was settled, and the settled marker goes with the next run.
    expect(first).toEqual({ events: 0, failures: 0 });
    expect(await events.findOneByOrFail({ id: 'stranded' })).toMatchObject({ dispatchState: 'failed', payload: null });
    expect(await service.pruneOlderThan(7, 90)).toEqual({ events: 1, failures: 0 });
    expect(await events.count()).toBe(0);
    const [dlq] = await failures.find();
    expect(dlq).toMatchObject({
      direction: 'inbound',
      pluginId: 'plug',
      instanceId: 'inst',
      sessionId: SESSION_ID,
      deliveryId: 'd-stranded',
      lastError: 'not dispatched within the ingress dedup retention window',
      redriven: false,
    });
    expect(dlq.payload).toMatchObject({
      route: 'chatwoot',
      method: 'POST',
      ingress: { body: '{"msg":"hello"}', rawBody: '{"msg":"hello"}' },
    });
  });

  it('retires the payload without a second dead letter when the live path already wrote one', async () => {
    await insertEvent('inline-failed', { dispatchAttempts: 1 });
    await failures.save({
      direction: 'inbound',
      pluginId: 'plug',
      instanceId: 'inst',
      deliveryId: 'd-inline-failed',
      attempts: 1,
      lastError: 'sandbox 5xx',
      payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      redriven: false,
    });
    const update = jest.spyOn(events, 'update');

    await service.pruneOlderThan(7, 90);

    // Settled by the hand-off: the payload is retired against the existing dead letter.
    expect(update).toHaveBeenCalledWith(
      { id: 'inline-failed', dispatchState: 'pending' },
      { dispatchState: 'failed', payload: null },
    );
    const [dlq] = await failures.find();
    expect(dlq).toMatchObject({ deliveryId: 'd-inline-failed', lastError: 'sandbox 5xx', redriven: false });
    expect(await failures.count()).toBe(1);
  });

  it('writes a fresh dead letter when the only one for the delivery id was already redriven', async () => {
    await insertEvent('resent', {});
    const old = await failures.save({
      direction: 'inbound',
      pluginId: 'plug',
      instanceId: 'inst',
      deliveryId: 'd-resent',
      attempts: 1,
      lastError: 'sandbox 5xx',
      payload: null,
      redriven: true,
    });

    await service.pruneOlderThan(7, 90);

    const open = await failures.find({ where: { deliveryId: 'd-resent', redriven: false } });
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(old.id);
    expect(open[0].payload).toMatchObject({ ingress: { rawBody: '{"msg":"hello"}' } });
  });

  it('keeps an aged pending event with its payload when the dead-letter write fails', async () => {
    await insertEvent('stranded', {});
    jest.spyOn(failures, 'save').mockRejectedValueOnce(new Error('disk full'));

    const result = await service.pruneOlderThan(7, 90);

    expect(result.events).toBe(0);
    const kept = await events.findOneByOrFail({ id: 'stranded' });
    expect(kept.dispatchState).toBe('pending');
    expect(kept.payload).toMatchObject({ rawBody: '{"msg":"hello"}' });
    expect(await failures.count()).toBe(0);
  });

  it('retires its own dead letter when a concurrent dispatch settles the event first', async () => {
    await insertEvent('raced', {});
    jest.spyOn(events, 'update').mockImplementationOnce(async () => {
      await events.query(`UPDATE ingress_events SET "dispatchState" = 'dispatched', payload = NULL WHERE id = 'raced'`);
      return { affected: 0, raw: [], generatedMaps: [] };
    });

    await service.pruneOlderThan(7, 90);

    const [dlq] = await failures.find();
    expect(dlq).toMatchObject({ deliveryId: 'd-raced', redriven: true });
  });

  it('keeps its own dead letter redrivable when a concurrent failure mark settles the event first', async () => {
    await insertEvent('raced', {});
    jest.spyOn(events, 'update').mockImplementationOnce(async () => {
      await events.query(`UPDATE ingress_events SET "dispatchState" = 'failed', payload = NULL WHERE id = 'raced'`);
      return { affected: 0, raw: [], generatedMaps: [] };
    });

    await service.pruneOlderThan(7, 90);

    const [dlq] = await failures.find();
    expect(dlq).toMatchObject({ deliveryId: 'd-raced', redriven: false });
  });

  describe('when another node dead-letters the same delivery concurrently', () => {
    const LOW_ID = '00000000-0000-4000-8000-000000000000';
    const HIGH_ID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    // The other node's dead letter lands after this node's open-row check, so both write one.
    const otherNodeDeadLetter = (id: string) =>
      failures.insert({
        id,
        direction: 'inbound',
        pluginId: 'plug',
        instanceId: 'inst',
        deliveryId: 'd-raced',
        attempts: 0,
        lastError: 'not dispatched within the ingress dedup retention window',
        payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
        redriven: false,
      });
    const openIds = async () =>
      (await failures.find({ where: { deliveryId: 'd-raced', redriven: false } })).map(f => f.id);

    it('retires its own dead letter when it loses the failure mark to a node with a lower-id row', async () => {
      await insertEvent('raced', {});
      jest.spyOn(events, 'update').mockImplementationOnce(async () => {
        await otherNodeDeadLetter(LOW_ID);
        await events.query(`UPDATE ingress_events SET "dispatchState" = 'failed', payload = NULL WHERE id = 'raced'`);
        return { affected: 0, raw: [], generatedMaps: [] };
      });

      await service.pruneOlderThan(7, 90);

      expect(await openIds()).toEqual([LOW_ID]);
      expect(await failures.count()).toBe(2);
    });

    it('retires its own dead letter when it wins the failure mark but a lower-id row exists', async () => {
      await insertEvent('raced', {});
      const update = events.update.bind(events);
      jest.spyOn(events, 'update').mockImplementationOnce(async (criteria, partial) => {
        await otherNodeDeadLetter(LOW_ID);
        return update(criteria, partial);
      });

      await service.pruneOlderThan(7, 90);

      expect(await openIds()).toEqual([LOW_ID]);
      expect(await events.findOneByOrFail({ id: 'raced' })).toMatchObject({ dispatchState: 'failed', payload: null });
    });

    it('keeps its own dead letter when the other node holds the higher id', async () => {
      await insertEvent('raced', {});
      jest.spyOn(events, 'update').mockImplementationOnce(async () => {
        await otherNodeDeadLetter(HIGH_ID);
        await events.query(`UPDATE ingress_events SET "dispatchState" = 'failed', payload = NULL WHERE id = 'raced'`);
        return { affected: 0, raw: [], generatedMaps: [] };
      });

      await service.pruneOlderThan(7, 90);

      // The other writer, a hand-off or a sweep, retires its own row once its check sees this one.
      const open = await openIds();
      expect(open).toHaveLength(2);
      expect(open).toContain(HIGH_ID);
    });
  });

  it('still prunes aged settled markers, legacy rows, and pending rows without a payload', async () => {
    await insertEvent('dispatched', { dispatchState: 'dispatched', payload: null });
    await insertEvent('failed', { dispatchState: 'failed', payload: null });
    await insertEvent('legacy', { dispatchState: null });
    await insertEvent('empty', { payload: null });
    await insertEvent('recent', { createdAt: daysAgo(1) });

    const result = await service.pruneOlderThan(7, 90);

    expect(result.events).toBe(4);
    expect((await events.find()).map(e => e.id)).toEqual(['recent']);
    expect(await failures.count()).toBe(0);
  });

  it('writes no dead letter for a deleted instance and prunes the row', async () => {
    await insertEvent('orphan', {});
    resolveInstance.mockResolvedValue(null);

    await service.pruneOlderThan(7, 90);
    const result = await service.pruneOlderThan(7, 90);

    expect(result.events).toBe(1);
    expect(await events.count()).toBe(0);
    expect(await failures.count()).toBe(0);
  });

  it('writes no dead letter for a deleted session, but keeps one for a wildcard scope', async () => {
    await insertEvent('gone', { sessionId: '22222222-2222-4222-8222-222222222222' });
    await insertEvent('wildcard', { sessionId: '*' });

    await service.pruneOlderThan(7, 90);

    expect(await events.find({ where: { dispatchState: 'failed' } })).toHaveLength(2);
    expect((await failures.find()).map(f => f.deliveryId)).toEqual(['d-wildcard']);
  });

  it('writes no dead letter while a queue job still owns the delivery', async () => {
    await insertEvent('queued', {});
    existingJobState.mockResolvedValue('waiting');
    const update = jest.spyOn(events, 'update');

    await service.pruneOlderThan(7, 90);

    expect(update).toHaveBeenCalledWith(
      { id: 'queued', dispatchState: 'pending' },
      { dispatchState: 'dispatched', payload: null },
    );
    expect(await failures.count()).toBe(0);
  });

  it('closes an inline-failure dead letter once a queue job owns the delivery', async () => {
    await insertEvent('queued', { dispatchAttempts: 1 });
    await failures.save({
      direction: 'inbound',
      pluginId: 'plug',
      instanceId: 'inst',
      deliveryId: 'd-queued',
      attempts: 1,
      lastError: 'sandbox 5xx',
      payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
      redriven: false,
    });
    existingJobState.mockResolvedValue('waiting');

    await service.pruneOlderThan(7, 90);

    // The job delivers it, so a manual redrive of the old row would deliver it twice.
    expect(await events.findOneByOrFail({ id: 'queued' })).toMatchObject({ dispatchState: 'dispatched' });
    expect(await failures.find()).toEqual([expect.objectContaining({ deliveryId: 'd-queued', redriven: true })]);
  });

  it('dead-letters an event whose queue job failed', async () => {
    await insertEvent('job-failed', {});
    existingJobState.mockResolvedValue('failed');

    await service.pruneOlderThan(7, 90);

    // A failed job delivers nothing, so the payload must survive in a redrivable dead letter.
    expect(await events.findOneByOrFail({ id: 'job-failed' })).toMatchObject({
      dispatchState: 'failed',
      payload: null,
    });
    const open = await failures.find({ where: { direction: 'inbound', redriven: false } });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ deliveryId: 'd-job-failed' });
    expect(open[0].payload).toMatchObject({ ingress: { rawBody: '{"msg":"hello"}' } });
  });

  it('still prunes aged events when the dead-letter prune fails', async () => {
    await insertEvent('dispatched', { dispatchState: 'dispatched', payload: null });
    jest.spyOn(failures, 'delete').mockRejectedValueOnce(new Error('locked'));

    const result = await service.pruneOlderThan(7, 90);

    expect(result).toEqual({ events: 1, failures: 0 });
    expect(await events.count()).toBe(0);
  });

  it('hands off a backlog larger than one batch', async () => {
    for (let i = 0; i < 250; i++) await insertEvent(`b${i}`, {});

    await service.pruneOlderThan(7, 90);

    expect(await events.count({ where: { dispatchState: 'failed' } })).toBe(250);
    expect(await failures.count()).toBe(250);
  });

  it('prunes aged settled markers while the hand-off is still waiting', async () => {
    await insertEvent('dispatched', { dispatchState: 'dispatched', payload: null });
    await insertEvent('stranded', {});
    // A job-state lookup against a stalled Redis that has not returned yet.
    const lookedUp = new Promise<void>(resolve =>
      existingJobState.mockImplementation(() => {
        resolve();
        return new Promise(() => {});
      }),
    );

    void service.pruneOlderThan(7, 90);
    await lookedUp;

    expect((await events.find()).map(e => e.id)).toEqual(['stranded']);
  });

  it('keeps every row when no dead-letter write succeeds', async () => {
    for (let i = 0; i < 100; i++) await insertEvent(`f${i}`, {});
    jest.spyOn(failures, 'save').mockRejectedValue(new Error('disk full'));

    const result = await service.pruneOlderThan(7, 90);

    expect(result.events).toBe(0);
    expect(await events.count({ where: { dispatchState: 'pending' } })).toBe(100);
    expect(logError).toHaveBeenCalledTimes(100);
    expect(logError).toHaveBeenCalledWith(
      'Failed to dead-letter an undispatched ingress event; kept for the next run',
      'disk full',
      expect.objectContaining({ action: 'ingress_event_retention_dead_letter_failed' }),
    );
  });

  it('tries a row whose dead-letter write keeps failing once per run and hands off the rows behind it', async () => {
    // A full batch of older rows whose write always fails, ahead of rows that hand off normally.
    for (let i = 0; i < 100; i++) await insertEvent(`bad${i}`, { createdAt: daysAgo(9) });
    for (let i = 0; i < 20; i++) await insertEvent(`ok${i}`, {});
    const realSave = failures.save.bind(failures) as (
      row: IntegrationDeliveryFailure,
    ) => Promise<IntegrationDeliveryFailure>;
    jest.spyOn(failures, 'save').mockImplementation(async row => {
      const dlq = row as IntegrationDeliveryFailure;
      if (dlq.deliveryId?.startsWith('d-bad')) throw new Error('row rejected');
      return realSave(dlq);
    });

    await service.pruneOlderThan(7, 90);

    expect(logError).toHaveBeenCalledTimes(100);
    expect(await events.count({ where: { dispatchState: 'pending' } })).toBe(100);
    expect(await events.count({ where: { dispatchState: 'failed' } })).toBe(20);
    expect(await failures.count()).toBe(20);
  });

  it('stops a run once ten batches of rows could not be handed off', async () => {
    for (let i = 0; i < 25; i++) await insertEvent(`f${i}`, {});
    jest.spyOn(failures, 'save').mockRejectedValue(new Error('disk full'));

    expect(await reconciler.deadLetterAgedPending(daysAgo(7), 2)).toBe(0);

    expect(logError).toHaveBeenCalledTimes(20);
    expect(await events.count({ where: { dispatchState: 'pending' } })).toBe(25);
    expect(logWarn).toHaveBeenCalledWith(
      'Ingress retention hand-off stopped early; the remaining events wait for the next run',
      expect.objectContaining({ kept: 20, action: 'ingress_event_retention_handoff_stopped' }),
    );
  });

  it('passes over pending rows whose payload is unreadable and hands off the rows behind them', async () => {
    await insertEvent('unreadable1', { createdAt: daysAgo(9) });
    await insertEvent('unreadable2', { createdAt: daysAgo(9) });
    await insertEvent('stranded', {});
    // A JSON null passes the payload IS NOT NULL filter but reads back as no payload.
    await events.query(`UPDATE ingress_events SET payload = 'null' WHERE id LIKE 'unreadable%'`);
    const find = events.find.bind(events);
    let fetches = 0;
    jest.spyOn(events, 'find').mockImplementation(opts => {
      if (++fetches > 5) throw new Error('the hand-off keeps fetching the same rows');
      return find(opts);
    });

    expect(await reconciler.deadLetterAgedPending(daysAgo(7), 2)).toBe(1);

    expect(await events.findOneByOrFail({ id: 'stranded' })).toMatchObject({ dispatchState: 'failed', payload: null });
    expect(await events.count({ where: { dispatchState: 'pending' } })).toBe(2);
  });

  // Stands in for a reconcile sweep holding the guard the hand-off shares with it.
  const holdSweep = () => {
    const guarded = reconciler as unknown as { inFlight?: Promise<void> };
    let settle!: () => void;
    guarded.inFlight = new Promise(resolve => (settle = resolve));
    return () => {
      guarded.inFlight = undefined;
      settle();
    };
  };

  // Resolves once the retention run has called the hand-off, with the hand-off's own promise.
  const handOffCalled = () =>
    new Promise<{ running: Promise<number> }>(resolve => {
      const handOff = reconciler.deadLetterAgedPending.bind(reconciler);
      jest.spyOn(reconciler, 'deadLetterAgedPending').mockImplementation((...args) => {
        const running = handOff(...args);
        resolve({ running });
        return running;
      });
    });

  it('waits for a running reconcile sweep, then hands off the aged pending rows', async () => {
    await insertEvent('stranded', {});
    const finishSweep = holdSweep();

    const called = handOffCalled();
    const pruned = service.pruneOlderThan(7, 90);
    const { running } = await called;
    const stateDuringSweep = await Promise.race([
      running.then(() => 'returned'),
      new Promise(resolve => setImmediate(resolve, 'waiting')),
    ]);
    const duringSweep = await events.findOneByOrFail({ id: 'stranded' });
    finishSweep();
    await pruned;

    expect(stateDuringSweep).toBe('waiting');
    expect(duringSweep.payload).not.toBeNull();
    expect(await events.findOneByOrFail({ id: 'stranded' })).toMatchObject({ dispatchState: 'failed', payload: null });
    expect(await failures.count()).toBe(1);
  });

  it('stops waiting for a running sweep once shutdown begins, and keeps the rows', async () => {
    await insertEvent('stranded', {});
    const finishSweep = holdSweep();

    const called = handOffCalled();
    const pruned = service.pruneOlderThan(7, 90);
    await called;
    const destroyed = reconciler.onModuleDestroy();
    finishSweep();
    await Promise.all([pruned, destroyed]);

    expect((await events.findOneByOrFail({ id: 'stranded' })).payload).not.toBeNull();
    expect(await failures.count()).toBe(0);
  });

  it('stops the hand-off at the next row once shutdown begins, and destroy waits for the row in hand', async () => {
    await insertEvent('first', { createdAt: daysAgo(9) });
    await insertEvent('second', {});
    const realSave = failures.save.bind(failures) as (
      row: IntegrationDeliveryFailure,
    ) => Promise<IntegrationDeliveryFailure>;
    let saving!: () => void;
    const entered = new Promise<void>(resolve => (saving = resolve));
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    jest.spyOn(failures, 'save').mockImplementationOnce(async row => {
      saving();
      await held;
      return realSave(row as IntegrationDeliveryFailure);
    });

    const pruned = service.pruneOlderThan(7, 90);
    await entered;
    let destroyed = false;
    const destroy = reconciler.onModuleDestroy().then(() => (destroyed = true));
    await new Promise(setImmediate);
    const destroyedWhileHeld = destroyed;
    release();
    await destroy;
    const firstAtDestroy = (await events.findOneByOrFail({ id: 'first' })).dispatchState;
    await pruned;

    expect(destroyedWhileHeld).toBe(false);
    expect(firstAtDestroy).toBe('failed');
    expect(await failures.count()).toBe(1);
    const rows = await events.find({ order: { createdAt: 'ASC' } });
    expect(rows.map(r => r.dispatchState)).toEqual(['failed', 'pending']);
    expect(rows[1].payload).not.toBeNull();
  });

  it('stops waiting on destroy for a hand-off lookup that does not return, and keeps its row', async () => {
    await insertEvent('stranded', {});
    let answer!: (state: undefined) => void;
    const lookedUp = new Promise<void>(resolve =>
      existingJobState.mockImplementation(() => {
        resolve();
        return new Promise(settle => (answer = settle));
      }),
    );

    const pruned = service.pruneOlderThan(7, 90);
    await lookedUp;
    let destroyed = false;
    let destroyedBeforeDeadline: boolean;
    let destroyedAtDeadline: boolean;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      void reconciler.onModuleDestroy().then(() => (destroyed = true));
      await jest.advanceTimersByTimeAsync(INGRESS_DISPATCH_TIMEOUT_MS - 1);
      await new Promise(setImmediate);
      destroyedBeforeDeadline = destroyed;
      await jest.advanceTimersByTimeAsync(1);
      await new Promise(setImmediate);
      destroyedAtDeadline = destroyed;
    } finally {
      jest.useRealTimers();
    }
    // The lookup returns once the queue connection closes later in shutdown; the row is left as it was.
    answer(undefined);
    await pruned;

    expect(destroyedBeforeDeadline).toBe(false);
    expect(destroyedAtDeadline).toBe(true);
    expect(await failures.count()).toBe(0);
    const row = await events.findOneByOrFail({ id: 'stranded' });
    expect(row.dispatchState).toBe('pending');
    expect(row.payload).not.toBeNull();
  });
});
