import 'reflect-metadata';
import { NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../../../common/services/logger.service';
import { DataSource } from 'typeorm';
import { ContainsTermsRefusedError } from '../search-terms';
import { BuiltInFtsProvider, TRIGRAM_BUILD_LOCK_KEY } from './builtin-fts.provider';

/**
 * Postgres-side probe coverage. A real PG instance isn't available to the unit suite, so the
 * DataSource is mocked and its query responses scripted the way each schema state would answer —
 * same pattern as the migration tests in src/database/migrations/__tests__. The focus is the FTS
 * availability probe: it must inspect the SAME `messages` table the runtime queries resolve through
 * the session search_path (pinned to `<schema>,public` on a non-public POSTGRES_SCHEMA), and it must
 * fail closed when the active schema can't be ascertained.
 */

interface ProbeScript {
  /** Whether the active schema's `messages` carries the generated `body_ts` column. */
  bodyTsPresent?: boolean;
  /** Whether that table carries the GIN index; defaults to bodyTsPresent. */
  indexPresent?: boolean;
  /** When set, the probe query itself rejects (degraded pool / mid-recovery state). */
  probeError?: Error;
  /** When set, the boot-time ensure DDL rejects, leaving the availability cache unprimed. */
  failEnsure?: boolean;
}

function makePostgresDataSource(script: ProbeScript) {
  // Held in an object so a test can flip the script mid-flight (recovery case).
  const state: ProbeScript = { ...script };
  const query = jest.fn((sql: string) => {
    const s = String(sql);
    // The boot-time ensure reads the column and the index in one catalog query.
    if (/AS col,[\s\S]*AS idx/.test(s)) {
      return Promise.resolve([{ col: !!state.bodyTsPresent, idx: state.indexPresent ?? !!state.bodyTsPresent }]);
    }
    if (/to_regclass\('messages'\)/.test(s)) {
      if (state.probeError) return Promise.reject(state.probeError);
      return Promise.resolve(state.bodyTsPresent ? [{ attname: 'body_ts' }] : []);
    }
    if (/ALTER TABLE "messages" ADD COLUMN|CREATE INDEX IF NOT EXISTS "idx_messages_body_ts"/.test(s)) {
      return state.failEnsure ? Promise.reject(new Error('simulated ensure failure')) : Promise.resolve([]);
    }
    if (/websearch_to_tsquery/.test(s)) return Promise.resolve([]); // search rows / count
    return Promise.resolve([]);
  });
  const ds = { options: { type: 'postgres' }, query } as unknown as DataSource;
  return { ds, query, state };
}

const sqlOf = (query: jest.Mock): string[] => query.mock.calls.map(call => String((call as unknown[])[0]));

describe('BuiltInFtsProvider (postgres probe)', () => {
  // The provider logs through LoggerService on the warn/error paths exercised here; keep the test
  // output quiet without touching the assertions.
  beforeEach(() => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('probes via to_regclass (search_path resolution), never an unqualified information_schema scan', async () => {
    const { ds, query } = makePostgresDataSource({ bodyTsPresent: true });
    const provider = new BuiltInFtsProvider(ds);

    expect((await provider.health()).ok).toBe(true);

    const calls = sqlOf(query);
    expect(calls.some(q => /to_regclass\('messages'\)/.test(q))).toBe(true);
    expect(calls.some(q => /information_schema/i.test(q))).toBe(false);
  });

  it('sees body_ts on the active-schema messages table (cold cache: probe decides availability)', async () => {
    const { ds } = makePostgresDataSource({ bodyTsPresent: true });
    const provider = new BuiltInFtsProvider(ds);

    const res = await provider.search({ q: 'hello' });
    expect(res.provider).toBe('builtin-fts');
    expect((await provider.health()).ok).toBe(true);
  });

  it.each([['111@c.us', '111@lid'], []])('applies chat scope to PostgreSQL rows and count (%j)', async (...chatIds) => {
    const { ds, query } = makePostgresDataSource({ bodyTsPresent: true });
    await new BuiltInFtsProvider(ds).search({ q: 'hello', chatIds, limit: 1, offset: 1 });
    const calls = query.mock.calls
      .map(call => call as unknown[])
      .filter(call => /websearch_to_tsquery/.test(String(call[0])));
    expect(calls).toHaveLength(2);
    for (const [sql] of calls) {
      expect(String(sql)).toContain(chatIds.length ? 'm."chatId" IN ($2,$3)' : '1 = 0');
    }
    expect(calls[0][1]).toEqual(['hello', ...chatIds, 1, 1]);
    expect(calls[1][1]).toEqual(['hello', ...chatIds]);
  });

  it('binds inclusive millisecond bounds in seconds for both rows and count', async () => {
    const { ds, query } = makePostgresDataSource({ bodyTsPresent: true });
    await new BuiltInFtsProvider(ds).search({ q: 'hello', dateFrom: 1000.5, dateTo: 2999.5, limit: 1, offset: 1 });
    const calls = query.mock.calls
      .map(call => call as unknown[])
      .filter(call => /websearch_to_tsquery/.test(String(call[0])));
    expect(calls).toHaveLength(2);
    for (const [sql] of calls) {
      expect(String(sql)).toContain('m."timestamp" >= $2');
      expect(String(sql)).toContain('m."timestamp" <= $3');
    }
    expect(calls[0][1]).toEqual(['hello', 2, 2, 1, 1]);
    expect(calls[1][1]).toEqual(['hello', 2, 2]);
  });

  it('does not credit a namesake in another schema: an empty active-schema probe means 501, not "available"', async () => {
    // A public.messages.body_ts must not make FTS look available when the table the search queries
    // resolve (active schema) lacks the column. The scripted probe answers for the resolved table
    // only — empty — so search must take the clean 501 posture.
    const { ds } = makePostgresDataSource({ bodyTsPresent: false });
    const provider = new BuiltInFtsProvider(ds);

    await expect(provider.search({ q: 'hello' })).rejects.toBeInstanceOf(NotImplementedException);
    const health = await provider.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toBe('full-text index absent');
  });

  it('degraded boot (ensure failed) + active schema lacks body_ts → same absent-index posture as normal', async () => {
    const { ds, query } = makePostgresDataSource({ bodyTsPresent: false, failEnsure: true });
    const provider = new BuiltInFtsProvider(ds);
    await provider.onModuleInit(); // ensure throws inside; boot must not fail and cache stays unprimed

    await expect(provider.search({ q: 'hello' })).rejects.toBeInstanceOf(NotImplementedException);
    expect((await provider.health()).ok).toBe(false);
    // The probe (not a re-attempted ensure) decided availability after the failed boot.
    expect(sqlOf(query).some(q => /to_regclass\('messages'\)/.test(q))).toBe(true);
  });

  it('degraded boot (ensure failed) + active schema HAS body_ts → probe still detects FTS (no false 501)', async () => {
    // ensure can die on a transient error even though the column already exists (e.g. GIN index
    // build raced a statement timeout). The probe must read the active schema's real state and keep
    // search available — same decision a healthy boot would have cached.
    const { ds } = makePostgresDataSource({ bodyTsPresent: true, indexPresent: false, failEnsure: true });
    const provider = new BuiltInFtsProvider(ds);
    await provider.onModuleInit();

    const res = await provider.search({ q: 'hello' });
    expect(res.provider).toBe('builtin-fts');
    expect((await provider.health()).ok).toBe(true);
  });

  it('issues no DDL at boot when the column and the index already exist (no table lock on migrated databases)', async () => {
    const { ds, query } = makePostgresDataSource({ bodyTsPresent: true });
    const provider = new BuiltInFtsProvider(ds);
    await provider.onModuleInit();

    expect(sqlOf(query).some(q => /ALTER TABLE|CREATE INDEX/.test(q))).toBe(false);
    expect((await provider.health()).ok).toBe(true);
  });

  it('creates only the index when the column exists but the index is missing', async () => {
    const { ds, query } = makePostgresDataSource({ bodyTsPresent: true, indexPresent: false });
    await new BuiltInFtsProvider(ds).onModuleInit();

    const calls = sqlOf(query);
    expect(calls.some(q => /ALTER TABLE/.test(q))).toBe(false);
    expect(calls.filter(q => /CREATE INDEX IF NOT EXISTS "idx_messages_body_ts"/.test(q))).toHaveLength(1);
  });

  it('creates the column and the index when neither exists', async () => {
    const { ds, query } = makePostgresDataSource({ bodyTsPresent: false });
    await new BuiltInFtsProvider(ds).onModuleInit();

    const calls = sqlOf(query);
    expect(calls.filter(q => /ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "body_ts"/.test(q))).toHaveLength(1);
    expect(calls.filter(q => /CREATE INDEX IF NOT EXISTS "idx_messages_body_ts"/.test(q))).toHaveLength(1);
  });

  it('a probe error fails closed (501/unhealthy, never a raw 500) and is NOT cached — a later probe recovers', async () => {
    const { ds, state } = makePostgresDataSource({ probeError: new Error('connection reset') });
    const provider = new BuiltInFtsProvider(ds);

    await expect(provider.search({ q: 'hello' })).rejects.toBeInstanceOf(NotImplementedException);
    expect((await provider.health()).ok).toBe(false);

    // Pool recovered: the failed probe was not cached, so availability is re-probed and found.
    state.probeError = undefined;
    state.bodyTsPresent = true;
    expect((await provider.health()).ok).toBe(true);
    await expect(provider.search({ q: 'hello' })).resolves.toMatchObject({ provider: 'builtin-fts' });
  });
});

describe('BuiltInFtsProvider match=contains terms (postgres)', () => {
  /** A provider whose catalog read finds the trigram index ready, over a database that matches nothing. */
  const containsReady = () => {
    const query = jest.fn().mockResolvedValue([]);
    const manager = {
      query: jest.fn().mockResolvedValue([{ trgm: 'public', unaccent: 'public', fn: true, idx: true }]),
    };
    const ds = { options: { type: 'postgres' }, query, manager } as unknown as DataSource;
    return { provider: new BuiltInFtsProvider(ds, new ConfigService({ search: { containsEnabled: true } })), query };
  };

  // As show_trgm(openwa_unaccent(term)) reads them on PostgreSQL 16, with glibc and with musl: a Hangul
  // word of two syllables, a modifier letter unaccent turns into an apostrophe and superscript digits
  // give pg_trgm no trigram to look up, so the search would read every row.
  it.each(['안녕', '\u02bc'.repeat(3), '¹²³'])('refuses %j alone, which pg_trgm cannot look up', async q => {
    const { provider, query } = containsReady();
    await expect(provider.search({ q, match: 'contains' })).rejects.toBeInstanceOf(ContainsTermsRefusedError);
    expect(query).not.toHaveBeenCalled();
  });

  // Hangul syllables, a katakana word with its prolonged sound mark, and letter numbers (which unaccent
  // spells in Latin) give it trigrams.
  it.each(['서울역', 'ラーメン', 'ⅫⅫⅫ'])('looks %j up', async q => {
    const { provider, query } = containsReady();
    await expect(provider.search({ q, match: 'contains' })).resolves.toMatchObject({ total: 0 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('BuiltInFtsProvider contains index build lock (postgres)', () => {
  beforeEach(() => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /**
   * A database whose build lock answers `locks` in turn and whose index exists once the lock is taken,
   * while the catalog a search reads still lacks it: only a build attempt of the provider's own can
   * make contains search ready.
   */
  const lockedOut = (locks: boolean[]) => {
    const tryLock = jest.fn<Promise<Array<{ locked: boolean }>>, [string, unknown[]]>(() =>
      Promise.resolve([{ locked: locks.shift() ?? false }]),
    );
    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      manager: {
        query: jest.fn((sql: string, params: unknown[]) =>
          /pg_try_advisory_lock/.test(sql)
            ? tryLock(sql, params)
            : Promise.resolve([{ trgm: 'public', unaccent: 'public', fn: true, idx: true }]),
        ),
      },
    };
    const notReady = [{ trgm: 'public', unaccent: 'public', fn: false, idx: null }];
    const ds = {
      options: { type: 'postgres' },
      createQueryRunner: () => runner,
      query: jest.fn().mockResolvedValue([]),
      manager: { query: jest.fn().mockResolvedValue(notReady) },
    } as unknown as DataSource;
    const provider = new BuiltInFtsProvider(ds, new ConfigService({ search: { containsEnabled: true } }));
    Object.assign(provider, { containsBuildRetryMs: 0 });
    return { provider, tryLock };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it('keys the lock to the messages table and tries it again until the index is ready', async () => {
    const { provider, tryLock } = lockedOut([false, false, true]);
    const search = () => provider.search({ q: 'voic', match: 'contains' });

    await provider.buildContainsIndex();
    await expect(search()).rejects.toThrow(/still being built/);
    for (
      let i = 0;
      i < 100 &&
      (await search().then(
        () => false,
        () => true,
      ));
      i++
    )
      await settle();

    await expect(search()).resolves.toMatchObject({ total: 0 });
    expect(tryLock).toHaveBeenCalledTimes(3);
    expect(tryLock).toHaveBeenCalledWith(expect.stringContaining("to_regclass('messages')"), [TRIGRAM_BUILD_LOCK_KEY]);
    provider.onModuleDestroy();
  });

  it('stops trying once the module is destroyed', async () => {
    const { provider, tryLock } = lockedOut([]);

    await provider.buildContainsIndex();
    provider.onModuleDestroy();
    await settle();

    expect(tryLock).toHaveBeenCalledTimes(1);
  });
});
