/**
 * Cross-database column type helpers.
 *
 * SQLite lacks native JSON and timestamp types, so we use `simple-json`
 * (JSON.stringify stored as TEXT) and `text` with DateTransformer.
 *
 * PostgreSQL has native `jsonb` and `timestamp` types with better
 * indexing and query performance.
 *
 * CONNECTION-SCOPED. `dateColumnType()` resolves the dialect of the *data* connection
 * (`DATABASE_TYPE`); `mainDateColumnType()` resolves the *main* auth/audit connection
 * (`MAIN_DATABASE_TYPE`, sqlite by default). The two connections can run different dialects, so an
 * entity must use the helper of the connection it is bound to — the data helper on a main entity
 * would emit a `timestamp` column on a SQLite main DB (and vice versa) whenever the two settings
 * diverge.
 */

const isPostgres = (): boolean => process.env.DATABASE_TYPE === 'postgres';
const isMainPostgres = (): boolean => process.env.MAIN_DATABASE_TYPE === 'postgres';

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

/**
 * MAIN-connection date columns: 'timestamp' on Postgres, and the historic 'datetime' on SQLite —
 * byte-identical to what every existing install's api_keys schema already carries, so flipping
 * MAIN_DATABASE_TYPE never rewrites the SQLite schema. No transformer needed on either dialect:
 * both column types round-trip Date objects natively.
 */
export const mainDateColumnType = (): 'timestamp' | 'datetime' => (isMainPostgres() ? 'timestamp' : 'datetime');
