import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { BuiltInFtsProvider } from './builtin-fts.provider';
import { AddMessagesFts1782400000000 } from '../../../database/migrations/1782400000000-AddMessagesFts';

describe('BuiltInFtsProvider (sqlite)', () => {
  let ds: DataSource;
  let provider: BuiltInFtsProvider;

  beforeEach(async () => {
    ds = new DataSource({ type: 'sqlite', database: ':memory:', entities: [Session, Message], synchronize: true });
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

  it('matches by keyword and ranks + paginates', async () => {
    const res = await provider.search({ q: 'hello', limit: 10 });
    expect(res.provider).toBe('builtin-fts');
    expect(res.hits.length).toBe(2);
    expect(res.hits.every(h => /hello/i.test(h.snippet))).toBe(true);
    expect(res.total).toBe(2);
  });

  it('scopes by sessionIds (auth) and by sessionId filter', async () => {
    const scoped = await provider.search({ q: 'hello', sessionIds: ['s1'] });
    expect(scoped.hits.every(h => h.sessionId === 's1')).toBe(true);
    const one = await provider.search({ q: 'hello', sessionId: 's2' });
    expect(one.hits.map(h => h.sessionId)).toEqual(['s2']);
  });

  it('returns empty (not error) for no matches', async () => {
    const res = await provider.search({ q: 'zzzznomatch' });
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('reports healthy', async () => {
    expect((await provider.health()).ok).toBe(true);
  });

  it('maps an FTS5 syntax error to a 400 (not an unhandled 500)', async () => {
    // SQLite FTS5 treats `"`, `(`, `*` as query grammar — an unbalanced quote is a syntax error,
    // which must surface as BadRequestException (400), never a raw 500. Postgres's
    // websearch_to_tsquery is tolerant and has no equivalent failure mode.
    await expect(provider.search({ q: '"unbalanced' })).rejects.toThrow(BadRequestException);
    await expect(provider.search({ q: '*foo' })).rejects.toThrow(BadRequestException);
    await expect(provider.search({ q: '(test' })).rejects.toThrow(BadRequestException);
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
