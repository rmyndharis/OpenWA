// Colocated in migrations/__tests__/ — the TypeORM migrations glob (`migrations/*{.ts,.js}`) matches
// only direct children, so this subdir is NOT loaded as a migration by the CLI/start:dev.
//
// This migration is Postgres-only (SQLite early-returns), so a real in-memory SQLite DataSource
// cannot exercise the conversion path. We mock the QueryRunner and script its catalog-query responses
// (information_schema.columns, pg_constraint, server_version_num, pg_extension) the way a
// synchronize-built PG schema would answer, then assert the exact DDL sequence.
import { QueryRunner } from 'typeorm';
import { NormalizeSynchronizeUuidColumns1770200000000 } from '../1770200000000-NormalizeSynchronizeUuidColumns';

const PK_TABLES = [
  'sessions',
  'webhooks',
  'messages',
  'message_batches',
  'templates',
  'baileys_stored_messages',
  'webhook_delivery_failures',
  'conversation_mappings',
  'integration_delivery_failures',
];

const SESSION_FKS = [
  { table: 'webhooks', column: 'sessionId' },
  { table: 'templates', column: 'sessionId' },
  { table: 'baileys_stored_messages', column: 'sessionId' },
];

interface SchemaOpts {
  type: string;
  existingTables?: Set<string>;
  /** "table.column" keys that are native uuid on this schema. */
  uuidColumns?: Set<string>;
  /** "table.column" -> FK constraint names currently referencing sessions(id). */
  fkConstraints?: Record<string, string[]>;
  versionNum?: number; // server_version_num (150000 = PG15, 120000 = PG12)
  extInstalled?: boolean;
}

function makeQueryRunner(opts: SchemaOpts) {
  const {
    type,
    existingTables = new Set([...PK_TABLES, ...SESSION_FKS.map(f => f.table)]),
    uuidColumns = new Set<string>(),
    fkConstraints = {},
    versionNum = 150000,
    extInstalled = true,
  } = opts;

  const query = jest.fn((sql: string, params?: unknown[]) => {
    const s = String(sql);
    if (/information_schema\.columns/i.test(s)) {
      const [table, column] = (params ?? []) as string[];
      const isUuid = uuidColumns.has(`${table}.${column}`);
      return Promise.resolve([{ udt_name: isUuid ? 'uuid' : 'varchar' }]);
    }
    if (/pg_constraint/i.test(s)) {
      const [table, column] = (params ?? []) as string[];
      return Promise.resolve((fkConstraints[`${table}.${column}`] ?? []).map(conname => ({ conname })));
    }
    if (/server_version_num/i.test(s)) return Promise.resolve([{ num: versionNum }]);
    if (/pg_extension/i.test(s)) return Promise.resolve(extInstalled ? [{ ok: 1 }] : []);
    return Promise.resolve(undefined);
  });

  return {
    dataSource: { options: { type } },
    hasTable: jest.fn((t: string) => Promise.resolve(existingTables.has(t))),
    query,
  };
}

const sqlOf = (qr: ReturnType<typeof makeQueryRunner>): string[] =>
  qr.query.mock.calls.map(call => String((call as unknown[])[0]));

const idxOf = (calls: string[], re: RegExp): number => calls.findIndex(q => re.test(q));

describe('NormalizeSynchronizeUuidColumns migration', () => {
  const migration = new NormalizeSynchronizeUuidColumns1770200000000();

  // ---- name convention (load-bearing for TypeORM sort + the PG-migrations CI gate) ----
  it('class name and .name both end in the 13-digit timestamp 1770200000000', () => {
    expect(NormalizeSynchronizeUuidColumns1770200000000.name.endsWith('1770200000000')).toBe(true);
    expect(migration.name.endsWith('1770200000000')).toBe(true);
  });

  // ---- SQLite: absolute no-op ----
  it('is a no-op on SQLite — issues no query and never probes tables', async () => {
    const qr = makeQueryRunner({ type: 'better-sqlite3', uuidColumns: new Set(['sessions.id']) });
    await migration.up(qr as unknown as QueryRunner);
    expect(qr.query).not.toHaveBeenCalled();
    expect(qr.hasTable).not.toHaveBeenCalled();
  });

  // ---- healthy Postgres (already varchar): single probe, zero DDL ----
  it('on a healthy (varchar) Postgres schema probes only sessions.id once and issues no DDL', async () => {
    const qr = makeQueryRunner({ type: 'postgres', uuidColumns: new Set() });
    await migration.up(qr as unknown as QueryRunner);

    const calls = sqlOf(qr);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/information_schema\.columns/);
    expect(calls.some(q => /ALTER TABLE|DROP CONSTRAINT|ADD CONSTRAINT|SET LOCAL/i.test(q))).toBe(false);
  });

  // ---- full conversion of a synchronize-built (uuid) schema ----
  it('converts every uuid PK + session-FK to varchar and recreates the 3 CASCADE FKs', async () => {
    const discoveredHashes: Record<string, string[]> = {
      'webhooks.sessionId': ['FK_53208331c90e332d3f13780729c'],
      'templates.sessionId': ['FK_55c1dfd945d2c552a5313b25460'],
      'baileys_stored_messages.sessionId': ['FK_9a8b7c6d5e4f3a2b1c0d9e8f7a6b'],
    };
    const uuidCols = new Set<string>([
      ...PK_TABLES.map(t => `${t}.id`),
      ...SESSION_FKS.map(f => `${f.table}.${f.column}`),
    ]);
    const qr = makeQueryRunner({ type: 'postgres', uuidColumns: uuidCols, fkConstraints: discoveredHashes });
    await migration.up(qr as unknown as QueryRunner);

    const calls = sqlOf(qr);

    // PG13+: no extension touch.
    expect(calls.some(q => /CREATE EXTENSION/i.test(q))).toBe(false);

    // statement_timeout lifted for the rewrite.
    expect(calls.some(q => /SET LOCAL statement_timeout\s*=\s*0/i.test(q))).toBe(true);

    // Every discovered sync-hash FK dropped; every canonical FK re-added.
    for (const hash of Object.values(discoveredHashes).flat()) {
      expect(calls.some(q => new RegExp(`DROP CONSTRAINT IF EXISTS "${hash}"`).test(q))).toBe(true);
    }
    for (const canon of [
      'FK_d209715bb62b12255e825580af6',
      'FK_templates_sessionId',
      'FK_baileys_stored_messages_sessionId',
    ]) {
      expect(calls.some(q => new RegExp(`ADD CONSTRAINT "${canon}"`).test(q))).toBe(true);
    }

    // Every PK converted (DROP DEFAULT immediately before its TYPE change), every session-FK converted.
    for (const t of PK_TABLES) {
      const dropIdx = idxOf(calls, new RegExp(`ALTER TABLE "${t}" ALTER COLUMN "id" DROP DEFAULT`));
      const typeIdx = idxOf(calls, new RegExp(`ALTER TABLE "${t}" ALTER COLUMN "id" TYPE varchar USING "id"::text`));
      expect(dropIdx).toBeGreaterThanOrEqual(0);
      expect(typeIdx).toBeGreaterThan(dropIdx); // DROP DEFAULT precedes ALTER TYPE (uuid default not varchar-coercible)
      expect(
        calls.some(q =>
          new RegExp(`ALTER TABLE "${t}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid\\(\\)::varchar`).test(q),
        ),
      ).toBe(true);
    }
    for (const f of SESSION_FKS) {
      expect(
        calls.some(q =>
          new RegExp(`ALTER TABLE "${f.table}" ALTER COLUMN "${f.column}" TYPE varchar USING "${f.column}"::text`).test(
            q,
          ),
        ),
      ).toBe(true);
    }
  });

  // ---- the load-bearing ordering invariant (Test E) ----
  it('drops ALL session-FKs BEFORE converting the sessions.id PK they reference', async () => {
    const uuidCols = new Set<string>([
      ...PK_TABLES.map(t => `${t}.id`),
      ...SESSION_FKS.map(f => `${f.table}.${f.column}`),
    ]);
    const qr = makeQueryRunner({
      type: 'postgres',
      uuidColumns: uuidCols,
      fkConstraints: {
        'webhooks.sessionId': ['FK_w'],
        'templates.sessionId': ['FK_t'],
        'baileys_stored_messages.sessionId': ['FK_b'],
      },
    });
    await migration.up(qr as unknown as QueryRunner);

    const calls = sqlOf(qr);
    const lastDrop = Math.max(
      idxOf(calls, /DROP CONSTRAINT IF EXISTS "FK_w"/),
      idxOf(calls, /DROP CONSTRAINT IF EXISTS "FK_t"/),
      idxOf(calls, /DROP CONSTRAINT IF EXISTS "FK_b"/),
    );
    const firstPkType = idxOf(calls, /ALTER TABLE "sessions" ALTER COLUMN "id" TYPE varchar/);
    expect(lastDrop).toBeGreaterThanOrEqual(0);
    expect(firstPkType).toBeGreaterThan(lastDrop); // cannot ALTER the referenced PK while a uuid FK still points at it
  });

  // ---- per-column idempotency: a partially-drifted table is skipped for TYPE but still gets its DEFAULT ----
  it('skips ALTER TYPE on an already-varchar column but still sets its DEFAULT (partial drift)', async () => {
    const uuidCols = new Set<string>([
      ...PK_TABLES.filter(t => t !== 'messages').map(t => `${t}.id`), // messages.id already varchar
      ...SESSION_FKS.map(f => `${f.table}.${f.column}`),
    ]);
    const qr = makeQueryRunner({ type: 'postgres', uuidColumns: uuidCols, fkConstraints: {} });
    await migration.up(qr as unknown as QueryRunner);

    const calls = sqlOf(qr);
    expect(calls.some(q => /ALTER TABLE "messages" ALTER COLUMN "id" TYPE varchar/.test(q))).toBe(false);
    expect(calls.some(q => /ALTER TABLE "messages" ALTER COLUMN "id" DROP DEFAULT/.test(q))).toBe(false);
    // DEFAULT set unconditionally (idempotent) for every existing PK table.
    expect(
      calls.some(q => /ALTER TABLE "messages" ALTER COLUMN "id" SET DEFAULT gen_random_uuid\(\)::varchar/.test(q)),
    ).toBe(true);
    // other PKs still converted
    expect(calls.some(q => /ALTER TABLE "sessions" ALTER COLUMN "id" TYPE varchar/.test(q))).toBe(true);
  });

  // ---- absent tables (older sync snapshot) are skipped ----
  it('skips tables that do not exist (e.g. an older sync snapshot without templates)', async () => {
    const uuidCols = new Set<string>(['sessions.id', 'webhooks.id', 'messages.id', 'message_batches.id']);
    const qr = makeQueryRunner({
      type: 'postgres',
      existingTables: new Set(['sessions', 'webhooks', 'messages', 'message_batches']),
      uuidColumns: uuidCols,
      fkConstraints: { 'webhooks.sessionId': ['FK_w'] },
    });
    await migration.up(qr as unknown as QueryRunner);

    const calls = sqlOf(qr);
    expect(calls.some(q => /"templates"/.test(q))).toBe(false);
    expect(calls.some(q => /ALTER TABLE "sessions" ALTER COLUMN "id" TYPE varchar/.test(q))).toBe(true);
  });

  // ---- down(): inverts to native uuid (best-effort; validates via ::uuid cast) ----
  it('down() converts varchar back to native uuid and recreates the CASCADE FKs', async () => {
    const qr = makeQueryRunner({
      type: 'postgres',
      uuidColumns: new Set(), // post-up state: all varchar
      fkConstraints: {
        'webhooks.sessionId': ['FK_d209715bb62b12255e825580af6'],
        'templates.sessionId': ['FK_templates_sessionId'],
        'baileys_stored_messages.sessionId': ['FK_baileys_stored_messages_sessionId'],
      },
    });
    await migration.down(qr as unknown as QueryRunner);

    const calls = sqlOf(qr);
    expect(calls.some(q => /ALTER TABLE "sessions" ALTER COLUMN "id" TYPE uuid USING "id"::uuid/.test(q))).toBe(true);
    for (const f of SESSION_FKS) {
      expect(
        calls.some(q =>
          new RegExp(`ALTER TABLE "${f.table}" ALTER COLUMN "${f.column}" TYPE uuid USING "${f.column}"::uuid`).test(q),
        ),
      ).toBe(true);
    }
    for (const canon of [
      'FK_d209715bb62b12255e825580af6',
      'FK_templates_sessionId',
      'FK_baileys_stored_messages_sessionId',
    ]) {
      expect(calls.some(q => new RegExp(`ADD CONSTRAINT "${canon}"`).test(q))).toBe(true);
    }
  });

  it('down() is a no-op on SQLite', async () => {
    const qr = makeQueryRunner({ type: 'better-sqlite3' });
    await migration.down(qr as unknown as QueryRunner);
    expect(qr.query).not.toHaveBeenCalled();
  });
});
