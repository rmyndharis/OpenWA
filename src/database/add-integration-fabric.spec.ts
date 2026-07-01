import { DataSource } from 'typeorm';
import { AddIntegrationFabric1781900000000 } from './migrations/1781900000000-AddIntegrationFabric';

describe('AddIntegrationFabric migration (sqlite)', () => {
  let ds: DataSource;
  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [], migrations: [] });
    await ds.initialize();
  });
  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it('creates all four tables and is idempotent, then drops cleanly on down()', async () => {
    const runner = ds.createQueryRunner();
    const mig = new AddIntegrationFabric1781900000000();
    await mig.up(runner);
    await mig.up(runner); // idempotent: hasTable guard must not throw on re-run
    for (const t of ['plugin_instances', 'conversation_mappings', 'ingress_events', 'integration_delivery_failures']) {
      expect(await runner.hasTable(t)).toBe(true);
    }
    await mig.down(runner);
    for (const t of ['plugin_instances', 'conversation_mappings', 'ingress_events', 'integration_delivery_failures']) {
      expect(await runner.hasTable(t)).toBe(false);
    }
    await runner.release();
  });

  it('enforces UNIQUE(instanceId, providerDeliveryId) on ingress_events', async () => {
    const runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
    await runner.query(
      `INSERT INTO "ingress_events" ("id","instanceId","pluginId","providerDeliveryId","route","payload","createdAt") VALUES ('a','inst','plug','d1','chatwoot','{}',datetime('now'))`,
    );
    await expect(
      runner.query(
        `INSERT INTO "ingress_events" ("id","instanceId","pluginId","providerDeliveryId","route","payload","createdAt") VALUES ('b','inst','plug','d1','chatwoot','{}',datetime('now'))`,
      ),
    ).rejects.toThrow();
    await runner.release();
  });
});
