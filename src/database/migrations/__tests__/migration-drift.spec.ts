import { DataSource } from 'typeorm';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Migration-chain vs entity-metadata drift gate.
 *
 * `migration:generate` diffs the entity metadata against a DataSource whose schema the migration
 * chain built. When the two drift, generate produces a spurious multi-table rebuild (the sqlite
 * column-type dialect split documented in CreateStatusUpdates' header) instead of a delta, so the
 * documented generate workflow becomes unusable and real drift hides inside the noise. Nothing
 * gated this: synchronize-built (dev/e2e) and chain-built (production) schemas could diverge
 * with every other test green, because nothing built the schema BOTH ways and compared.
 *
 * Each connection builds its FULL chain on an in-memory SQLite DataSource, then asks TypeORM's
 * schema builder what it would change to match the entity metadata (captured inside a transaction
 * that is rolled back, so nothing persists). The result is compared against a pinned snapshot of
 * the drift the chain carries TODAY. This is the same harness the from-scratch boot e2e drives
 * (test/sqlite-chain-boot).
 */
const importMigrations = (dir: string): unknown[] => {
  const out: unknown[] = [];
  for (const file of readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.includes('__tests__') && !f.endsWith('.spec.ts'))
    .sort()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(dir, file)) as Record<string, unknown>;
    const Ctor = Object.values(mod).find(
      (v): v is new () => { up: (runner: never) => Promise<void> } =>
        typeof v === 'function' && (v as { prototype?: { up?: unknown } }).prototype?.up !== undefined,
    );
    if (!Ctor) throw new Error(`Non-migration file in chain dir: ${file}`);
    out.push(Ctor);
  }
  return out;
};

const repoRoot = join(__dirname, '../../../..');

async function driftStatements(ds: DataSource): Promise<string[]> {
  await ds.initialize();
  await ds.runMigrations({ transaction: 'all' });
  try {
    // log() is TypeORM's own dry run: it enables SQL memory on a fresh query runner, computes
    // every statement the sync WOULD run, and returns them without executing a single one.
    const builder = ds.driver.createSchemaBuilder() as unknown as {
      log: () => Promise<{ upQueries: { query: string }[] }>;
    };
    const { upQueries } = await builder.log();
    // The builder's own bookkeeping table is not drift.
    return upQueries.map(q => q.query).filter(sql => !/typeorm_metadata/i.test(sql));
  } finally {
    await ds.destroy().catch(() => undefined);
  }
}

/**
 * The drift the chain carries today, pinned VERBATIM rather than classified by statement shape.
 *
 * Shape classification cannot work here. On SQLite the schema builder resolves a column change by
 * rebuilding the whole table (CREATE temporary_X + INSERT + DROP + RENAME, plus every index on it),
 * and it emits a bare CREATE INDEX for a new index. Those are the same statement shapes the KNOWN
 * drift produces, so any filter broad enough to pass the known set also passes a new column and a
 * new index: exactly the drift this gate exists to catch. Comparing the full statement text does
 * not have that blind spot, because a new column changes the CREATE TABLE body and a new index adds
 * a statement that is not in the snapshot.
 *
 * The known drift itself is cosmetic: the baseline migration created dated columns as 'datetime'
 * while the entities declare dateColumnType() = 'text' on SQLite (both TEXT affinity, so the data is
 * identical), plus index-NAME differences where TypeORM's auto-generated hash names differ from the
 * migration-declared ones. A normalizing migration at the chain tail closes it.
 *
 * WHEN THIS FAILS: read the diff before touching the snapshot. Statements listed as unexpected are
 * schema your entities declare and your migrations do not create, which is a real bug that reaches
 * production (a synchronize-disabled deploy answers 500 `no such column` on the first query that
 * touches it). Regenerate the snapshot only when you have deliberately changed the known drift, for
 * example by landing a normalizing migration, and expect the count to go DOWN when you do.
 */
const KNOWN = JSON.parse(readFileSync(join(__dirname, '__fixtures__/known-migration-drift.json'), 'utf8')) as {
  data: string[];
  main: string[];
};

/** Statement text to how many times it appears. The chain emits some statements more than once. */
const tally = (statements: string[]): Map<string, number> =>
  statements.reduce((counts, sql) => counts.set(sql, (counts.get(sql) ?? 0) + 1), new Map<string, number>());

/**
 * Compared as a MULTISET, not a set. 32 of the 93 data statements are repeats (the rebuild cycle
 * drops and recreates the same index on more than one table pass), so a set comparison would pass a
 * change that only alters HOW MANY times a statement is emitted: one rebuild pass appearing or
 * disappearing leaves the distinct-statement list identical. Counting catches that.
 */
const expectDriftMatchesSnapshot = (actual: string[], known: string[]): void => {
  // A snapshot that lost its contents would make any comparison vacuous, so require it to hold the
  // drift we know is there before comparing against it.
  expect(known.length).toBeGreaterThan(0);
  const actualCounts = tally(actual);
  const knownCounts = tally(known);
  const describe = (sql: string, from: number, to: number): string => `${from} -> ${to}  ${sql}`;
  const unexpected: string[] = [];
  const missing: string[] = [];
  for (const sql of new Set([...actualCounts.keys(), ...knownCounts.keys()])) {
    const got = actualCounts.get(sql) ?? 0;
    const want = knownCounts.get(sql) ?? 0;
    if (got > want) unexpected.push(describe(sql, want, got));
    if (got < want) missing.push(describe(sql, want, got));
  }
  expect({ unexpected, missing }).toEqual({ unexpected: [], missing: [] });
};

const dataConnection = (): DataSource =>
  new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [
      join(repoRoot, 'src/modules/session/**/*.entity{.ts,.js}'),
      join(repoRoot, 'src/modules/webhook/**/*.entity{.ts,.js}'),
      join(repoRoot, 'src/modules/message/**/*.entity{.ts,.js}'),
      join(repoRoot, 'src/modules/template/**/*.entity{.ts,.js}'),
      join(repoRoot, 'src/engine/**/*.entity{.ts,.js}'),
      join(repoRoot, 'src/modules/integration/**/*.entity{.ts,.js}'),
      join(repoRoot, 'src/modules/status-store/**/*.entity{.ts,.js}'),
      join(repoRoot, 'src/modules/automation/**/*.entity{.ts,.js}'),
    ],
    migrations: importMigrations(join(repoRoot, 'src/database/migrations')) as never,
  });

const mainConnection = (): DataSource =>
  new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: [
      join(repoRoot, 'src/modules/auth/**/*.entity{.ts,.js}'),
      join(repoRoot, 'src/modules/audit/**/*.entity{.ts,.js}'),
    ],
    migrations: importMigrations(join(repoRoot, 'src/database/migrations-main')) as never,
  });

describe('migration chain matches entity metadata (drift gate)', () => {
  it('data connection: drift is EXACTLY the pinned set (a new column or index fails)', async () => {
    expectDriftMatchesSnapshot(await driftStatements(dataConnection()), KNOWN.data);
  }, 60_000);

  it('main connection: drift is EXACTLY the pinned set (a new column or index fails)', async () => {
    expectDriftMatchesSnapshot(await driftStatements(mainConnection()), KNOWN.main);
  }, 60_000);
});
