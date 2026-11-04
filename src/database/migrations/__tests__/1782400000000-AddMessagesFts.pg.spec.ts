/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { BuiltInFtsProvider } from '../../../modules/search/providers/builtin-fts.provider';
import { AddMessagesFts1782400000000 } from '../1782400000000-AddMessagesFts';

/**
 * Postgres runtime coverage for BuiltInFtsProvider. Companion to the SQLite spec
 * (builtin-fts.provider.spec.ts); asserts the same contract (match + rank + paginate, sessionIds
 * auth scope, sessionId filter, empty result, health) against the Postgres dialect branch, which
 * exercises `websearch_to_tsquery` + `ts_headline` against a STORED generated `body_ts` tsvector.
 *
 * Gating: this is the runtime proof the Task-6 provider works on PG — but local dev has no PG. The
 * repo's PG-migration harness (scripts/pg-uuid-smoke.js + the "Test (PostgreSQL migrations)" CI job)
 * keys off `DATABASE_TYPE=postgres` with DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME; mirror that exact
 * convention here, and skip the whole suite unless DATABASE_TYPE=postgres is set. The CI job runs
 * this spec against a postgres:16 service; locally it skips cleanly.
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';

(POSTGRES_ENABLED ? describe : describe.skip)('BuiltInFtsProvider (postgres)', () => {
  let ds: DataSource;
  let provider: BuiltInFtsProvider;

  beforeEach(async () => {
    // Provision exactly like scripts/pg-uuid-smoke.js: DATABASE_* env, no ORM synchronize (we build
    // the messages table with raw DDL so the generated tsvector column comes from the migration
    // under test, not from entity metadata — and so no uuid-ossp/default dependency is introduced).
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST || 'localhost',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'openwa',
      password: process.env.DATABASE_PASSWORD || 'openwa',
      database: process.env.DATABASE_NAME || 'openwa',
    });
    await ds.initialize();

    // Drop any prior messages table (the CI job may share the service across steps) and build the
    // minimal shape BuiltInFtsProvider SELECTs against.
    await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
    await ds.query(
      `CREATE TABLE "messages" (` +
        `"id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "waMessageId" varchar, "author" varchar, ` +
        `"chatId" varchar NOT NULL, "from" varchar NOT NULL, "to" varchar NOT NULL, "body" text, ` +
        `"type" varchar NOT NULL DEFAULT 'text', "direction" varchar NOT NULL DEFAULT 'outgoing', ` +
        `"timestamp" bigint, "status" varchar NOT NULL DEFAULT 'sent', ` +
        `"createdAt" timestamp NOT NULL DEFAULT now())`,
    );
    // Adds the STORED generated `body_ts` tsvector + the GIN index — the exact objects the provider
    // relies on; running the migration (not hand-rolling DDL) is the point of this test.
    await new AddMessagesFts1782400000000().up(ds.createQueryRunner());

    provider = new BuiltInFtsProvider(ds);

    const insert = (id: string, sessionId: string, body: string, direction: string, ts: number) =>
      ds.query(
        `INSERT INTO "messages" ("id","sessionId","chatId","from","to","body","type","direction","timestamp") ` +
          `VALUES ($1,$2,$3,$4,$5,$6,'text',$7,$8)`,
        [id, sessionId, `${sessionId}-chat`, `${sessionId}-from`, 'dest@c.us', body, direction, ts],
      );
    await insert('m1', 's1', 'hello world', 'outgoing', 1);
    await insert('m2', 's1', 'goodbye world', 'outgoing', 2);
    await insert('m3', 's2', 'hello again', 'incoming', 3);
  });

  afterEach(async () => {
    if (ds && ds.isInitialized) {
      await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`).catch(() => undefined);
      await ds.destroy();
    }
  });

  it('matches by keyword via websearch_to_tsquery, ranks, and wraps the hit in <mark> via ts_headline', async () => {
    const res = await provider.search({ q: 'hello', limit: 10 });
    expect(res.provider).toBe('builtin-fts');
    expect(res.hits).toHaveLength(2);
    // ts_headline (configured with StartSel=<mark>,StopSel=</mark>) must delimit the match — the
    // dialect-agnostic snippet contract the SQLite path also upholds.
    expect(res.hits.every(h => h.snippet.includes('<mark>') && h.snippet.includes('</mark>'))).toBe(true);
    expect(res.hits.every(h => /hello/i.test(h.snippet))).toBe(true);
    expect(res.total).toBe(2);
  });

  it('scopes by sessionIds (auth) and by sessionId filter', async () => {
    const scoped = await provider.search({ q: 'hello', sessionIds: ['s1'] });
    expect(scoped.hits.every(h => h.sessionId === 's1')).toBe(true);
    expect(scoped.total).toBe(1);

    const one = await provider.search({ q: 'hello', sessionId: 's2' });
    expect(one.hits.map(h => h.sessionId)).toEqual(['s2']);
  });

  // Every row ties on score and timestamp, so only the id tiebreak gives the walk a total order. An
  // offset past 0 also skips the short-page shortcut, so `total` comes from count() and its own
  // `$n` numbering of the same filters.
  it('pages a tie group one hit at a time without repeats, reporting the full total on every page', async () => {
    await ds.query(`DELETE FROM "messages"`);
    const ROWS = 12;
    for (let i = 0; i < ROWS; i++) {
      await ds.query(
        `INSERT INTO "messages" ("id","sessionId","chatId","from","to","body","type","direction","timestamp") ` +
          `VALUES ($1,'s1','s1-chat','s1-from','dest@c.us','paging probe','text','outgoing',1)`,
        [`p${String(i).padStart(2, '0')}`],
      );
    }

    const served: string[] = [];
    for (let offset = 0; offset < ROWS; offset++) {
      const page = await provider.search({ q: 'paging', sessionIds: ['s1'], limit: 1, offset });
      expect(page.total).toBe(ROWS);
      served.push(...page.hits.map(h => h.messageId));
    }

    expect(served).toHaveLength(ROWS);
    expect(new Set(served).size).toBe(ROWS);
  });

  it('returns empty (not error) for no matches', async () => {
    const res = await provider.search({ q: 'zzzznomatch' });
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('applies inclusive millisecond windows to rows and paginated totals', async () => {
    const timestamps = [-2, -1, 0, 1, 2, 1_700_000_000, 1_700_000_001];
    for (const timestamp of timestamps) {
      await ds.query(
        `INSERT INTO "messages" ("id","sessionId","chatId","from","to","body","timestamp") ` +
          `VALUES ($1,'s1','c1','a@c.us','dest@c.us','boundarywindow',$2)`,
        [`boundary-${timestamp}`, timestamp],
      );
    }
    const windows = [
      { dateFrom: 1000, dateTo: 2000, want: [2, 1] },
      { dateFrom: 1001, dateTo: 1999, want: [] },
      { dateFrom: 0, dateTo: 0, want: [0] },
      { dateFrom: -1999, dateTo: -1, want: [-1] },
      { dateFrom: -2000, dateTo: -1001, want: [-2] },
      { dateFrom: 0.5, dateTo: 1999.5, want: [1] },
      { dateFrom: 1000, dateTo: 1000, want: [1] },
      { dateFrom: 2000, dateTo: 1000, want: [] },
      { dateFrom: 1_700_000_000_001, dateTo: 1_700_000_001_000, want: [1_700_000_001] },
    ];
    for (const { want, ...bounds } of windows) {
      const result = await provider.search({ q: 'boundarywindow', ...bounds });
      expect(result.hits.map(hit => hit.timestamp)).toEqual(want);
      expect(result.total).toBe(want.length);
      const page = await provider.search({ q: 'boundarywindow', ...bounds, limit: 1, offset: 1 });
      expect(page.hits.map(hit => hit.timestamp)).toEqual(want.slice(1, 2));
      expect(page.total).toBe(want.length);
    }
  });

  // A chat first stored under one dialect and later under another is one chat, and a group message keeps
  // the group in `from` and the person in `author`. The host passes the expanded forms; the count behind
  // a later page numbers the same bind parameters again.
  it('matches the stored dialects of a chat and a sender, and pages through them', async () => {
    const insert = (id: string, chatId: string, from: string, author: string | null, ts: number) =>
      ds.query(
        `INSERT INTO "messages" ("id","sessionId","chatId","from","author","to","body","timestamp") ` +
          `VALUES ($1,'s1',$2,$3,$4,'dest@c.us','dialectprobe',$5)`,
        [id, chatId, from, author, ts],
      );
    await insert('d1', '628111@c.us', '628111@c.us', null, 10);
    await insert('d2', '628111@s.whatsapp.net', '628111@s.whatsapp.net', null, 11);
    await insert('d3', '12345@g.us', '12345@g.us', '628111@c.us', 12);
    await insert('d4', '999@c.us', '999@c.us', null, 13);
    const ids = (r: { hits: Array<{ messageId: string }> }) => r.hits.map(h => h.messageId).sort();

    const chat = { q: 'dialectprobe', chatId: '628111@c.us' };
    const chatForms = ['628111@c.us', '628111@s.whatsapp.net'];
    expect(ids(await provider.search(chat))).toEqual(['d1']);
    const expandedChat = await provider.search({ ...chat, chatIdAliases: chatForms });
    expect(ids(expandedChat)).toEqual(['d1', 'd2']);
    const chatPage = await provider.search({ ...chat, chatIdAliases: chatForms, limit: 1, offset: 1 });
    expect(chatPage.hits).toHaveLength(1);
    expect(chatPage.total).toBe(2);

    const sender = { q: 'dialectprobe', from: '628111@c.us', fromAliases: ['628111@c.us', '628111@s.whatsapp.net'] };
    expect(ids(await provider.search({ q: 'dialectprobe', from: '628111@c.us' }))).toEqual(['d1']);
    expect(ids(await provider.search(sender))).toEqual(['d1', 'd2', 'd3']);
    const senderPage = await provider.search({ ...sender, limit: 1, offset: 2 });
    expect(senderPage.hits).toHaveLength(1);
    expect(senderPage.total).toBe(3);

    const combined = await provider.search({
      ...sender,
      sessionIds: ['s1'],
      chatId: '628111@c.us',
      chatIdAliases: chatForms,
      chatIds: ['628111@c.us', '628111@s.whatsapp.net', '12345@g.us'],
      limit: 1,
      offset: 1,
    });
    expect(combined.hits).toHaveLength(1);
    expect(combined.total).toBe(2);
  });

  it('reports healthy', async () => {
    expect((await provider.health()).ok).toBe(true);
  });

  // The boot self-heal reads the catalog and creates only what is missing. health() alone cannot
  // prove the catalog query works: it re-probes on its own, so it passes even when onModuleInit threw.
  const bootSelfHeal = async (): Promise<{ ddl: string[]; errors: jest.SpyInstance }> => {
    const internals = provider as unknown as { logger: { error: (message: string) => void } };
    const errors = jest.spyOn(internals.logger, 'error');
    const query = jest.spyOn(ds, 'query');
    await provider.onModuleInit();
    const ddl = query.mock.calls.map(([sql]) => sql).filter(sql => /ALTER TABLE|CREATE INDEX/i.test(sql));
    query.mockRestore();
    return { ddl, errors };
  };
  const ftsAvailable = (): boolean | null => (provider as unknown as { ftsAvailable: boolean | null }).ftsAvailable;

  it('issues no DDL at boot when the migration already built the column and the index', async () => {
    const { ddl, errors } = await bootSelfHeal();

    expect(errors).not.toHaveBeenCalled();
    expect(ftsAvailable()).toBe(true);
    expect(ddl).toEqual([]);
  });

  it('recreates only the missing GIN index at boot', async () => {
    await ds.query(`DROP INDEX "idx_messages_body_ts"`);

    const { ddl, errors } = await bootSelfHeal();

    expect(errors).not.toHaveBeenCalled();
    expect(ftsAvailable()).toBe(true);
    expect(ddl).toEqual([expect.stringMatching(/^CREATE INDEX IF NOT EXISTS "idx_messages_body_ts"/)]);
    const indexes: Array<{ indexname: string }> = await ds.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'messages' AND indexname = 'idx_messages_body_ts'`,
    );
    expect(indexes).toHaveLength(1);
  });

  // Task 12 PG carry-forward: prove the generated `body_ts` tsvector re-derives across the clear+re-
  // insert path that POST /infra/import-data performs (companion to the SQLite round-trip in
  // providers/search-dual-db.spec.ts). A STORED generated column is recomputed on every INSERT, so
  // re-inserted rows must re-enter the index with no stale or duplicate FTS entries.
  it('keeps FTS correct after a clear+re-insert (the import path), repeatedly', async () => {
    const insert = (id: string, sessionId: string, body: string) =>
      ds.query(
        `INSERT INTO "messages" ("id","sessionId","chatId","from","to","body","type","direction","timestamp") ` +
          `VALUES ($1,$2,$3,$4,$5,$6,'text','outgoing',$7)`,
        [id, sessionId, `${sessionId}-chat`, `${sessionId}-from`, 'dest@c.us', body, Date.now()],
      );
    for (let cycle = 0; cycle < 3; cycle++) {
      await ds.query(`DELETE FROM "messages"`);
      await insert(`m-alpha-${cycle}`, 's1', 'alpha beta');
      await insert(`m-gamma-${cycle}`, 's1', 'gamma delta');
      await insert(`m-alpha2-${cycle}`, 's1', 'alpha gamma');
      const res = await provider.search({ q: 'alpha', limit: 10 });
      expect(res.hits).toHaveLength(2); // 'alpha beta' + 'alpha gamma', never stale 'gamma delta'
      expect(res.total).toBe(2);
    }
  });
});
