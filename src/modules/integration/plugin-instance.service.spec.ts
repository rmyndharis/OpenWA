import { DataSource } from 'typeorm';
import { PluginInstance } from './entities/plugin-instance.entity';
import { PluginInstanceService, InstanceExistsError } from './plugin-instance.service';
import { AddIntegrationFabric1781900000000 } from '../../database/migrations/1781900000000-AddIntegrationFabric';
import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';

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

  it('masks secret:true config fields (apiToken) on masked reads', () => {
    const schema = {
      type: 'object',
      properties: { apiToken: { type: 'string', secret: true }, accountId: { type: 'number' } },
    } as PluginConfigSchema;
    const inst = {
      id: 'p:i',
      secret: 'x',
      config: { apiToken: 'live-token', accountId: 3 },
    } as unknown as PluginInstance;
    const masked = service.maskedView(inst, schema);
    const config = masked.config as Record<string, unknown>;
    expect(masked.secret).toBe('***');
    expect(config.apiToken).toBe('***');
    expect(config.accountId).toBe(3);
  });

  it('masks the ENTIRE config when the schema is unavailable, e.g. the plugin is unloaded (fail-closed)', () => {
    const inst = {
      id: 'p:i',
      secret: 'x',
      config: { apiToken: 'live-token', accountId: 3 },
    } as unknown as PluginInstance;
    const config = service.maskedView(inst, undefined).config as Record<string, unknown>;
    expect(config.apiToken).toBe('***');
    expect(config.accountId).toBe('***');
  });

  it('resolves an existing instance and returns null for an unknown one', async () => {
    await service.mint('chatwoot', 'acct1', {});
    expect((await service.resolve('chatwoot', 'acct1'))?.id).toBe('chatwoot:acct1');
    expect(await service.resolve('chatwoot', 'nope')).toBeNull();
  });

  it('accepts a valid operator secret, rejects short/empty, else auto-generates', async () => {
    const ok = await service.create('chatwoot-adapter', 'a1', { secret: 'cw-secret-16chars!' });
    expect(ok.secret).toBe('cw-secret-16chars!');
    await expect(service.create('chatwoot-adapter', 'a2', { secret: '   ' })).rejects.toThrow(/secret/i);
    await expect(service.create('chatwoot-adapter', 'a3', { secret: 'short' })).rejects.toThrow(/16/);
    const gen = await service.create('chatwoot-adapter', 'a4', {});
    expect(gen.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('masks a NESTED secret:true config field on masked reads (recursive redaction)', () => {
    const schema = {
      type: 'object',
      properties: {
        provider: {
          type: 'object',
          properties: { apiToken: { type: 'string', secret: true }, region: { type: 'string' } },
        },
      },
    } as PluginConfigSchema;
    const inst = {
      id: 'p:i',
      secret: 'x',
      config: { provider: { apiToken: 'live-token', region: 'us' } },
    } as unknown as PluginInstance;
    const config = service.maskedView(inst, schema).config as { provider: Record<string, unknown> };
    expect(config.provider.apiToken).toBe('***');
    expect(config.provider.region).toBe('us');
  });

  it('update restores a masked (sentinel) secret to the stored value instead of persisting "***"', async () => {
    const schema = {
      type: 'object',
      properties: { apiToken: { type: 'string', secret: true }, accountId: { type: 'number' } },
    } as PluginConfigSchema;
    await service.create('chatwoot', 'acct1', { config: { apiToken: 'real-token', accountId: 1 } });

    // Dashboard round-trips the masked config back with an edited non-secret field.
    const updated = await service.update('chatwoot', 'acct1', { config: { apiToken: '***', accountId: 2 } }, schema);

    expect(updated?.config).toEqual({ apiToken: 'real-token', accountId: 2 });
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

  it('normalizes an empty sessionScope to null (all-sessions) on mint/create/update, never a literal ""', async () => {
    // '' would break outbound send (falsy sessionId) and be unrecoverable from the UI; store null instead.
    const minted = await service.mint('chatwoot', 'm1', { sessionScope: '' });
    expect(minted.sessionScope).toBeNull();
    const created = await service.create('chatwoot', 'acct1', { sessionScope: '' });
    expect(created.sessionScope).toBeNull();
    const patched = await service.update('chatwoot', 'acct1', { sessionScope: '' });
    expect(patched?.sessionScope).toBeNull();
  });
});
