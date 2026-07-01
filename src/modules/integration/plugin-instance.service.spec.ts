import { DataSource } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import { PluginInstanceService, InstanceExistsError } from './plugin-instance.service';
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

describe('PluginInstanceService provisioning', () => {
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

  it('create mints a new instance and rejects a duplicate with InstanceExistsError', async () => {
    const inst = await service.create('chatwoot', 'acct1', { sessionScope: 'sess-1' });
    expect(inst.id).toBe('chatwoot:acct1');
    expect(inst.secret).toMatch(/^[0-9a-f]{64}$/);
    await expect(service.create('chatwoot', 'acct1', {})).rejects.toBeInstanceOf(InstanceExistsError);
  });

  it('list returns all instances for a plugin', async () => {
    await service.create('chatwoot', 'acct1', {});
    await service.create('chatwoot', 'acct2', {});
    await service.create('other', 'x', {});
    const list = await service.list('chatwoot');
    expect(list.map(i => i.instanceId).sort()).toEqual(['acct1', 'acct2']);
  });

  it('regenerateSecret replaces the secret with a new value', async () => {
    const created = await service.create('chatwoot', 'acct1', {});
    const rotated = await service.regenerateSecret('chatwoot', 'acct1');
    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated.secret).not.toBe(created.secret);
  });

  it('setEnabled toggles enabled; update patches scope/config; remove deletes', async () => {
    await service.create('chatwoot', 'acct1', { sessionScope: 'a' });
    expect((await service.setEnabled('chatwoot', 'acct1', false))?.enabled).toBe(false);
    const patched = await service.update('chatwoot', 'acct1', { sessionScope: 'b', config: { k: 1 } });
    expect(patched?.sessionScope).toBe('b');
    expect(patched?.config).toEqual({ k: 1 });
    expect(await service.remove('chatwoot', 'acct1')).toBe(true);
    expect(await service.resolve('chatwoot', 'acct1')).toBeNull();
    expect(await service.remove('chatwoot', 'acct1')).toBe(false);
  });
});
