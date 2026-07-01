import { DataSource } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import { PluginInstanceService } from './plugin-instance.service';
import { AddIntegrationFabric1781900000000 } from '../../database/migrations/1781900000000-AddIntegrationFabric';

describe('PluginInstanceService', () => {
  let ds: DataSource;
  let service: PluginInstanceService;
  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [PluginInstance], migrations: [] });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
    await runner.release();
    service = new PluginInstanceService(ds.getRepository(PluginInstance));
  });
  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it('mints a 64-hex-char secret and stores a composite id', async () => {
    const inst = await service.mint('chatwoot', 'acct1', { sessionScope: 'sess-1' });
    expect(inst.id).toBe('chatwoot:acct1');
    expect(inst.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('masks the secret on the operator-facing view', async () => {
    const inst = await service.mint('chatwoot', 'acct1', {});
    expect(service.maskedView(inst).secret).toBe('***');
  });

  it('resolves an existing instance and returns null for an unknown one', async () => {
    await service.mint('chatwoot', 'acct1', {});
    expect((await service.resolve('chatwoot', 'acct1'))?.id).toBe('chatwoot:acct1');
    expect(await service.resolve('chatwoot', 'nope')).toBeNull();
  });
});
