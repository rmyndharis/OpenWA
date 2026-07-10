import { DataSource, Repository } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IntegrationDeliveryFailure } from './entities/integration-delivery-failure.entity';
import { IntegrationRetentionService } from './integration-retention.service';

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
      type: 'sqlite',
      database: ':memory:',
      entities: [IngressEvent, IntegrationDeliveryFailure],
      synchronize: true,
    });
    await ds.initialize();
    service = new IntegrationRetentionService(
      ds.getRepository(IngressEvent),
      ds.getRepository(IntegrationDeliveryFailure),
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

  it('deletes nothing when the window exceeds every row age', async () => {
    const result = await service.pruneOlderThan(365);
    expect(result).toEqual({ events: 0, failures: 0 });
    expect(await ds.getRepository(IngressEvent).count()).toBe(4);
    expect(await ds.getRepository(IntegrationDeliveryFailure).count()).toBe(4);
  });

  it('deletes everything when the window is 0 days', async () => {
    // A 0-day cutoff = everything strictly older than "now" is pruned. (onModuleInit treats <=0 as a
    // disabled opt-out and never calls this; here we confirm the method itself is bounded by age.)
    const result = await service.pruneOlderThan(0);
    expect(result.events + result.failures).toBe(8);
  });

  // Note: the "deletes only rows older than the window" case above is itself the bounded-delete proof —
  // an unbounded DELETE would have removed all rows (counts of 4/4), not just the aged subset.
});

describe('IntegrationRetentionService.onModuleInit (retention scheduling)', () => {
  const original = process.env.INGRESS_RETENTION_DAYS;

  const mockRepos = () => {
    const eventsDelete = jest.fn().mockResolvedValue({ affected: 0 });
    const failuresDelete = jest.fn().mockResolvedValue({ affected: 0 });
    return {
      eventsDelete,
      failuresDelete,
      events: { delete: eventsDelete } as unknown as Repository<IngressEvent>,
      failures: { delete: failuresDelete } as unknown as Repository<IntegrationDeliveryFailure>,
    };
  };

  afterEach(() => {
    if (original === undefined) delete process.env.INGRESS_RETENTION_DAYS;
    else process.env.INGRESS_RETENTION_DAYS = original;
  });

  it('disables pruning (no startup prune, no timer) when INGRESS_RETENTION_DAYS <= 0', () => {
    process.env.INGRESS_RETENTION_DAYS = '0';
    const repos = mockRepos();
    const svc = new IntegrationRetentionService(repos.events, repos.failures);

    expect(() => svc.onModuleInit()).not.toThrow();
    expect(repos.eventsDelete).not.toHaveBeenCalled();
    expect(repos.failuresDelete).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('defaults to 90 days when unset, prunes once at startup, and schedules a daily timer', () => {
    delete process.env.INGRESS_RETENTION_DAYS;
    const repos = mockRepos();
    const svc = new IntegrationRetentionService(repos.events, repos.failures);

    jest.useFakeTimers();
    try {
      const pruneSpy = jest.spyOn(svc, 'pruneOlderThan');
      svc.onModuleInit();
      // Startup prune fires immediately (90-day default).
      expect(pruneSpy).toHaveBeenCalledWith(90);
      pruneSpy.mockClear();
      // The recurring timer fires daily thereafter.
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(pruneSpy).toHaveBeenCalledWith(90);
      svc.onModuleDestroy();
      // After destroy, advancing the timer must NOT trigger further prunes.
      pruneSpy.mockClear();
      jest.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(pruneSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
