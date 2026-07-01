import { DataSource } from 'typeorm';
import { ConversationMapping } from './entities/conversation-mapping.entity';
import { ConversationMappingService, MappingKey } from './conversation-mapping.service';
import { AddIntegrationFabric1781900000000 } from '../../database/migrations/1781900000000-AddIntegrationFabric';

describe('ConversationMappingService', () => {
  let ds: DataSource;
  let service: ConversationMappingService;
  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [ConversationMapping], migrations: [] });
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
});
