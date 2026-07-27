import { DataSource } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IngressEventService } from './ingress-event.service';
import { AddIntegrationFabric1781900000000 } from '../../database/migrations/1781900000000-AddIntegrationFabric';
import { WidenIngressDedupKey1782100000000 } from '../../database/migrations/1782100000000-WidenIngressDedupKey';
import { AddIngressEventDispatchState1785112230000 } from '../../database/migrations/1785112230000-AddIngressEventDispatchState';

describe('IngressEventService.recordOrSkip', () => {
  let ds: DataSource;
  let service: IngressEventService;
  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [IngressEvent], migrations: [] });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
    await new WidenIngressDedupKey1782100000000().up(runner);
    await new AddIngressEventDispatchState1785112230000().up(runner);
    await runner.release();
    service = new IngressEventService(ds.getRepository(IngressEvent));
  });
  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  const row = () => ({
    instanceId: 'inst',
    pluginId: 'plug',
    providerDeliveryId: 'd1',
    route: 'chatwoot',
    payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
    sessionId: null,
  });
  const key = { pluginId: 'plug', instanceId: 'inst', providerDeliveryId: 'd1' };
  const stored = () => ds.getRepository(IngressEvent).findOneByOrFail(key);

  it('returns true for a first delivery and false for a replay of the same delivery id', async () => {
    expect(await service.recordOrSkip(row())).toBe(true);
    expect(await service.recordOrSkip(row())).toBe(false);
  });

  it('treats the same delivery id under a different instance as new', async () => {
    expect(await service.recordOrSkip(row())).toBe(true);
    expect(await service.recordOrSkip({ ...row(), instanceId: 'inst2' })).toBe(true);
  });

  it('treats the same instance+delivery id under a different plugin as new (dedup key includes pluginId)', async () => {
    // instanceId is only unique within a plugin; two plugins sharing the string must not collide.
    expect(await service.recordOrSkip(row())).toBe(true);
    expect(await service.recordOrSkip({ ...row(), pluginId: 'other-plug' })).toBe(true);
  });

  it('writes new events as dispatchState pending with zero attempts (watched by the reconciler)', async () => {
    await service.recordOrSkip(row());
    const event = await stored();
    expect(event.dispatchState).toBe('pending');
    expect(event.dispatchAttempts).toBe(0);
    expect(event.lastDispatchAt).toBeNull();
  });

  it.each(['queued', 'dispatched'] as const)(
    'marks outcome %s as dispatched with a dispatch timestamp',
    async outcome => {
      await service.recordOrSkip(row());
      await service.markDispatchOutcome(key, outcome);
      const event = await stored();
      expect(event.dispatchState).toBe('dispatched');
      expect(event.lastDispatchAt).toBeInstanceOf(Date);
      expect(event.dispatchAttempts).toBe(0);
    },
  );

  it('marks outcome failed as still-pending with the attempt counted (reconciler sweeps it)', async () => {
    await service.recordOrSkip(row());
    await service.markDispatchOutcome(key, 'failed');
    const event = await stored();
    expect(event.dispatchState).toBe('pending');
    expect(event.dispatchAttempts).toBe(1);
    expect(event.lastDispatchAt).toBeInstanceOf(Date);

    // Repeated failures accumulate against the reconciler's replay budget.
    await service.markDispatchOutcome(key, 'failed');
    expect((await stored()).dispatchAttempts).toBe(2);
    expect((await stored()).dispatchState).toBe('pending');
  });
});
