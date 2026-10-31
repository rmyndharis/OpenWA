import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FOREIGN_TRANSACTION_WAIT_MS } from '../../common/utils/shared-connection';
import { PluginInstance } from './entities/plugin-instance.entity';
import { ConversationMapping } from './entities/conversation-mapping.entity';
import { ConversationMappingService } from './conversation-mapping.service';
import { PluginInstanceService, InstanceExistsError } from './plugin-instance.service';
import { AddIntegrationFabric1781900000000 } from '../../database/migrations/1781900000000-AddIntegrationFabric';
import type { PluginConfigSchema } from '../../core/plugins/plugin.interfaces';

describe('PluginInstanceService', () => {
  let ds: DataSource;
  let service: PluginInstanceService;
  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [PluginInstance], migrations: [] });
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

  // A GET challenge route answers 403 while verifyToken is null, and no update path can set it later.
  it('keeps a supplied verifyToken, else auto-generates one on create and mint', async () => {
    expect((await service.create('meta', 'a1', { verifyToken: 'hub-token' })).verifyToken).toBe('hub-token');
    expect((await service.create('meta', 'a2', {})).verifyToken).toMatch(/^[0-9a-f]{32}$/);
    expect((await service.mint('meta', 'a3', {})).verifyToken).toMatch(/^[0-9a-f]{32}$/);
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

  it('update withholds the stored secret from a PATCH that points the host key at another origin', async () => {
    const schema = {
      type: 'object',
      properties: { baseUrl: { type: 'string' }, apiToken: { type: 'string', secret: true } },
    } as PluginConfigSchema;
    const net = { allowConfigHosts: ['baseUrl'] };
    await service.create('chatwoot', 'acct1', {
      config: { baseUrl: 'https://tenant.example', apiToken: 'real-token' },
    });

    const same = await service.update(
      'chatwoot',
      'acct1',
      { config: { baseUrl: 'https://tenant.example/x', apiToken: '***' } },
      schema,
      { net },
    );
    expect(same?.config).toEqual({ baseUrl: 'https://tenant.example/x', apiToken: 'real-token' });

    const moved = await service.update(
      'chatwoot',
      'acct1',
      { config: { baseUrl: 'https://attacker.example', apiToken: '***' } },
      schema,
      { net },
    );
    expect(moved?.config).toEqual({ baseUrl: 'https://attacker.example' });
  });

  it('update judges a row that names no host against the host beneath it', async () => {
    const schema = {
      type: 'object',
      properties: { baseUrl: { type: 'string' }, apiToken: { type: 'string', secret: true } },
    } as PluginConfigSchema;
    const layer = { net: { allowConfigHosts: ['baseUrl'] }, beneath: { baseUrl: 'https://base.example' } };
    await service.create('chatwoot', 'acct1', { config: { apiToken: 'real-token' } });

    const same = await service.update(
      'chatwoot',
      'acct1',
      { config: { baseUrl: 'https://base.example/', apiToken: '***' } },
      schema,
      layer,
    );
    expect(same?.config).toEqual({ baseUrl: 'https://base.example/', apiToken: 'real-token' });
  });

  // UpdateInstanceDto lets a null config through validation, and a null config clears the row.
  it('update still clears the config for a null config on a plugin with host keys', async () => {
    const schema = { type: 'object', properties: { baseUrl: { type: 'string' } } } as PluginConfigSchema;
    await service.create('chatwoot', 'acct1', { config: { baseUrl: 'https://tenant.example' } });

    const cleared = await service.update('chatwoot', 'acct1', { config: null as never }, schema, {
      net: { allowConfigHosts: ['baseUrl'] },
    });
    expect(cleared?.config).toEqual({});
  });
});

describe('PluginInstanceService provisioning', () => {
  let ds: DataSource;
  let service: PluginInstanceService;
  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [PluginInstance, ConversationMapping],
      migrations: [],
    });
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
    expect(rotated?.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated?.secret).not.toBe(created.secret);
  });

  it('releases the takeover a deleted instance held, so other plugins are no longer silenced on that chat', async () => {
    const mappings = ds.getRepository(ConversationMapping);
    const mapping = (pluginId: string, instanceId: string, chatId: string, handoverState: 'human' | 'closed') =>
      mappings.save(
        mappings.create({
          sessionId: 'sess-1',
          chatId,
          pluginId,
          instanceId,
          providerConversationId: `${instanceId}-${chatId}`,
          handoverState,
        }),
      );
    await mapping('chatwoot', 'acct1', '1@c.us', 'human');
    await mapping('chatwoot', 'acct1', '2@c.us', 'closed');
    await mapping('chatwoot', 'acct2', '3@c.us', 'human');
    const lookup = new ConversationMappingService(mappings);
    expect(await lookup.findHandoverForChat('sess-1', '1@c.us')).toMatchObject({ handoverState: 'human' });

    await service.create('chatwoot', 'acct1', {});
    await service.remove('chatwoot', 'acct1');

    expect(await lookup.findHandoverForChat('sess-1', '1@c.us')).toBeNull();
    expect(await lookup.findHandoverForChat('sess-1', '2@c.us')).toBeNull();
    // The rows stay, so the same instance provisioned again keeps its provider conversations; another
    // instance's takeover is untouched.
    expect((await mappings.findOneByOrFail({ chatId: '1@c.us' })).providerConversationId).toBe('acct1-1@c.us');
    expect(await lookup.findHandoverForChat('sess-1', '3@c.us')).toMatchObject({ handoverState: 'human' });
  });

  it('update patches enabled/scope/config in one write; remove deletes', async () => {
    await service.create('chatwoot', 'acct1', { sessionScope: 'a' });
    const repo = ds.getRepository(PluginInstance);
    const write = jest.spyOn(repo, 'update');
    const save = jest.spyOn(repo, 'save');
    const patched = await service.update('chatwoot', 'acct1', { enabled: false, sessionScope: 'b', config: { k: 1 } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(patched?.enabled).toBe(false);
    expect(patched?.sessionScope).toBe('b');
    expect(patched?.config).toEqual({ k: 1 });
    expect((await service.resolve('chatwoot', 'acct1'))?.enabled).toBe(false);
    expect(await service.remove('chatwoot', 'acct1')).toBe(true);
    expect(await service.resolve('chatwoot', 'acct1')).toBeNull();
    expect(await service.remove('chatwoot', 'acct1')).toBe(false);
  });

  // On SQLite every caller shares one connection. A transaction begun in the same turn of the event loop as the
  // remove's would nest in it or hold it, so either could fail on the other's state or undo the other's writes.
  describe('a remove beside another transaction begun in the same turn', () => {
    const settle = (result: Promise<unknown>) => result.catch((error: unknown) => String(error));
    const after = <T>(steps: number, start: () => Promise<T>) =>
      (async () => {
        for (let i = 0; i < steps; i += 1) await Promise.resolve();
        return start();
      })();
    async function provision(instanceId: string) {
      await service.create('chatwoot', instanceId, {});
      const mappings = ds.getRepository(ConversationMapping);
      await mappings.save(
        mappings.create({
          sessionId: 'sess-1',
          chatId: `${instanceId}@c.us`,
          pluginId: 'chatwoot',
          instanceId,
          providerConversationId: instanceId,
          handoverState: 'human',
        }),
      );
    }
    const left = async (instanceId: string) => ({
      rows: await ds.getRepository(PluginInstance).countBy({ instanceId }),
      handover: (await ds.getRepository(ConversationMapping).findOneByOrFail({ instanceId })).handoverState,
    });
    const gone = { rows: 0, handover: 'bot' };

    // A write that fails on the primary key and rolls its transaction back.
    const failing = () =>
      ds.transaction(manager => manager.query('INSERT INTO plugin_instances SELECT * FROM plugin_instances'));

    it.each(['before', 'after'])('removes the instance when a transaction that fails begins %s it', async order => {
      for (let steps = 0; steps <= 40; steps += 1) {
        const instanceId = `acct-${steps}`;
        await provision(instanceId);
        const remove = () => service.remove('chatwoot', instanceId);
        const [removed] =
          order === 'after'
            ? await Promise.all([settle(remove()), settle(after(steps, failing))])
            : await Promise.all([settle(after(steps, remove)), settle(failing())]);
        expect({ steps, removed, ...(await left(instanceId)) }).toEqual({ steps, removed: true, ...gone });
      }
    });

    it('removes both instances of two removes', async () => {
      for (let steps = 0; steps <= 40; steps += 1) {
        await provision(`first-${steps}`);
        await provision(`second-${steps}`);
        const removed = await Promise.all([
          settle(service.remove('chatwoot', `first-${steps}`)),
          settle(after(steps, () => service.remove('chatwoot', `second-${steps}`))),
        ]);
        expect({ steps, removed, first: await left(`first-${steps}`), second: await left(`second-${steps}`) }).toEqual({
          steps,
          removed: [true, true],
          first: gone,
          second: gone,
        });
      }
    });

    it('refuses with 503 and removes nothing when a transaction beside it stays open', async () => {
      await provision('held');
      const other = ds.createQueryRunner();
      await other.connect();
      await other.startTransaction();
      const start = Date.now();
      let calls = 0;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => start + FOREIGN_TRANSACTION_WAIT_MS * calls++);

      try {
        await expect(service.remove('chatwoot', 'held')).rejects.toThrow(ServiceUnavailableException);
      } finally {
        clock.mockRestore();
      }
      await other.commitTransaction();
      await other.release();

      expect(await left('held')).toEqual({ rows: 1, handover: 'human' });
    });
  });

  it('update and regenerateSecret return the stored updatedAt, not the one read before the write', async () => {
    await service.create('chatwoot', 'acct1', {});
    const backdate = () => ds.query(`UPDATE plugin_instances SET "updatedAt" = '2000-01-01 00:00:00'`);

    await backdate();
    const patched = await service.update('chatwoot', 'acct1', { enabled: false });
    const afterPatch = await service.resolve('chatwoot', 'acct1');
    expect(afterPatch?.updatedAt.getUTCFullYear()).not.toBe(2000);
    expect(patched?.updatedAt).toEqual(afterPatch?.updatedAt);

    await backdate();
    const rotated = await service.regenerateSecret('chatwoot', 'acct1');
    const afterRotate = await service.resolve('chatwoot', 'acct1');
    expect(rotated?.updatedAt).toEqual(afterRotate?.updatedAt);
    expect(rotated?.secret).toBe(afterRotate?.secret);
  });

  it('answers a concurrent duplicate create with InstanceExistsError and keeps the first secret', async () => {
    const results = await Promise.allSettled([
      service.create('chatwoot', 'acct1', { secret: 'first-secret-16chars' }),
      service.create('chatwoot', 'acct1', { secret: 'second-secret-16chars' }),
    ]);
    const created = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(InstanceExistsError);
    const winner = created[0].value;
    expect((await service.resolve('chatwoot', 'acct1'))?.secret).toBe(winner.secret);
  });

  it('mint returns the stored row when a concurrent mint inserted it first', async () => {
    const [a, b] = await Promise.all([service.mint('chatwoot', 'acct1', {}), service.mint('chatwoot', 'acct1', {})]);
    expect(a.secret).toBe(b.secret);
    expect((await service.resolve('chatwoot', 'acct1'))?.secret).toBe(a.secret);
  });

  // update() reads the row before it writes; a DELETE or a secret rotation can land in between.
  it('update does not re-insert a row deleted after it was read', async () => {
    await service.create('chatwoot', 'acct1', {});
    const stale = await service.resolve('chatwoot', 'acct1');
    await service.remove('chatwoot', 'acct1');
    jest.spyOn(service, 'resolve').mockResolvedValueOnce(stale);

    expect(await service.update('chatwoot', 'acct1', { enabled: false })).toBeNull();
    expect(await service.resolve('chatwoot', 'acct1')).toBeNull();
  });

  it('update does not revert a secret rotated after it was read', async () => {
    await service.create('chatwoot', 'acct1', {});
    const stale = await service.resolve('chatwoot', 'acct1');
    const rotated = await service.regenerateSecret('chatwoot', 'acct1');
    jest.spyOn(service, 'resolve').mockResolvedValueOnce(stale);

    await service.update('chatwoot', 'acct1', { enabled: false });

    const stored = await service.resolve('chatwoot', 'acct1');
    expect(stored?.secret).toBe(rotated?.secret);
    expect(stored?.enabled).toBe(false);
  });

  it('regenerateSecret answers null, without re-inserting, for a row deleted after it was read', async () => {
    await service.create('chatwoot', 'acct1', {});
    const stale = await service.resolve('chatwoot', 'acct1');
    await service.remove('chatwoot', 'acct1');
    jest.spyOn(service, 'resolve').mockResolvedValueOnce(stale);

    await expect(service.regenerateSecret('chatwoot', 'acct1')).resolves.toBeNull();
    expect(await service.resolve('chatwoot', 'acct1')).toBeNull();
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

  // PATCH sessionScope:null is how an operator returns a bound instance to all sessions. It must land
  // as the same null an unscoped create stores, since ingress and the sandbox bridge pass a stored
  // '*' on as a literal session id.
  it('update clears a bound sessionScope to null, the value an unscoped create stores', async () => {
    const unscoped = await service.create('chatwoot', 'acct0', {});
    await service.create('chatwoot', 'acct1', { sessionScope: 'sess-1' });

    const cleared = await service.update('chatwoot', 'acct1', { sessionScope: null });

    expect(cleared?.sessionScope).toBeNull();
    expect(unscoped.sessionScope).toBeNull();
    expect((await service.resolve('chatwoot', 'acct1'))?.sessionScope).toBeNull();
  });
});
