/* eslint-disable */
// PostgreSQL migration + uuid-default smoke. CI runs this against a throwaway postgres:16 service:
// it applies the FULL data-migration chain from scratch (previously never exercised on Postgres in CI)
// and asserts every generated-uuid primary key has a DB-side DEFAULT. Without one, a
// `@PrimaryGeneratedColumn('uuid')` insert fails on Postgres with a NOT NULL violation (23502) — the
// exact failure SQLite hides, because its driver mints the uuid client-side.
//
// Runs against the compiled migrations in dist/ (so it matches `migration:run:prod`); `npm run build`
// first. Configured from DATABASE_* env vars.
require('reflect-metadata');
const path = require('path');
const { DataSource } = require('typeorm');

// @PrimaryColumn tables: their `id` is supplied by the application, so it legitimately has NO DB default.
// Everything else with an `id` column is expected to be a generated-uuid PK that MUST carry a default.
const APP_GENERATED_ID_TABLES = ['ingress_events', 'plugin_instances'];

async function main() {
  // Mirror the migration CLI (data-source.ts): a non-public POSTGRES_SCHEMA sets the session
  // search_path so the raw, unqualified migration DDL + the typeorm_migrations ledger land in it.
  const schema = process.env.POSTGRES_SCHEMA || 'public';
  const useCustomSearchPath = schema !== 'public';
  const ds = new DataSource({
    type: 'postgres',
    schema,
    host: process.env.DATABASE_HOST || 'localhost',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'openwa',
    password: process.env.DATABASE_PASSWORD || 'openwa',
    database: process.env.DATABASE_NAME || 'openwa',
    migrations: [path.join(__dirname, '..', 'dist', 'database', 'migrations', '*.js')],
    ...(useCustomSearchPath ? { extra: { options: `-c search_path=${schema},public` } } : {}),
  });

  await ds.initialize();
  const ran = await ds.runMigrations();
  console.log(`Applied ${ran.length} data migrations to PostgreSQL from scratch.`);

  // Auto-coverage: any `id` column with no DEFAULT that isn't an app-generated PK is a uuid-PK table
  // missing gen_random_uuid(). This catches current AND future tables without a maintained list.
  const noDefaultRows = await ds.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = $1 AND column_name = 'id' AND column_default IS NULL`,
    [schema],
  );
  const offenders = noDefaultRows
    .map((r) => r.table_name)
    .filter((t) => t !== 'migrations' && !APP_GENERATED_ID_TABLES.includes(t));

  // Belt-and-suspenders: positively assert the two tables this migration set fixes carry a default.
  for (const t of ['conversation_mappings', 'integration_delivery_failures']) {
    const rows = await ds.query(
      `SELECT column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'id'`,
      [schema, t],
    );
    if (!rows.length || rows[0].column_default == null) offenders.push(`${t} (expected a default, found none)`);
  }

  await ds.destroy();

  const unique = [...new Set(offenders)];
  if (unique.length) {
    console.error('\n❌ Generated-uuid PK column(s) missing a Postgres DEFAULT — inserts will fail (23502):');
    for (const t of unique) console.error('   - ' + t);
    console.error('\nFix: add `ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar` in a Postgres-only migration.');
    process.exit(1);
  }
  console.log('✅ Migration chain applied cleanly and every generated-uuid PK has a Postgres DEFAULT.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
