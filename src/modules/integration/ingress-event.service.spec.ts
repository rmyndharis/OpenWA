import { DataSource } from 'typeorm';
import { IngressEvent } from './entities/ingress-event.entity';
import { IngressEventService } from './ingress-event.service';
import { AddIntegrationFabric1781900000000 } from '../../database/migrations/1781900000000-AddIntegrationFabric';

describe('IngressEventService.recordOrSkip', () => {
  let ds: DataSource;
  let service: IngressEventService;
  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [IngressEvent], migrations: [] });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
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

  it('returns true for a first delivery and false for a replay of the same delivery id', async () => {
    expect(await service.recordOrSkip(row())).toBe(true);
    expect(await service.recordOrSkip(row())).toBe(false);
  });

  it('treats the same delivery id under a different instance as new', async () => {
    expect(await service.recordOrSkip(row())).toBe(true);
    expect(await service.recordOrSkip({ ...row(), instanceId: 'inst2' })).toBe(true);
  });
});
