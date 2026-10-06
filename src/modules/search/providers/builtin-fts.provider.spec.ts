import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { BuiltInFtsProvider } from './builtin-fts.provider';
import type { SearchQuery } from '../search.types';
import { AddMessagesFts1782400000000 } from '../../../database/migrations/1782400000000-AddMessagesFts';

describe('BuiltInFtsProvider (sqlite)', () => {
  let ds: DataSource;
  let provider: BuiltInFtsProvider;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    await new AddMessagesFts1782400000000().up(ds.createQueryRunner());
    provider = new BuiltInFtsProvider(ds);
    const repo = ds.getRepository(Message);
    await repo.insert([
      {
        sessionId: 's1',
        chatId: 'c1',
        from: 'a@c.us',
        to: 'dest@c.us',
        body: 'hello world',
        type: 'text',
        direction: MessageDirection.OUTGOING,
        timestamp: 1,
      },
      {
        sessionId: 's1',
        chatId: 'c1',
        from: 'a@c.us',
        to: 'dest@c.us',
        body: 'goodbye world',
        type: 'text',
        direction: MessageDirection.OUTGOING,
        timestamp: 2,
      },
      {
        sessionId: 's2',
        chatId: 'c2',
        from: 'b@c.us',
        to: 'dest@c.us',
        body: 'hello again',
        type: 'text',
        direction: MessageDirection.INCOMING,
        timestamp: 3,
      },
    ]);
  });
  afterEach(() => ds.destroy());

  it('matches by keyword with a highlighted snippet', async () => {
    const res = await provider.search({ q: 'hello', limit: 10 });
    expect(res.provider).toBe('builtin-fts');
    expect(res.hits.length).toBe(2);
    expect(res.hits.every(h => /hello/i.test(h.snippet))).toBe(true);
    expect(res.total).toBe(2);
  });

  it('pages one hit at a time in rank, timestamp DESC, id DESC order with the full total', async () => {
    // Same length as the other two hello rows, so every hit ranks alike, and the same timestamp as
    // 'hello again', so only the id tiebreak orders that pair. limit 1 with offset > 0 makes the
    // provider count instead of taking rows.length as the total.
    await ds.getRepository(Message).insert({
      sessionId: 's2',
      chatId: 'c2',
      from: 'b@c.us',
      to: 'dest@c.us',
      body: 'hello there',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 3,
    });
    const all = await ds.getRepository(Message).find();
    const expected = all
      .filter(m => m.body?.startsWith('hello'))
      .sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1))
      .map(m => m.id);

    const paged: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const res = await provider.search({ q: 'hello', limit: 1, offset });
      expect(res.total).toBe(3);
      paged.push(...res.hits.map(h => h.messageId));
    }
    expect(paged).toEqual(expected);
    expect((await provider.search({ q: 'hello', limit: 1, offset: 3 })).hits).toEqual([]);
  });

  it('applies the chatId, from, direction, type and dateTo filters', async () => {
    await ds.getRepository(Message).insert({
      sessionId: 's1',
      chatId: 'c1',
      from: 'a@c.us',
      to: 'dest@c.us',
      body: 'hello picture',
      type: 'image',
      direction: MessageDirection.OUTGOING,
      timestamp: 2,
    });
    const bodies = async (filter: Omit<SearchQuery, 'q'>): Promise<string[]> =>
      (await provider.search({ q: 'hello', ...filter })).hits.map(h => h.body).sort();

    expect(await bodies({ chatId: 'c2' })).toEqual(['hello again']);
    expect(await bodies({ from: 'a@c.us' })).toEqual(['hello picture', 'hello world']);
    expect(await bodies({ direction: MessageDirection.INCOMING })).toEqual(['hello again']);
    expect(await bodies({ type: 'image' })).toEqual(['hello picture']);
    expect(await bodies({ type: ['text', 'image'] })).toEqual(['hello again', 'hello picture', 'hello world']);
    expect(await bodies({ dateTo: 2000 })).toEqual(['hello picture', 'hello world']);
    // Epoch 0 is a bound like any other, not "no bound": nothing is that old.
    expect(await bodies({ dateTo: 0 })).toEqual([]);

    const combined = { chatId: 'c1', from: 'a@c.us', direction: MessageDirection.OUTGOING, type: 'text' as const };
    expect(await bodies({ ...combined, dateTo: 1000 })).toEqual(['hello world']);
    // Counted rather than taken from rows.length, with every filter bound in the count query too.
    const page = await provider.search({ q: 'hello', ...combined, dateTo: 3000, limit: 1, offset: 1 });
    expect(page.hits).toEqual([]);
    expect(page.total).toBe(1);
  });

  it('scopes by sessionIds (auth) and by sessionId filter', async () => {
    const scoped = await provider.search({ q: 'hello', sessionIds: ['s1'] });
    expect(scoped.hits.every(h => h.sessionId === 's1')).toBe(true);
    const one = await provider.search({ q: 'hello', sessionId: 's2' });
    expect(one.hits.map(h => h.sessionId)).toEqual(['s2']);
  });

  it('scopes by chatIds (auth allowlist) before limit/offset/total', async () => {
    // The chat fence arrives as the stored-dialect forms of the key's allowlist (lid expansion is
    // ChatScopeService's job); hits in any other chat disappear from the page AND from the count,
    // so pagination windows stay honest.
    const scoped = await provider.search({ q: 'hello', chatIds: ['c2'] });
    expect(scoped.hits.map(h => h.chatId)).toEqual(['c2']);
    expect(scoped.total).toBe(1);
    const none = await provider.search({ q: 'hello', chatIds: ['cX'] });
    expect(none.hits).toEqual([]);
    expect(none.total).toBe(0);
    await ds.getRepository(Message).insert({
      sessionId: 's2',
      chatId: 'c2',
      from: 'b@c.us',
      to: 'dest@c.us',
      body: 'hello there',
      type: 'text',
      direction: MessageDirection.INCOMING,
      timestamp: 4,
    });
    const pages = await Promise.all(
      [0, 1, 2].map(offset => provider.search({ q: 'hello', chatIds: ['c2'], limit: 1, offset })),
    );
    expect(pages.map(page => page.total)).toEqual([2, 2, 2]);
    expect(pages.flatMap(page => page.hits).map(hit => hit.chatId)).toEqual(['c2', 'c2']);
    expect(new Set(pages.flatMap(page => page.hits).map(hit => hit.messageId)).size).toBe(2);
    expect((await provider.search({ q: 'hello', chatIds: ['c2'], chatId: 'c1' })).total).toBe(0);
    expect((await provider.search({ q: 'hello', chatIds: ['c2'], sessionIds: ['s1'] })).total).toBe(0);
  });

  it.each([0, 1])('returns no hits or count for an empty compiled chat scope at offset %s', async offset => {
    const result = await provider.search({ q: 'hello', chatIds: [], limit: 1, offset });
    expect(result.hits).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns empty (not error) for no matches', async () => {
    const res = await provider.search({ q: 'zzzznomatch' });
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('reports healthy', async () => {
    expect((await provider.health()).ok).toBe(true);
  });

  it('sanitizes FTS5 grammar characters instead of 400ing (chatIds, quotes, parens stay searchable)', async () => {
    // User input is quoted per-token (toFts5Query), so `"`, `(`, `*`, `@` match literally — a chatId
    // like 262813461250071@lid is a normal search term here, not a grammar error. Verified against
    // live FTS5: `a b` and `"a" "b"` are identical (implicit AND), so multi-token semantics hold.
    for (const q of ['"unbalanced', '*foo', '(test', '262813461250071@lid', 'a@c.us']) {
      await expect(provider.search({ q })).resolves.toMatchObject({ provider: 'builtin-fts' });
    }
  });

  it('keeps multi-token AND semantics after quoting', async () => {
    // Both rows carry 'hello' AND 'world'... exactly one does ('goodbye world' lacks 'hello').
    const res = await provider.search({ q: 'hello world' });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0].body).toBe('hello world');
  });

  it('treats dateFrom/dateTo as epoch-ms against a seconds timestamp column', async () => {
    // Contract (DTO + docs) is epoch-ms, but messages.timestamp stores epoch-seconds (WhatsApp
    // messageTimestamp). Seed a row at a known seconds value and assert: a dateFrom in ms that
    // covers it includes the hit, while a dateFrom one second later (also in ms) excludes it. This
    // pins the ms→seconds conversion at the bind boundary — without it `seconds >= ms` is false for
    // every modern row and dateFrom silently excludes all results.
    const repo = ds.getRepository(Message);
    const tsSeconds = 1_700_000_000;
    await repo.insert({
      sessionId: 's1',
      chatId: 'c1',
      from: 'a@c.us',
      to: 'dest@c.us',
      body: 'datefilter probe term',
      type: 'text',
      direction: MessageDirection.OUTGOING,
      timestamp: tsSeconds,
    });

    const included = await provider.search({ q: 'datefilter', dateFrom: tsSeconds * 1000 });
    expect(included.hits.map(h => h.body)).toContain('datefilter probe term');

    const excluded = await provider.search({ q: 'datefilter', dateFrom: (tsSeconds + 1) * 1000 });
    expect(excluded.hits).toEqual([]);
  });

  it('the FTS UPDATE trigger carries a WHEN body-change guard (not fire on ack-only updates)', async () => {
    // The messages_fts_au trigger must be guarded so it only re-indexes when body actually changes.
    // Without the WHEN clause every ack (SENT→DELIVERED→READ) and reaction does a redundant FTS
    // delete+insert on the busiest message path. Assert the definition in sqlite_master includes the
    // WHEN guard so a future regression that drops it is caught here, not just in production write
    // amplification. The body-change re-index path itself is covered by the revoke test below.
    const rows: unknown[] = await ds.query(
      `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_au'`,
    );
    expect(String((rows[0] as { sql?: string })?.sql ?? '')).toMatch(/WHEN\s+OLD\.body\s+IS\s+NOT\s+NEW\.body/i);
  });

  it('re-indexes on a body UPDATE (revoke path: body changes, FTS reflects the new value)', async () => {
    // A body UPDATE must still re-index — the WHEN guard must not suppress legitimate body changes.
    // The revoke flow sets body to empty; assert the FTS index reflects the new body and no longer
    // matches the old term, while a new search for a freshly-written body still hits.
    const repo = ds.getRepository(Message);
    await repo.update({ body: 'hello world' }, { body: 'goodbye updated' });
    const oldTerm = await provider.search({ q: 'hello' });
    expect(oldTerm.hits.map(h => h.body)).not.toContain('hello world');
    const newTerm = await provider.search({ q: 'goodbye' });
    expect(newTerm.hits.map(h => h.body)).toContain('goodbye updated');
  });
});
