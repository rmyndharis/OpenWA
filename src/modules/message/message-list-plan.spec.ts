import 'reflect-metadata';
import { DataSource, Logger } from 'typeorm';
import { MessageService } from './message.service';
import { Message } from './entities/message.entity';
import type { EngineRegistry } from '../../engine/engine-registry.service';
import type { MessageProjector } from '../session/message-projector.service';
import type { HookManager } from '../../core/hooks';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { SendPacingService } from './send-pacing.service';
import type { MessageSendService } from './message-send.service';

/**
 * A chat thread is read with a chatId IN (...) filter, and SQLite here never has planner statistics.
 * Without them it walked the whole session through (sessionId, createdAt) to fill one chat's page,
 * so the plans of the statements getMessages actually issues are pinned against the entity schema.
 */
describe('message list query plans on SQLite', () => {
  let ds: DataSource;
  let service: MessageService;
  const queries: Array<{ sql: string; params?: unknown[] }> = [];

  const logger: Logger = {
    logQuery: (sql, params) => {
      queries.push({ sql, params: params as unknown[] | undefined });
    },
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
  };

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
      logging: ['query'],
      logger,
    });
    await ds.initialize();
    service = new MessageService(
      ds.getRepository(Message),
      {} as EngineRegistry,
      {} as MessageProjector,
      {} as HookManager,
      {
        findLidsForPhone: () => Promise.resolve([]),
        findPhoneForLid: () => Promise.resolve(null),
      } as unknown as LidMappingStoreService,
      {} as SendPacingService,
      {} as MessageSendService,
    );
    queries.length = 0;
  });

  afterEach(async () => {
    await ds.destroy();
  });

  /** The ordered, limited statement that picks the page. */
  const pageQuery = (): { sql: string; params?: unknown[] } => {
    const page = queries.find(q => q.sql.includes('ORDER BY') && q.sql.includes('LIMIT'));
    expect(page).toBeDefined();
    return page!;
  };

  /** EXPLAIN QUERY PLAN of the page select getMessages issued. */
  const pagePlan = async (): Promise<string> => {
    const page = pageQuery();
    const rows = await ds.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${page.sql}`, page.params);
    return rows.map(r => r.detail).join(' | ');
  };

  const countPlan = async (): Promise<string> => {
    const count = queries.find(q => q.sql.includes('COUNT('));
    expect(count).toBeDefined();
    const rows = await ds.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${count!.sql}`, count!.params);
    return rows.map(r => r.detail).join(' | ');
  };

  it('seeks one user chat through the (sessionId, chatId, createdAt) index', async () => {
    // A user chat expands to several dialect candidates (@c.us and @s.whatsapp.net at least).
    await service.getMessages('s1', { chatId: '628123@c.us', limit: 50 });

    expect(await pagePlan()).toContain('IDX_messages_sessionId_chatId_createdAt (sessionId=? AND chatId=?)');
    expect(await countPlan()).toContain('IDX_messages_sessionId_chatId_createdAt (sessionId=? AND chatId=?)');
  });

  it('reads a single-candidate chat from the same index in order, with no sort', async () => {
    await service.getMessages('s1', { chatId: '120363@g.us', limit: 50 });

    const plan = await pagePlan();
    expect(plan).toContain('IDX_messages_sessionId_chatId_createdAt (sessionId=? AND chatId=?)');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('keeps the unfiltered list on the (sessionId, createdAt) index with no sort', async () => {
    await service.getMessages('s1', { limit: 50 });

    const plan = await pagePlan();
    expect(plan).toContain('(sessionId=?)');
    expect(plan).not.toContain('chatId');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  /**
   * A sort evaluates its result columns for every matching row before the limit applies, so a size
   * computed in the ordered statement read the stored payload of every row in the chat. The size is
   * read by id for the page rows only, and as a byte count, which neither dialect has to load the
   * payload for.
   */
  it('reads metadata sizes for the page rows only, outside the ordered statement', async () => {
    const repo = ds.getRepository(Message);
    await repo.save(
      ['a', 'b', 'c'].map(n =>
        repo.create({ sessionId: 's1', chatId: '628123@c.us', waMessageId: n, from: 'x', to: 'y', body: n }),
      ),
    );
    queries.length = 0;

    const { messages } = await service.getMessages('s1', { chatId: '628123@c.us', limit: 2 });

    expect(messages).toHaveLength(2);
    expect(pageQuery().sql).not.toMatch(/metadata/i);
    const sizes = queries.filter(q => /LENGTH\(/i.test(q.sql));
    expect(sizes).toHaveLength(1);
    expect(sizes[0].sql).toMatch(/OCTET_LENGTH\(/);
    expect(sizes[0].sql).not.toMatch(/(^|[^_])LENGTH\(/);
    expect(sizes[0].sql).not.toContain('ORDER BY');
  });
});
