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
    const foreign = await ds.getRepository(Message).findOneByOrFail({ waMessageId: 'm43' });
    await expect(service.getMessages('s1', { messageId: 'm42', after: foreign.id })).rejects.toThrow('Unknown cursor');
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

  it('keeps zero message time distinct from a positive subsecond boundary', async () => {
    await ds.getRepository(Message).update({ waMessageId: 'm0' }, { timestamp: 0 });
    expect((await service.getMessages('s1', { messageId: 'm0', since: Number.MIN_VALUE })).total).toBe(0);
    expect((await service.getMessages('s1', { messageId: 'm0', until: Number.MIN_VALUE })).total).toBe(1);
    expect((await service.getMessages('s1', { messageId: 'm0', since: 0, until: 1 })).total).toBe(1);
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
      { messageId: 'non-existent-wamid', after: anchor.id },
      { until: 1000_000, after: anchor.id },
      { after: randomUUID() },
    ])
      await expect(service.getMessages('s1', { ...options, orderBy: 'timestamp' })).rejects.toThrow('Unknown cursor');
    await ds.getRepository(Message).delete(anchor.id);
    await expect(service.getMessages('s1', { orderBy: 'timestamp', after: anchor.id })).rejects.toThrow(
      'Unknown cursor',
    );
  });

  it('continues keyset pagination when chatId or from LID mappings change between pages', async () => {
    const repo = ds.getRepository(Message);
    const first = await repo.save({
      sessionId: 's1',
      chatId: '77777@lid',
      from: '77777@lid',
      to: 'me@c.us',
      body: 'page 1 via lid',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 2000,
    });
    const second = await repo.save({
      sessionId: 's1',
      chatId: '628999@c.us',
      from: '628999@c.us',
      to: 'me@c.us',
      body: 'page 2 via pn',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 1990,
    });

    const page = await service.getMessages('s1', {
      chatId: '628999@c.us',
      direction: MessageDirection.INCOMING,
      type: 'text',
      since: 1900_000,
      until: 2100_000,
      orderBy: 'timestamp',
      after: first.id,
    });
    expect(page.messages.map(m => m.id)).toEqual([second.id]);
  });

  // The membership check is switched on by the selection itself. orderBy 'timestamp' does that alone,
  // so the cases below keep the default order: each filter has to switch the check on in its own right.
  it.each(['direction', 'type', 'since', 'until'] as const)(
    'rejects a cursor outside a selection narrowed only by %s',
    async filter => {
      const repo = ds.getRepository(Message);
      await repo.update({ waMessageId: 'm10' }, { type: 'image' });
      const row = (waMessageId: string): Promise<Message> => repo.findOneByOrFail({ waMessageId });
      // m1 is outgoing and m11 is text; m0 is the oldest in message time and m200 is newer than 1010 s.
      const cases = {
        direction: [{ direction: MessageDirection.INCOMING }, await row('m1')],
        type: [{ type: 'image' }, await row('m11')],
        since: [{ since: 1050_000 }, await row('m0')],
        until: [{ until: 1010_000 }, await row('m200')],
      } as const;
      const [selection, anchor] = cases[filter];

      await expect(service.getMessages('s1', { ...selection, after: anchor.id })).rejects.toThrow(
        'Unknown cursor for this message selection',
      );
    },
  );

  it.each([
    ['since', { since: 1000_000 }],
    ['until', { until: 1060_000 }],
  ] as const)('counts the rows without a message time when only %s bounds the selection', async (_bound, options) => {
    const page = await service.getMessages('s1', options);

    expect(page.unknownTimestampTotal).toBe(1);
  });

  it('keeps legacy ingestion order and unknown-time rows when new options are absent', async () => {
    const legacy = await service.getMessages('s1');
    expect(legacy.total).toBe(241);
    expect(legacy.messages[0].body).toBe('unknown time');
    expect((await service.getMessages('s1', { orderBy: 'timestamp' })).total).toBe(240);
    expect((await service.getMessages('s1', { orderBy: 'timestamp' })).unknownTimestampTotal).toBe(1);
    await ds.getRepository(Message).save({ sessionId: 's1', chatId: 'status@broadcast', from: 'x', to: 'me' });
    expect((await service.getMessages('s1')).total).toBe(242);
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

  // A user chat expands to several id candidates (one per dialect). SQLite has no planner statistics
  // here, so a plain sort key makes it walk the session's whole time index and filter the chat row by
  // row; the unary plus on the key makes it seek the chat index and sort only that chat's rows.
  it('seeks the chat index, not the session time index, for a user chat with several id candidates', async () => {
    await service.getMessages('s1', { orderBy: 'timestamp', chatId: '1001@c.us', since: 1000_000, until: 1060_000 });
    const page = queries.find(q => q.sql.includes('ORDER BY') && q.sql.includes('LIMIT'))!;
    const plan = await ds.query<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${page.sql}`, page.params);
    const details = plan.map((r: { detail: string }) => r.detail).join(' ');
    expect(details).toContain('IDX_messages_session_chat_timestamp_id');
    expect(details).not.toContain('IDX_messages_session_timestamp_id');
  });

  it('migration preserves rows when applied and reverted', async () => {
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
    await migration.down(runner);
    expect(await ds.getRepository(Message).count()).toBe(241);
    const reverted = (await runner.query('PRAGMA index_list(messages)')) as Array<{ name: string }>;
    expect(reverted.some(row => row.name.startsWith('IDX_messages_session_'))).toBe(false);
    await migration.up(runner);
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
  it('accepts scientific notation used by SDK numeric query serializers', () => {
    expect(parseMessageWindow({ since: '1.7898552E12', until: '1.7899416E12' })).toEqual({
      since: 1789855200000,
      until: 1789941600000,
    });
  });
  it.each(['', ' ', 'NaN', 'Infinity', '-1', '0x10', '123ms', '1e400', '9007199254740992'])(
    'rejects invalid HTTP timestamps %p',
    since => {
      expect(() => parseMessageWindow({ since })).toThrow();
    },
  );
  it.each([
    { since: NaN },
    { until: Infinity },
    { since: Number.MAX_SAFE_INTEGER + 1 },
    { since: -1 },
    { since: 1, until: 1 },
    { since: 2, until: 1 },
    { direction: 'any' },
    { orderBy: 'random' },
  ])('rejects invalid internal selection %p', value => {
    expect(() => validateMessageWindow(value as never)).toThrow();
  });
});
