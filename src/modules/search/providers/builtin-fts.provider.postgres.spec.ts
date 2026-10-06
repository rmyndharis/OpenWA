import 'reflect-metadata';
import { NotImplementedException } from '@nestjs/common';
import { LoggerService } from '../../../common/services/logger.service';
import { DataSource } from 'typeorm';
import { BuiltInFtsProvider } from './builtin-fts.provider';

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
