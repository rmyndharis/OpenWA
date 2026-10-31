import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { SearchService } from './search.service';
import { SearchProviderRegistry } from './search-provider.registry';
import { BuiltInFtsProvider } from './providers/builtin-fts.provider';
import { ChatScopeService } from '../auth/chat-scope.service';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { AddMessagesFts1782400000000 } from '../../database/migrations/1782400000000-AddMessagesFts';

// A send through the API was once stored with the account's bare phone digits as its sender, while every
// other writer stores the account's JID. A search filtered on that JID must find both. Runs on SQLite, and
// on the postgres:16 service when DATABASE_TYPE=postgres.
describe('search sender filter on the account itself', () => {
  const PHONE = '628123456789';
  let ds: DataSource;
  let search: SearchService;

  beforeEach(async () => {
    const postgres = process.env.DATABASE_TYPE === 'postgres';
    ds = new DataSource(
      postgres
        ? {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            entities: [Message],
          }
        : { type: 'better-sqlite3', database: ':memory:', entities: [Message], synchronize: true },
    );
    await ds.initialize();
    if (postgres) {
      // The provider queries `messages` through the search path, so the table lives in the default schema.
      await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
      await ds.synchronize();
    }
    await new AddMessagesFts1782400000000().up(ds.createQueryRunner());
    const row = (waMessageId: string, from: string, direction: MessageDirection, body: string) => ({
      sessionId: 's1',
      waMessageId,
      chatId: '628987654321@c.us',
      from,
      to: '628987654321@c.us',
      body,
      type: 'text',
      direction,
      status: MessageStatus.SENT,
      timestamp: 1_700_000_000,
    });
    await ds
      .getRepository(Message)
      .save([
        row('WA_JID', `${PHONE}@c.us`, MessageDirection.OUTGOING, 'invoice sent today'),
        row('WA_LEGACY', PHONE, MessageDirection.OUTGOING, 'invoice sent last year'),
        row('WA_PEER', '628987654321@c.us', MessageDirection.INCOMING, 'invoice received'),
      ]);
    const registry = new SearchProviderRegistry();
    registry.register(new BuiltInFtsProvider(ds));
    search = new SearchService(
      registry,
      new ChatScopeService({
        findPhoneForLid: () => Promise.resolve(null),
        findLidsForPhone: () => Promise.resolve([]),
      } as unknown as LidMappingStoreService),
    );
  });

  afterEach(async () => {
    if (ds.options.type === 'postgres') await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
    await ds.destroy();
  });

  const hitsFrom = async (from: string): Promise<string[]> =>
    (await search.search({ q: 'invoice', from })).hits.map(hit => hit.waMessageId).sort();

  it('finds the rows stored under the bare digits as well as under the JID', async () => {
    expect(await hitsFrom(`${PHONE}@c.us`)).toEqual(['WA_JID', 'WA_LEGACY']);
    expect(await hitsFrom(PHONE)).toEqual(['WA_JID', 'WA_LEGACY']);
  });

  it('keeps the account out of a filter on another sender', async () => {
    expect(await hitsFrom('628987654321@c.us')).toEqual(['WA_PEER']);
  });
});
