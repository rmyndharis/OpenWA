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
        `"id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "waMessageId" varchar, ` +
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

  it('returns empty (not error) for no matches', async () => {
    const res = await provider.search({ q: 'zzzznomatch' });
    expect(res.hits).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('reports healthy', async () => {
    expect((await provider.health()).ok).toBe(true);
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
