/**
 * Cross-database column type helpers.
 *
 * SQLite lacks native JSON and timestamp types, so we use `simple-json`
 * (JSON.stringify stored as TEXT) and `text` with DateTransformer.
 *
 * PostgreSQL has native `jsonb` and `timestamp` types with better
 * indexing and query performance.
 *
 * DATA CONNECTION ONLY. These resolve the dialect of the *data* connection from the global
 * `DATABASE_TYPE` env var. Use them only on entities bound to the data connection. Entities on the
 * MAIN connection (auth, audit) are ALWAYS SQLite — it is hardcoded `type: 'sqlite'` in
 * app.module.ts regardless of DATABASE_TYPE — so they must hardcode `simple-json` / `datetime`
 * (see audit-log.entity.ts) and must NOT call these helpers, or a Postgres deployment would emit a
 * `jsonb`/`timestamp` column on the always-SQLite main DB.
 */

const isPostgres = (): boolean => process.env.DATABASE_TYPE === 'postgres';

/**
 * Always 'simple-json' (TypeORM JSON.stringify/parse over a `text` column), on BOTH dialects.
 *
 * The baseline migration created these columns as `text` on Postgres too (never `jsonb`). The pg
 * driver only auto-parses real json/jsonb columns, so a `jsonb`-typed entity reading the actual
 * `text` column hands back a RAW string — e.g. webhook.events comes through as the string
 * '["message.received"]', and the dashboard's events.map() throws (full-page crash). 'simple-json'
 * parses on read regardless of dialect, matching the real columns. No native jsonb queries exist
 * (all JSON filtering is done in JS), so nothing is lost.
 */
export const jsonColumnType = (): 'simple-json' => 'simple-json';

/**
 * Returns 'timestamp' for PostgreSQL, 'text' for SQLite.
 * Use with DateTransformer for SQLite compatibility.
 */
export const dateColumnType = (): 'timestamp' | 'text' => (isPostgres() ? 'timestamp' : 'text');
