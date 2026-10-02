import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, Logger } from 'typeorm';
import { MessageService } from './message.service';
import { Message, MessageDirection } from './entities/message.entity';
import { parseMessageWindow, validateMessageWindow } from './message-window';
import { AddMessageWindowIndexes1790812800000 } from '../../database/migrations/1790812800000-AddMessageWindowIndexes';

describe('message-time selection', () => {
  let ds: DataSource;
  let service: MessageService;
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const logger: Logger = {
    logQuery: (sql, params) => queries.push({ sql, params: params as unknown[] }),
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
      {} as never,
      {} as never,
      {} as never,
      { findLidsForPhone: () => Promise.resolve([]), findPhoneForLid: () => Promise.resolve(null) } as never,
      {} as never,
      {} as never,
    );
    const rows = Array.from({ length: 240 }, (_, i) => ({
      id: randomUUID(),
      sessionId: 's1',
      chatId: '100@g.us',
      from: '100@g.us',
      to: 'me',
      waMessageId: `m${i}`,
      body: `m${i}`,
      timestamp: 1000 + Math.floor(i / 4),
      direction: i % 2 ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
      // Reverse ingestion order and repeated times: message time cannot be inferred from createdAt.
      createdAt: new Date((2000 - Math.floor(i / 3)) * 1000),
    }));
    await ds.getRepository(Message).save(rows);
    await ds
      .getRepository(Message)
      .save({ sessionId: 's1', chatId: '100@g.us', from: 'x', to: 'me', body: 'unknown time' });
    queries.length = 0;
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('reads one exact reference without widening its session or chat', async () => {
    const selected = await service.getMessages('s1', { chatId: '100@g.us', messageId: 'm42', inlineMedia: false });
    expect(selected.total).toBe(1);
    expect(selected.messages[0].body).toBe('m42');
    expect((await service.getMessages('s2', { messageId: 'm42' })).total).toBe(0);
    expect((await service.getMessages('s1', { chatId: '200@g.us', messageId: 'm42' })).total).toBe(0);
    expect(() => parseMessageWindow({ messageId: '' })).toThrow();
  });

  it('excludes imported stories before paging, totals and unknown-time gaps without deleting them', async () => {
    const repo = ds.getRepository(Message);
    await repo.save(
      Array.from({ length: 40 }, (_, i) => ({
        sessionId: 's1',
        chatId: 'status@broadcast',
        from: 'status@broadcast',
        to: 'me',
        waMessageId: `story${i}`,
        timestamp: i ? 1059 : undefined,
        body: 'story',
      })),
    );
    let after: string | undefined;
    const ids: string[] = [];
    do {
      const page = await service.getMessages('s1', { orderBy: 'timestamp', limit: 31, after });
      expect(page.total).toBe(240);
      expect(page.unknownTimestampTotal).toBe(1);
      expect(page.messages.every(m => m.chatId !== 'status@broadcast')).toBe(true);
      ids.push(...page.messages.map(m => m.id));
      if (page.messages.length < 31) break;
      after = page.messages.at(-1)!.id;
    } while (ids.length < 300);
    expect(new Set(ids).size).toBe(240);
    expect(await repo.countBy({ chatId: 'status@broadcast' })).toBe(40);
    expect((await service.getMessages('s1', { messageId: 'story1' })).total).toBe(0);
  });

  it('uses message time, inclusive since and exclusive until, without flooring milliseconds', async () => {
    const selected = await service.getMessages('s1', {
      since: 1000_001,
      until: 1003_000,
      orderBy: 'timestamp',
      direction: MessageDirection.INCOMING,
    });
    expect(selected.total).toBe(4);
    expect(selected.unknownTimestampTotal).toBe(0);
    expect(selected.messages.map(m => m.timestamp)).toEqual([1002, 1002, 1001, 1001]);
    expect(selected.messages.every(m => m.direction === MessageDirection.INCOMING)).toBe(true);
  });

  it('walks more than 100 tied rows once, despite a younger arrival between pages', async () => {
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await service.getMessages('s1', {
        since: 1000_000,
        until: 1060_000,
        orderBy: 'timestamp',
        limit: 31,
        after,
        inlineMedia: false,
      });
      ids.push(...page.messages.map(m => m.id));
      if (!after)
        await ds
          .getRepository(Message)
          .save({ sessionId: 's1', chatId: '100@g.us', from: 'x', to: 'me', timestamp: 1060, body: 'new arrival' });
      if (page.messages.length < 31) break;
      after = page.messages.at(-1)!.id;
    } while (ids.length < 300);
    expect(ids).toHaveLength(240);
    expect(new Set(ids).size).toBe(240);
  });

  it('rejects unknown, deleted and selection-mismatched anchors instead of returning false exhaustion', async () => {
    const page = await service.getMessages('s1', { chatId: '100@g.us', orderBy: 'timestamp', limit: 1 });
    const anchor = page.messages[0];
    for (const options of [
      { chatId: '200@g.us', after: anchor.id },
      { until: 1000_000, after: anchor.id },
      { after: randomUUID() },
    ])
      await expect(service.getMessages('s1', { ...options, orderBy: 'timestamp' })).rejects.toThrow('Unknown cursor');
    await ds.getRepository(Message).delete(anchor.id);
    await expect(service.getMessages('s1', { orderBy: 'timestamp', after: anchor.id })).rejects.toThrow(
      'Unknown cursor',
    );
  });

  it('keeps legacy ingestion order and unknown-time rows when new options are absent', async () => {
    expect((await service.getMessages('s1')).total).toBe(241);
    expect((await service.getMessages('s1', { orderBy: 'timestamp' })).total).toBe(240);
    expect((await service.getMessages('s1', { orderBy: 'timestamp' })).unknownTimestampTotal).toBe(1);
  });
  it('filters message type without requiring search text', async () => {
    const repo = ds.getRepository(Message);
    const row = (await repo.find({ take: 1 }))[0];
    await repo.update(row.id, { type: 'image', timestamp: 1001 });
    const page = await service.getMessages('s1', {
      since: 1000_000,
      until: 1060_000,
      orderBy: 'timestamp',
      type: 'image',
    });
    expect(page.total).toBe(1);
    expect(page.messages.map(m => m.type)).toEqual(['image']);
  });

  it.each([
    [{ orderBy: 'timestamp' }, 'IDX_messages_session_timestamp_id'],
    [{ orderBy: 'timestamp', chatId: '100@g.us' }, 'IDX_messages_session_chat_timestamp_id'],
    [{ orderBy: 'timestamp', direction: MessageDirection.INCOMING }, 'IDX_messages_session_direction_timestamp_id'],
  ] as const)('seeks the bounded time window through its compound index (%p)', async (options, index) => {
    await service.getMessages('s1', { ...options, since: 1000_000, until: 1060_000 });
    const page = queries.find(q => q.sql.includes('ORDER BY') && q.sql.includes('LIMIT'))!;
    const plan = await ds.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${page.sql}`, page.params);
    expect(plan.map((r: { detail: string }) => r.detail).join(' ')).toContain(index);
    expect(plan.map((r: { detail: string }) => r.detail).join(' ')).not.toContain('TEMP B-TREE');
  });

  it('migration and synchronize converge; migration can be applied twice', async () => {
    const runner = ds.createQueryRunner();
    const migration = new AddMessageWindowIndexes1790812800000();
    await migration.up(runner);
    await migration.up(runner);
    const indexes = (await runner.query('PRAGMA index_list(messages)')) as Array<{ name: string }>;
    const names = indexes.map(r => r.name);
    expect(names.filter((n: string) => n.startsWith('IDX_messages_session_')).sort()).toEqual([
      'IDX_messages_session_chat_timestamp_id',
      'IDX_messages_session_direction_timestamp_id',
      'IDX_messages_session_timestamp_id',
    ]);
    await runner.release();
  });
});

describe('message-window HTTP validation', () => {
  it('keeps absent options absent and parses fractional millisecond bounds', () => {
    expect(parseMessageWindow({})).toEqual({});
    expect(
      parseMessageWindow({ since: '1000000.5', until: '1001000', direction: 'incoming', orderBy: 'timestamp' }),
    ).toEqual({
      since: 1000000.5,
      until: 1001000,
      direction: 'incoming',
      orderBy: 'timestamp',
    });
  });
  it.each(['', ' ', 'NaN', 'Infinity', '-1', '0x10', '123ms', '1e4'])('rejects invalid HTTP timestamps %p', since => {
    expect(() => parseMessageWindow({ since })).toThrow();
  });
  it.each([
    { since: NaN },
    { until: Infinity },
    { since: -1 },
    { since: 1, until: 1 },
    { since: 2, until: 1 },
    { direction: 'any' },
    { orderBy: 'random' },
  ])('rejects invalid internal selection %p', value => {
    expect(() => validateMessageWindow(value as never)).toThrow();
  });
});
