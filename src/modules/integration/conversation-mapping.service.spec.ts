import { DataSource, FindOperator, Repository } from 'typeorm';
import { ConversationMapping } from './entities/conversation-mapping.entity';
import { ConversationMappingConflict, ConversationMappingService, MappingKey } from './conversation-mapping.service';
import { AddIntegrationFabric1781900000000 } from '../../database/migrations/1781900000000-AddIntegrationFabric';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';

/** The `In([...])` condition a lid-table fake honours; an absent condition matches every row. */
const inList = (value: string, cond?: FindOperator<string>): boolean =>
  cond === undefined || (cond.value as unknown as string[]).includes(value);

describe('ConversationMappingService', () => {
  let ds: DataSource;
  let service: ConversationMappingService;
  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ConversationMapping],
      migrations: [],
    });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    await new AddIntegrationFabric1781900000000().up(runner);
    await runner.release();
    service = new ConversationMappingService(ds.getRepository(ConversationMapping));
  });
  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  const key: MappingKey = { sessionId: 'sess-1', chatId: 'chat-1', pluginId: 'chatwoot', instanceId: 'acct1' };

  it('upserts a mapping then get(forwardKey) returns it with a non-empty id', async () => {
    await service.upsert(key, 'conv-1');
    const found = await service.get(key);
    expect(found).not.toBeNull();
    expect(found?.id).toEqual(expect.any(String));
    expect(found?.id.length).toBeGreaterThan(0);
    expect(found?.providerConversationId).toBe('conv-1');
  });

  it('getByProvider reverse lookup returns the same row', async () => {
    await service.upsert(key, 'conv-1');
    const forward = await service.get(key);
    const reverse = await service.getByProvider(key.pluginId, key.instanceId, 'conv-1');
    expect(reverse).not.toBeNull();
    expect(reverse?.id).toBe(forward?.id);
  });

  it('upserting again on the same forward key updates providerConversationId instead of inserting a duplicate', async () => {
    await service.upsert(key, 'conv-1');
    const first = await service.get(key);

    await service.upsert(key, 'conv-2');
    const second = await service.get(key);

    expect(second?.id).toBe(first?.id);
    expect(second?.providerConversationId).toBe('conv-2');

    const stale = await service.getByProvider(key.pluginId, key.instanceId, 'conv-1');
    expect(stale).toBeNull();
  });

  it('rethrows ConversationMappingConflict when a providerConversationId is already bound to a different chat', async () => {
    // Reverse unique key (pluginId, instanceId, providerConversationId): binding conv-1 to chat-1 then to
    // a different chat-2 for the same plugin+instance is a genuine conflict with no forward row to
    // converge onto — it must surface, not silently corrupt or fail-soft to a nonexistent row.
    await service.upsert(key, 'conv-1');
    await expect(
      service.upsert({ sessionId: 'sess-1', chatId: 'chat-2', pluginId: 'chatwoot', instanceId: 'acct1' }, 'conv-1'),
    ).rejects.toBeInstanceOf(ConversationMappingConflict);
  });

  it('converges (updates, does not throw) when the same forward key already exists', async () => {
    await service.upsert(key, 'conv-1');
    await expect(service.upsert(key, 'conv-9')).resolves.toBeUndefined();
    expect((await service.get(key))?.providerConversationId).toBe('conv-9');
  });

  it('findHandoverForChat returns any human/closed row for the chat, ignoring pluginId', async () => {
    // faq-bot keeps a bot mapping; chatwoot-adapter takes the same chat over (human).
    await service.upsert({ sessionId: 'sess-1', chatId: 'chat-1', pluginId: 'faq-bot', instanceId: 'i1' }, 'convA');
    await service.upsert(
      { sessionId: 'sess-1', chatId: 'chat-1', pluginId: 'chatwoot-adapter', instanceId: 'i2' },
      'convB',
      { handoverState: 'human' },
    );
    expect(await service.findHandoverForChat('sess-1', 'chat-1')).toEqual({
      pluginId: 'chatwoot-adapter',
      handoverState: 'human',
    });
    expect(await service.findHandoverForChat('sess-1', 'other-chat')).toBeNull();
  });

  describe('findHandoverForChat across the lid and phone forms of one chat', () => {
    // lid 111 -> phone 628999. A 1:1 chat's neutral id flips from `111@lid` to `628999@c.us` once the
    // mapping is learned, so a takeover recorded under either form has to govern the other. The store is
    // real but its cache is empty, as for a mapping past the preload cap or evicted: only the table has it.
    const table = [{ lid: '111', phone: '628999', isReported: true }];
    const lidStore = new LidMappingStoreService({
      find: ({ where }: { where: { lid?: FindOperator<string>; phone?: FindOperator<string> } }) =>
        Promise.resolve(table.filter(r => inList(r.lid, where.lid) && inList(r.phone, where.phone))),
      findOne: ({ where }: { where: { lid: string } }) => Promise.resolve(table.find(r => r.lid === where.lid) ?? null),
    } as unknown as Repository<LidMapping>);
    const human = (chatId: string, provider = 'convB') =>
      service.upsert({ sessionId: 'sess-1', chatId, pluginId: 'chatwoot-adapter', instanceId: 'i2' }, provider, {
        handoverState: 'human',
      });
    const bot = (chatId: string, provider: string) =>
      service.upsert({ sessionId: 'sess-1', chatId, pluginId: 'chatwoot-adapter', instanceId: 'i2' }, provider);

    beforeEach(() => {
      service = new ConversationMappingService(ds.getRepository(ConversationMapping), lidStore);
    });

    it('finds a takeover stored under the lid when the chat now arrives by phone', async () => {
      await human('111@lid');
      expect(await service.findHandoverForChat('sess-1', '628999@c.us')).toEqual({
        pluginId: 'chatwoot-adapter',
        handoverState: 'human',
      });
    });

    it('finds a takeover stored under the phone when the chat arrives by lid', async () => {
      await human('628999@c.us');
      expect(await service.findHandoverForChat('sess-1', '111@lid')).toEqual({
        pluginId: 'chatwoot-adapter',
        handoverState: 'human',
      });
    });

    it('does not match another person', async () => {
      await human('111@lid');
      expect(await service.findHandoverForChat('sess-1', '628000@c.us')).toBeNull();
    });

    it('does not share takeover decisions through an unreported phone alias', async () => {
      table[0].isReported = false;
      try {
        await human('111@lid');
        expect(await service.findHandoverForChat('sess-1', '628999@c.us')).toBeNull();
        await bot('628999@c.us', 'convC');
        expect((await row('628999@c.us'))!.handoverState).toBe('bot');
        await service.setHandover((await row('628999@c.us'))!.id, 'bot');
        expect((await row('111@lid'))!.handoverState).toBe('human');
      } finally {
        table[0].isReported = true;
      }
    });

    const row = (chatId: string) =>
      service.get({ sessionId: 'sess-1', chatId, pluginId: 'chatwoot-adapter', instanceId: 'i2' });

    it('keeps the takeover when the flip makes the adapter link a fresh row under the phone form', async () => {
      await human('111@lid');
      await bot('628999@c.us', 'convC'); // linked by the flip, not a hand-back
      await bot('628999@c.us', 'convC'); // and re-linked idempotently
      expect((await row('628999@c.us'))!.handoverState).toBe('human');
      expect(await service.findHandoverForChat('sess-1', '628999@c.us')).toEqual({
        pluginId: 'chatwoot-adapter',
        handoverState: 'human',
      });
    });

    it('a hand-back under either form clears both, and an idempotent upsert does not revive it', async () => {
      await human('111@lid');
      await bot('628999@c.us', 'convC');
      await service.setHandover((await row('628999@c.us'))!.id, 'bot'); // the agent hands the chat back
      expect(await service.findHandoverForChat('sess-1', '628999@c.us')).toBeNull();
      expect(await service.findHandoverForChat('sess-1', '111@lid')).toBeNull();

      await bot('111@lid', 'convB'); // the adapter re-links the lid row with nothing changed
      expect(await service.findHandoverForChat('sess-1', '628999@c.us')).toBeNull();
    });

    it('a takeover under either form survives an idempotent upsert of the other form', async () => {
      await bot('111@lid', 'convB');
      await bot('628999@c.us', 'convC');
      await service.setHandover((await row('111@lid'))!.id, 'human');
      await bot('628999@c.us', 'convC');
      expect(await service.findHandoverForChat('sess-1', '628999@c.us')).toEqual({
        pluginId: 'chatwoot-adapter',
        handoverState: 'human',
      });
    });

    it('a hand-back reaches a row whose form was paired after the takeover', async () => {
      await human('111@lid');
      await bot('628999@c.us', 'convC'); // inherits the takeover
      table.push({ lid: '333', phone: '628999', isReported: true }); // another lid for the number is learned meanwhile
      try {
        await service.setHandover((await row('628999@c.us'))!.id, 'bot');
        expect((await row('111@lid'))!.handoverState).toBe('bot');
        expect(await service.findHandoverForChat('sess-1', '111@lid')).toBeNull();
      } finally {
        table.pop();
      }
    });

    it('a decision on one lid of a number reaches its sibling lid and the phone-form row', async () => {
      table.push({ lid: '222', phone: '628999', isReported: true });
      try {
        await bot('111@lid', 'convB');
        await bot('222@lid', 'convD');
        await service.setHandover((await row('222@lid'))!.id, 'human');
        expect(await service.findHandoverForChat('sess-1', '111@lid')).toEqual({
          pluginId: 'chatwoot-adapter',
          handoverState: 'human',
        });
        await bot('628999@c.us', 'convC'); // a phone-form row joins and inherits the takeover
        expect((await row('628999@c.us'))!.handoverState).toBe('human');
        await service.setHandover((await row('111@lid'))!.id, 'bot');
        expect((await row('628999@c.us'))!.handoverState).toBe('bot');
        expect(await service.findHandoverForChat('sess-1', '222@lid')).toBeNull();
      } finally {
        table.pop();
      }
    });

    it('a hand-back that lands while a row under the other form is being linked still reaches it', async () => {
      await human('111@lid');
      const repo = ds.getRepository(ConversationMapping);
      const insert = repo.insert.bind(repo);
      jest.spyOn(repo, 'insert').mockImplementationOnce(async (entity: Parameters<typeof insert>[0]) => {
        // The agent hands back on the lid conversation after the new row read the takeover.
        await service.setHandover((await row('111@lid'))!.id, 'bot');
        return insert(entity);
      });
      await bot('628999@c.us', 'convC');
      expect(await service.findHandoverForChat('sess-1', '628999@c.us')).toBeNull();
    });

    it('a row rebound from a deleted session keeps a takeover a fresh row in the new session does not hold', async () => {
      await human('111@lid');
      // The session is re-paired, and the chat arrives by phone before the old lid row is rebound.
      await service.upsert(
        { sessionId: 'sess-2', chatId: '628999@c.us', pluginId: 'chatwoot-adapter', instanceId: 'i2' },
        'convC',
      );
      await service.rebindSession((await row('111@lid'))!.id, 'sess-2');
      expect(await service.findHandoverForChat('sess-2', '628999@c.us')).toEqual({
        pluginId: 'chatwoot-adapter',
        handoverState: 'human',
      });
    });
  });

  it('releaseTakeovers hands a plugin back its chats and leaves the mappings and other plugins alone', async () => {
    await service.upsert(key, 'conv-1', { handoverState: 'human' });
    await service.upsert({ ...key, chatId: 'chat-2' }, 'conv-2', { handoverState: 'closed' });
    await service.upsert({ ...key, pluginId: 'other', chatId: 'chat-3' }, 'conv-3', { handoverState: 'human' });
    expect(await service.findHandoverForChat('sess-1', 'chat-1')).toMatchObject({ handoverState: 'human' });

    await service.releaseTakeovers('chatwoot');

    expect(await service.findHandoverForChat('sess-1', 'chat-1')).toBeNull();
    expect(await service.findHandoverForChat('sess-1', 'chat-2')).toBeNull();
    expect((await service.get(key))?.providerConversationId).toBe('conv-1');
    expect(await service.findHandoverForChat('sess-1', 'chat-3')).toMatchObject({
      pluginId: 'other',
      handoverState: 'human',
    });
  });

  // SQLite serves every repository from one connection, so a transaction the insert opens is shared with
  // the writes made while it is open, and the rollback of the conflict it expects would undo them too.
  it('does not undo a write made while an upsert is refused for a bound conversation', async () => {
    await service.upsert(key, 'conv-1');
    const repo = ds.getRepository(ConversationMapping);
    const other = { ...key, instanceId: 'acct2', chatId: 'chat-9' };
    let concurrent: Promise<unknown> | undefined;
    ds.subscribers.push({
      listenTo: () => ConversationMapping,
      beforeInsert: event => {
        if ((event.entity as ConversationMapping).chatId === 'chat-3') {
          concurrent = repo.insert({ ...other, providerConversationId: 'conv-9' });
        }
      },
    });

    await expect(service.upsert({ ...key, chatId: 'chat-3' }, 'conv-1')).rejects.toBeInstanceOf(
      ConversationMappingConflict,
    );
    await concurrent;

    expect(await service.get(other)).not.toBeNull();
  });

  it('delete removes the row so a later reverse-key insert no longer conflicts', async () => {
    await service.upsert(key, 'conv-1');
    const row = await service.get(key);
    if (!row) throw new Error('expected a mapping row');

    await service.delete(row.id);

    expect(await service.get(key)).toBeNull();
    // The reverse key is free again: binding conv-1 to a different chat now succeeds.
    await expect(
      service.upsert({ sessionId: 'sess-2', chatId: 'chat-2', pluginId: 'chatwoot', instanceId: 'acct1' }, 'conv-1'),
    ).resolves.toBeUndefined();
  });

  it('rebindSession moves a stale row onto the current session (forward key moves with it)', async () => {
    await service.upsert(key, 'conv-1');
    const row = await service.get(key);
    if (!row) throw new Error('expected a mapping row');

    await service.rebindSession(row.id, 'sess-2');

    expect(await service.get(key)).toBeNull();
    const rebound = await service.getByProvider(key.pluginId, key.instanceId, 'conv-1');
    expect(rebound?.sessionId).toBe('sess-2');
    expect(
      await service.get({ sessionId: 'sess-2', chatId: 'chat-1', pluginId: 'chatwoot', instanceId: 'acct1' }),
    ).not.toBeNull();
  });

  it('rebindSession supersedes (deletes) the stale row when the current session already owns the chat', async () => {
    // sess-1's row and sess-2's row bind the SAME chat for the same plugin+instance under different
    // provider conversations (e.g. the provider opened a fresh conversation after the re-pair).
    await service.upsert(key, 'conv-1');
    await service.upsert(
      { sessionId: 'sess-2', chatId: 'chat-1', pluginId: 'chatwoot', instanceId: 'acct1' },
      'conv-2',
    );
    const stale = await service.get(key);
    if (!stale) throw new Error('expected a stale mapping row');

    await service.rebindSession(stale.id, 'sess-2');

    // The forward-key collision is resolved in favor of sess-2's own (fresher) row; the stale one is gone.
    expect(await service.getByProvider('chatwoot', 'acct1', 'conv-1')).toBeNull();
    expect((await service.getByProvider('chatwoot', 'acct1', 'conv-2'))?.sessionId).toBe('sess-2');
  });
});
