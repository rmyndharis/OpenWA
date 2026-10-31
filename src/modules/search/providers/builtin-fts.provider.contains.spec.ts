import 'reflect-metadata';
import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Message, MessageDirection } from '../../../modules/message/entities/message.entity';
import { Session } from '../../../modules/session/entities/session.entity';
import { AddMessagesFts1782400000000 } from '../../../database/migrations/1782400000000-AddMessagesFts';
import * as sharedConnection from '../../../common/utils/shared-connection';
import { SEARCH_CONTAINS_TERMS_MAX_LENGTH, SEARCH_CONTAINS_WINDOW } from '../search.constants';
import { ContainsTermsRefusedError } from '../search-terms';
import {
  BuiltInFtsProvider,
  postgresUnaccentFunctionDdl,
  sqliteSupportsTrigramDiacritics,
} from './builtin-fts.provider';

/**
 * SQLite runtime coverage for match=contains: the FTS5 trigram index buildContainsIndex builds when
 * SEARCH_CONTAINS_ENABLED is on, queried through BuiltInFtsProvider. Companion to
 * builtin-fts.provider.spec.ts (match=word); the Postgres branch runs in
 * builtin-fts.provider.contains.pg.spec.ts.
 */
const row = (sessionId: string, chatId: string, body: string, direction: MessageDirection, timestamp: number) => ({
  sessionId,
  chatId,
  from: `${chatId}@c.us`,
  to: 'me@c.us',
  body,
  type: 'text',
  direction,
  timestamp,
});

const containsOn = new ConfigService({ search: { containsEnabled: true } });

async function boot(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [Session, Message],
    synchronize: true,
  });
  await ds.initialize();
  await new AddMessagesFts1782400000000().up(ds.createQueryRunner());
  await ds
    .getRepository(Message)
    .insert([
      row('s1', 'c1', 'Your invoice INV-2048 is ready for download', MessageDirection.INCOMING, 10),
      row('s1', 'c2', 'Thanks, I will pay the invoice today', MessageDirection.OUTGOING, 20),
      row('s2', 'c3', 'Meeting moved to the Café Résumé at 10am', MessageDirection.INCOMING, 30),
      row('s1', 'c4', 'Order shipped with a 10% discount, tracking id 42', MessageDirection.INCOMING, 40),
    ]);
  return ds;
}

describe('BuiltInFtsProvider match=contains (sqlite)', () => {
  let ds: DataSource;
  let provider: BuiltInFtsProvider;

  beforeEach(async () => {
    ds = await boot();
    provider = new BuiltInFtsProvider(ds, containsOn);
    await provider.buildContainsIndex();
  });
  afterEach(async () => {
    await ds.destroy();
  });

  it('finds any part of a word and marks it in the snippet', async () => {
    const res = await provider.search({ q: 'voic', match: 'contains' });

    expect(res.total).toBe(2);
    expect(res.hits.map(h => h.snippet).sort()).toEqual([
      'Thanks, I will pay the in<mark>voic</mark>e today',
      'Your in<mark>voic</mark>e INV-2048 is ready for download',
    ]);
  });

  it('ignores case and accents in both the query and the body', async () => {
    for (const q of ['cafe', 'CAFÉ', 'resume']) {
      const res = await provider.search({ q, match: 'contains' });
      expect(res.hits.map(h => h.chatId)).toEqual(['c3']);
    }
  });

  it('requires every term, as match=word does', async () => {
    const res = await provider.search({ q: 'invoice 2048', match: 'contains' });

    expect(res.hits.map(h => h.chatId)).toEqual(['c1']);
    expect(res.hits[0].snippet).toBe('Your <mark>invoice</mark> INV-<mark>2048</mark> is ready for download');
  });

  it('narrows with a term shorter than a trigram instead of dropping it', async () => {
    expect((await provider.search({ q: 'invoice to', match: 'contains' })).hits.map(h => h.chatId)).toEqual(['c2']);
    expect((await provider.search({ q: 'tracking id', match: 'contains' })).total).toBe(1);
  });

  it('rejects a query made only of terms shorter than a trigram', async () => {
    await expect(provider.search({ q: 'id to', match: 'contains' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('counts a Hangul syllable as one character, so a two-syllable word only narrows', async () => {
    await ds
      .getRepository(Message)
      .insert([
        row('s1', 'c5', '서울역에서 만나요', MessageDirection.INCOMING, 50),
        row('s1', 'c6', 'invoice 한국 지사로 보냄', MessageDirection.INCOMING, 60),
      ]);

    await expect(provider.search({ q: '서울', match: 'contains' })).rejects.toBeInstanceOf(ContainsTermsRefusedError);
    const station = await provider.search({ q: '서울역', match: 'contains' });
    expect(station.hits.map(h => [h.chatId, h.snippet])).toEqual([['c5', '<mark>서울역</mark>에서 만나요']]);
    expect((await provider.search({ q: 'invoice 한국', match: 'contains' })).hits.map(h => h.chatId)).toEqual(['c6']);
  });

  it('marks a Greek word whose final sigma the body writes in capitals', async () => {
    await ds.getRepository(Message).insert(row('s1', 'c5', 'ΚΑΛΟΣ ΔΡΟΜΟΣ σήμερα', MessageDirection.INCOMING, 50));
    const query = jest.spyOn(ds, 'query');

    const res = await provider.search({ q: 'δρομος', match: 'contains' });

    expect(res.hits.map(h => [h.snippet, h.score])).toEqual([['ΚΑΛΟΣ <mark>ΔΡΟΜΟΣ</mark> σήμερα', 3]]);
    // Only the application reads final sigma as sigma: the database is sent the term as written.
    expect(query.mock.calls.at(-1)?.[1]).toContain('"δρομος"');
  });

  it('bounds the characters of the terms together, spaces not counted', async () => {
    const max = 'a'.repeat(SEARCH_CONTAINS_TERMS_MAX_LENGTH);
    expect((await provider.search({ q: max, match: 'contains' })).total).toBe(0);
    for (const q of [`${max}b`, `${max.slice(0, 40)} ${max.slice(0, 25)}x`]) {
      await expect(provider.search({ q, match: 'contains' })).rejects.toBeInstanceOf(ContainsTermsRefusedError);
    }
    // A repeated term counts once, as it runs once.
    expect((await provider.search({ q: `${max} ${max.toUpperCase()}`, match: 'contains' })).total).toBe(0);
  });

  it('matches a LIKE wildcard in a term literally', async () => {
    expect((await provider.search({ q: '10%', match: 'contains' })).total).toBe(1);
    expect((await provider.search({ q: 'invoice _', match: 'contains' })).total).toBe(0);
  });

  it('ranks whole words, then word starts, then the rest, newest first within a score', async () => {
    await ds
      .getRepository(Message)
      .insert([
        row('s1', 'c5', 'Reinvoice requested by finance', MessageDirection.INCOMING, 60),
        row('s1', 'c6', 'Invoiced orders are listed below', MessageDirection.INCOMING, 50),
      ]);

    const res = await provider.search({ q: 'invoice', match: 'contains' });

    expect(res.hits.map(h => [h.chatId, h.score])).toEqual([
      ['c2', 3],
      ['c1', 3],
      ['c6', 2],
      ['c5', 1],
    ]);
  });

  it('pages the ranked window with a stable order and its total', async () => {
    const all = await provider.search({ q: 'invoice', match: 'contains' });
    const page1 = await provider.search({ q: 'invoice', match: 'contains', limit: 1 });
    const page2 = await provider.search({ q: 'invoice', match: 'contains', limit: 1, offset: 1 });

    expect(page1.total).toBe(2);
    expect([...page1.hits, ...page2.hits].map(h => h.messageId)).toEqual(all.hits.map(h => h.messageId));
    expect((await provider.search({ q: 'invoice', match: 'contains', offset: 2 })).hits).toEqual([]);
  });

  it('ranks only the most recently stored matches, so one search does bounded work', async () => {
    const bulk = Array.from({ length: SEARCH_CONTAINS_WINDOW + 5 }, (_, i) =>
      row('s1', 'c7', `Bulk invoice ${i}`, MessageDirection.INCOMING, 100 + i),
    );
    // In batches: TypeORM re-reads inserted rows with one OR term each, past SQLite's expression depth.
    for (let i = 0; i < bulk.length; i += 200) await ds.getRepository(Message).insert(bulk.slice(i, i + 200));

    const res = await provider.search({ q: 'invoice', match: 'contains', limit: 100, offset: 900 });

    expect(res.total).toBe(SEARCH_CONTAINS_WINDOW);
    expect(Math.min(...res.hits.map(h => h.timestamp))).toBe(100 + 5);

    // The filters apply before the window, so a date bound reaches the matches older than it.
    const older = await provider.search({ q: 'invoice', match: 'contains', dateTo: 99_000 });
    expect(older.hits.map(h => h.chatId)).toEqual(['c2', 'c1']);
    const narrower = await provider.search({ q: 'invoice 2048', match: 'contains' });
    expect(narrower.hits.map(h => h.chatId)).toEqual(['c1']);
  });

  it('applies the structural filters and returns each hit its own score to a scoped caller', async () => {
    const res = await provider.search({ q: 'meeting', match: 'contains', sessionIds: ['s2'] });
    expect(res.hits.map(h => h.chatId)).toEqual(['c3']);
    expect(res.hits[0].score).toBe(3);

    const outgoing = await provider.search({ q: 'invoice', match: 'contains', direction: MessageDirection.OUTGOING });
    expect(outgoing.hits.map(h => h.chatId)).toEqual(['c2']);
    expect((await provider.search({ q: 'invoice', match: 'contains', chatIds: [] })).total).toBe(0);
  });

  it('leaves match=word unchanged: whole words only', async () => {
    expect((await provider.search({ q: 'voic' })).total).toBe(0);
    expect((await provider.search({ q: 'invoice', match: 'word' })).total).toBe(2);
  });

  it('keeps the trigram index in sync on update and delete', async () => {
    const repo = ds.getRepository(Message);
    const target = await repo.findOneByOrFail({ chatId: 'c2' });

    await repo.update({ id: target.id }, { body: 'Thanks, I will pay the receipt today' });
    expect((await provider.search({ q: 'receip', match: 'contains' })).hits.map(h => h.chatId)).toEqual(['c2']);
    expect((await provider.search({ q: 'invoice', match: 'contains' })).total).toBe(1);

    await repo.delete({ id: target.id });
    expect((await provider.search({ q: 'receip', match: 'contains' })).total).toBe(0);
  });
});

describe('BuiltInFtsProvider trigram index build (sqlite)', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = await boot();
  });
  afterEach(async () => {
    await ds.destroy();
  });

  const trigramTables = async () =>
    (await ds.query<unknown[]>(`SELECT name FROM sqlite_master WHERE name = 'messages_trgm'`)).length;

  // The `rank = 1` form checks the index against the content table, NULL bodies included.
  const integrityCheck = () => ds.query(`INSERT INTO messages_trgm(messages_trgm, rank) VALUES ('integrity-check', 1)`);

  const insertBulk = async (count: number, body: (i: number) => string) => {
    const rows = Array.from({ length: count }, (_, i) => row('s1', 'c8', body(i), MessageDirection.INCOMING, 100 + i));
    for (let i = 0; i < rows.length; i += 200) await ds.getRepository(Message).insert(rows.slice(i, i + 200));
  };

  it('answers 501 naming SEARCH_CONTAINS_ENABLED while the setting is off, builds nothing, and leaves match=word alone', async () => {
    const provider = new BuiltInFtsProvider(ds);
    await provider.buildContainsIndex();

    const attempt = provider.search({ q: 'voic', match: 'contains' });
    await expect(attempt).rejects.toBeInstanceOf(NotImplementedException);
    await expect(attempt).rejects.toThrow(/SEARCH_CONTAINS_ENABLED=true/);
    expect(await trigramTables()).toBe(0);
    expect((await provider.search({ q: 'invoice' })).total).toBe(2);
  });

  it('answers 501 until the build has run', async () => {
    const provider = new BuiltInFtsProvider(ds, containsOn);

    await expect(provider.search({ q: 'voic', match: 'contains' })).rejects.toThrow(/still being built/);
    await provider.buildContainsIndex();
    expect((await provider.search({ q: 'voic', match: 'contains' })).total).toBe(2);
  });

  it('builds over existing rows twice into a sound index the triggers then keep current', async () => {
    await insertBulk(2500, i => `Bulk receipt ${i}`);
    await ds.query(`UPDATE messages SET body = NULL WHERE body = 'Bulk receipt 7'`);
    const provider = new BuiltInFtsProvider(ds, containsOn);

    await provider.buildContainsIndex();
    await provider.buildContainsIndex();

    await expect(integrityCheck()).resolves.toBeDefined();
    expect((await provider.search({ q: 'receipt', match: 'contains' })).total).toBe(SEARCH_CONTAINS_WINDOW);
    expect((await provider.search({ q: 'receipt 2499', match: 'contains' })).total).toBe(1);
    await ds.getRepository(Message).insert(row('s1', 'c9', 'Invoice reminder', MessageDirection.INCOMING, 5000));
    expect((await provider.search({ q: 'voic', match: 'contains' })).total).toBe(3);
  });

  it('stays sound when a row the backfill has not reached yet is edited or deleted mid-build', async () => {
    await insertBulk(2500, i => `Bulk receipt ${i}`);
    const repo = ds.getRepository(Message);
    const edited = await repo.findOneByOrFail({ body: 'Bulk receipt 2400' });
    const deleted = await repo.findOneByOrFail({ body: 'Bulk receipt 2401' });
    const query = ds.query.bind(ds);
    let interleaved = false;
    jest.spyOn(ds, 'query').mockImplementation(async (sql: string, params?: Parameters<DataSource['query']>[1]) => {
      if (!interleaved && /m\."rowid" > \?/.test(sql)) {
        interleaved = true;
        await repo.update({ id: edited.id }, { body: 'Bulk invoice edited' });
        await repo.delete({ id: deleted.id });
      }
      return query(sql, params);
    });
    const provider = new BuiltInFtsProvider(ds, containsOn);

    await provider.buildContainsIndex();

    expect(interleaved).toBe(true);
    await expect(integrityCheck()).resolves.toBeDefined();
    expect((await provider.search({ q: 'edited', match: 'contains' })).total).toBe(1);
    expect((await provider.search({ q: 'receipt 2400', match: 'contains' })).total).toBe(0);
    expect((await provider.search({ q: 'receipt 2401', match: 'contains' })).total).toBe(0);
  });

  it('rebuilds an index whose triggers a table rebuild dropped, which missed the rows written since', async () => {
    await new BuiltInFtsProvider(ds, containsOn).buildContainsIndex();
    // A rebuild of `messages` (synchronize) drops its triggers, and sessions write before the next build.
    for (const trigger of ['ai', 'ad', 'au']) await ds.query(`DROP TRIGGER messages_trgm_${trigger}`);
    const repo = ds.getRepository(Message);
    await repo.update({ chatId: 'c2' }, { body: 'Thanks, I will pay the receipt today' });
    // The newest row goes and the next one takes its rowid, so neither count moves.
    await repo.delete({ chatId: 'c4' });
    await repo.insert(row('s1', 'c5', 'Parcel left at the warehouse', MessageDirection.INCOMING, 50));
    const provider = new BuiltInFtsProvider(ds, containsOn);

    await provider.buildContainsIndex();

    await expect(integrityCheck()).resolves.toBeDefined();
    expect((await provider.search({ q: 'receip', match: 'contains' })).hits.map(h => h.chatId)).toEqual(['c2']);
    expect((await provider.search({ q: 'invoice', match: 'contains' })).hits.map(h => h.chatId)).toEqual(['c1']);
    expect((await provider.search({ q: 'discount', match: 'contains' })).total).toBe(0);
    expect((await provider.search({ q: 'warehouse', match: 'contains' })).hits.map(h => h.chatId)).toEqual(['c5']);
  });

  describe('while another transaction holds the shared connection', () => {
    let provider: BuiltInFtsProvider;

    beforeEach(() => {
      // A data import holds it for as long as it runs; the build gives up on it after 20 ms here.
      const wait = sharedConnection.awaitNoOpenTransaction;
      jest.spyOn(sharedConnection, 'awaitNoOpenTransaction').mockImplementation(source => wait(source, 20));
      provider = new BuiltInFtsProvider(ds, containsOn);
      Object.assign(provider, { containsBuildRetryMs: 20 });
    });
    afterEach(() => {
      provider.onModuleDestroy();
      jest.restoreAllMocks();
    });

    const searchOnceBuilt = async (q: string) => {
      for (let i = 0; ; i++) {
        try {
          return await provider.search({ q, match: 'contains' });
        } catch (e) {
          if (i === 200 || !/still being built/.test(String(e))) throw e;
          await new Promise(r => setTimeout(r, 10));
        }
      }
    };

    it('builds the index once the transaction ends instead of failing for good', async () => {
      const importing = ds.createQueryRunner();
      await importing.startTransaction();
      try {
        await provider.buildContainsIndex();
        await expect(provider.search({ q: 'voic', match: 'contains' })).rejects.toThrow(/still being built/);
      } finally {
        await importing.rollbackTransaction();
        await importing.release();
      }

      expect((await searchOnceBuilt('voic')).total).toBe(2);
    });

    it('builds again from empty a backfill the transaction cut short', async () => {
      await insertBulk(2500, i => `Bulk receipt ${i}`);
      const importing = ds.createQueryRunner();
      const query = ds.query.bind(ds);
      let begun = false;
      jest.spyOn(ds, 'query').mockImplementation(async (sql: string, params?: Parameters<DataSource['query']>[1]) => {
        const result: unknown = await query(sql, params);
        // The first batch is in; the import begins before the second.
        if (!begun && /m\."rowid" > \?/.test(sql)) {
          begun = true;
          await importing.startTransaction();
        }
        return result;
      });

      await provider.buildContainsIndex();
      await expect(provider.search({ q: 'receipt', match: 'contains' })).rejects.toThrow(/still being built/);
      await importing.rollbackTransaction();
      await importing.release();

      expect((await searchOnceBuilt('receipt 2499')).total).toBe(1);
      await expect(integrityCheck()).resolves.toBeDefined();
    });

    it('still fails a build for good on any other error', async () => {
      const query = ds.query.bind(ds);
      const ddl = jest
        .spyOn(ds, 'query')
        .mockImplementation((sql: string, params?: Parameters<DataSource['query']>[1]) =>
          /CREATE VIRTUAL TABLE/.test(sql) ? Promise.reject(new Error('disk I/O error')) : query(sql, params),
        );

      await provider.buildContainsIndex();
      await new Promise(r => setTimeout(r, 60));

      await expect(provider.search({ q: 'voic', match: 'contains' })).rejects.toThrow(/building its index failed/);
      expect(ddl.mock.calls.filter(([sql]) => /CREATE VIRTUAL TABLE/.test(sql))).toHaveLength(1);
    });
  });
});

describe('trigram schema helpers', () => {
  it('requires SQLite 3.45 for the trigram tokenizer with remove_diacritics', () => {
    expect(sqliteSupportsTrigramDiacritics('3.44.2')).toBe(false);
    expect(sqliteSupportsTrigramDiacritics('3.45.0')).toBe(true);
    expect(sqliteSupportsTrigramDiacritics('3.53.4')).toBe(true);
    expect(sqliteSupportsTrigramDiacritics('')).toBe(false);
  });

  it('schema-qualifies the unaccent wrapper, quoting the schema name', () => {
    expect(postgresUnaccentFunctionDdl('public')).toContain(
      `SELECT "public".unaccent('"public".unaccent'::regdictionary, $1)`,
    );
    expect(postgresUnaccentFunctionDdl(`we"ird's`)).toContain(`SELECT "we""ird's".unaccent('"we""ird''s".unaccent'`);
  });
});
