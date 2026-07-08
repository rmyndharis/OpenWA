# 26 - Global Search

> **Status:** Backend shipped — `GET /api/search` works out of the box on SQLite and PostgreSQL with
> the built-in database full-text provider, behind an open `SearchProvider` contract. This document is
> the user-facing feature guide: what it is, how to configure and query it, and when to reach for a
> plugin backend. A dashboard panel and the SDK helpers arrive in a later phase; until then the feature
> is driven through the REST endpoint documented here and in
> [06 - API Specification](./06-api-specification.md).

## 26.1 What it is

**Global message search** finds messages across **all sessions** through a single endpoint,
`GET /api/search`. Instead of looping over `GET /api/sessions/:id/messages/...` per session and
filtering client-side, a caller sends one query — a free-text term plus optional structural filters
(session, chat, direction, type, sender, date range) — and gets a ranked, paginated hit list with
highlighted snippets. It is the search substrate the dashboard search panel and external integrations
build on.

Search is **on by default** and works with zero external dependencies: the built-in provider is
DB-native (PostgreSQL `tsvector`/`GIN`, SQLite `FTS5`), so there is no separate search service to
provision, run, or keep in sync. Set `SEARCH_ENABLED=false` to remove the route and module entirely.

## 26.2 The provider model

Search is backed by an open `SearchProvider` contract, not a hardcoded query path:

```ts
interface SearchProvider {
  readonly id: string;      // e.g. 'builtin-fts'
  readonly label: string;   // human label for dashboard/config
  search(query: SearchQuery): Promise<SearchResults>;
  health(): Promise<SearchHealth>; // ok=false surfaces as 503
}
```

A registry holds the set of registered providers and the currently active one. Core registers
`builtin-fts` at bootstrap; a marketplace plugin registers itself the same way and can be promoted
with `SEARCH_PROVIDER`. When no provider is registered, the route returns `501` (never crashes boot).
The active provider answers every `/search` call, so swapping backends is a config change, not a code
change. Importantly, **indexing is not part of the contract** — each provider owns how its index stays
current (the built-in is DB-level; a plugin is hook-driven, see §26.7).

## 26.3 The built-in DB full-text default

The zero-dependency default (`id: builtin-fts`) uses the database's own full-text engine, so the index
is maintained by the DB on every INSERT/UPDATE/DELETE with no application code in the write path:

- **PostgreSQL (12+)** — a STORED generated `tsvector` column (`body_ts`, config `'simple'`) on
  `messages` with a `GIN` index over it. The column is auto-maintained by Postgres, so sends,
  receives, edits, and deletes stay in sync with zero app logic. Ranking uses `ts_rank`; snippets use
  `ts_headline`.
- **SQLite (FTS5)** — an `FTS5` external-content virtual table (`messages_fts`) keyed on the implicit
  `rowid`, kept in sync by AFTER INSERT/UPDATE/DELETE triggers and backfilled once at migration time.
  Ranking uses FTS5 `rank`; snippets use `snippet()`.

Both dialects wrap the search term in their native "web search"-style helper (`websearch_to_tsquery`
on Postgres, FTS5 `MATCH` on SQLite), so quoted phrases, `OR`, and `-`exclusion behave as the
underlying engine defines them. Snippets are emitted with `<mark>`/`</mark>` highlight markers on both
dialects so the `SearchHit.snippet` contract is dialect-agnostic — and the snippet is already
XSS-safe text; render it as text, never as HTML.

## 26.4 Dual-database switching safety

Search is designed to work identically on SQLite and PostgreSQL and to survive repeated switching
between them (e.g. developing on SQLite, deploying on Postgres, exporting a SQLite DB and importing
it into Postgres). Concretely:

- **Idempotent, dialect-branched migration.** The FTS migration (`1782400000000-AddMessagesFts`)
  branches on the active dialect and uses `IF NOT EXISTS` / `IF NOT` guards, so `migration:run` is
  safe to re-run on either backend. It does the one-time backfill for existing rows on first apply.
- **The provider picks its dialect per `DataSource`.** The built-in provider inspects
  `dataSource.options.type` on every query and builds the correct SQL (`?` vs `$n` placeholders,
  `messages_fts MATCH` vs `body_ts @@`, the right snippet function), so the same code path serves both
  backends without per-dialect configuration.
- **Graceful SQLite fallback.** A SQLite build **without** FTS5 compiled in does **not** crash boot:
  the migration probes `sqlite_compileoption_used('ENABLE_FTS5')` and skips, leaving no FTS schema; the
  provider detects the absent `messages_fts` table and the route returns `501` cleanly. (The bundled
  Docker image and the official Node builds include FTS5, so this only affects a custom-compiled
  SQLite.)
- **Export/import round-trip.** Because the index is a derived, DB-maintained structure (not a
  separate data store), an OpenWA export/import — which clears the `messages` table and re-inserts —
  leaves FTS correct on both dialects: Postgres regenerates the `body_ts` column from the re-inserted
  rows, and SQLite's triggers repopulate `messages_fts` on the re-inserts. No separate search reindex
  step is needed after a restore or a dialect migration. This is covered by the dual-DB test suite.

## 26.5 Configuration

All search configuration lives in the environment (`.env` / Compose / dashboard Infrastructure form):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEARCH_ENABLED` | `true` (unset) | Set to `false` to remove the `/search` route and the entire search module — zero footprint, no DI wiring. The migration still runs (so the index is ready if you re-enable). |
| `SEARCH_PROVIDER` | `auto` | `auto` selects the built-in provider at runtime; `builtin-fts` pins it explicitly; `none` disables the route at runtime while keeping the config namespace loaded. A plugin provider id selects that plugin once registered. Validated at boot — a typo fails fast. |
| `SEARCH_LIMIT_MAX` | `100` | Hard cap applied to the `limit` query parameter, so a caller cannot request an unbounded result set. |

### The opt-out footprint note

Setting `SEARCH_ENABLED=false` removes the **route and module**, but the **full-text index itself is
maintained per-write regardless**, because the index is DB-level (generated column / triggers), not
application-level. This is deliberate and by design: the index is a cheap derived structure maintained
in-process by the database on the same write that persists the message, so there is no extra network
hop, no separate service, and no double-write. The cost is negligible (a `tsvector` generate on
Postgres, a trigger-fire on SQLite — both in-process, both on columns already being written). If you
want to drop the index entirely, run the migration `down` against the data connection.

> **Dev note — `DATABASE_SYNCHRONIZE=true`.** With synchronize on (a common zero-config dev setting),
> TypeORM creates the `messages` table from the entity, but the FTS migration does **not** run, so
> `/search` returns `501` (no FTS schema) until you run `npm run migration:run` once to install the FTS
> virtual table / generated column. Prod defaults to `synchronize=false` + `migrationsRun=true`, so this
> is dev-only.
>
> **Postgres caveat — do not combine `DATABASE_TYPE=postgres` with `DATABASE_SYNCHRONIZE=true`.** The
> Postgres data connection hardcodes `migrationsRun=true` (unlike SQLite, where it is `!synchronize`),
> so on Postgres both run every boot: the migration adds the generated `body_ts` column, then
> `synchronize` immediately drops it (the `Message` entity does not declare `body_ts`). The result is
> `/search` returning `501` silently on every restart. Use migrations (`DATABASE_SYNCHRONIZE=false`, the
> prod default) for Postgres. SQLite is unaffected (its `migrationsRun` is `!synchronize`).

## 26.6 The HTTP endpoint

See [06 - API Specification §6.4.12](./06-api-specification.md) for the full param/response reference.
In brief:

```
GET /api/search?q=<term>&sessionId=<id>&chatId=<id>&direction=<in|out>&type=<type>
            &from=<sender>&dateFrom=<ms>&dateTo=<ms>&limit=<n>&offset=<n>
```

- **`q`** is required and must be non-empty (whitespace-only is rejected with `400`). Numeric params
  are coerced and validated; a non-numeric `limit`/`offset`/`dateFrom`/`dateTo` surfaces as `400`,
  never as a `NaN` SQL parameter.
- **Auth scoping is authoritative.** The caller's API-key `allowedSessions` is injected by
  `SearchService` — **never** accepted from the query — so a scoped key cannot broaden its reach. An
  ADMIN / null-allowlist key searches all sessions; a scoped key sees only its allowlist even if it
  passes `sessionId`. The DTO carries no `sessionIds` field (it would be rejected as non-whitelisted).
- **Response** is a `SearchResults` object: `{ hits: SearchHit[], total, tookMs, provider }`. Each hit
  carries `messageId`, `waMessageId`, `sessionId`, `chatId`, `body`, `snippet`, `timestamp`, `type`,
  `direction`, `from`, and optional `score`. `total` is an exact count (bounded; computed lazily only
  when the page could be full). `tookMs` is the provider-side query time. `provider` names which
  backend answered (e.g. `builtin-fts`).
- **Errors:** `400` empty/whitespace `q`, a non-numeric numeric param, or a malformed SQLite FTS5 query
  (unbalanced quote/paren, bare operator) — Postgres is tolerant · `401`/`403` auth · `501` no
  provider configured / FTS schema absent (e.g. a non-FTS5 SQLite build) · `503` provider unhealthy
  (**reserved**: the built-in provider does not return it; it is the contract surface for a future
  plugin provider whose `search()` throws `ServiceUnavailableException`).

The endpoint requires at least `OPERATOR` role.

## 26.7 When to use a plugin backend

The built-in DB full-text provider is the right default for the common case: moderate volume, Latin and
mixed-Script text, exact-word and phrase matching, and no extra infrastructure. Reach for a plugin
provider when you need capabilities the SQL engines do not give you:

- **CJK word-segmentation and morphological analysis** — Postgres `'simple'` and SQLite FTS5 tokenize
  on whitespace/punctuation, which does not segment Chinese/Japanese/Korean. A dedicated engine
  (Meilisearch, and others) segments CJK correctly.
- **Typo-tolerance / fuzzy matching** — the built-in matches terms as the engine's tokenizer produces
  them; it does not do Levenshtein-style "did you mean" correction. A search engine backend does.
- **Large-scale relevance and ranking tuning** — at high row counts or with complex relevance needs
  (field weights, synonyms, stop-word lists, custom ranking), a purpose-built search server
  outperforms a relational FTS query and is tunable without touching the message schema.

The upgrade path is the **Meilisearch provider plugin** (the reference plugin backend, Spec 2). It
registers as a `SearchProvider`, indexes via the `message:persisted` plugin hook (so it stays current
without coupling to the message/session services), and is selected by setting `SEARCH_PROVIDER` to its
id. Because the route and the response shape are identical across providers, dashboard panels and SDKs
keep working unchanged when you switch backends.

> **Backfill is the plugin's responsibility.** The `message:persisted` hook fires only for **live**
> traffic — outbound on send, inbound on receive — never for history-backfill persistence. So a plugin
> provider installed on a deployment that already has message history must perform its own one-time
> backfill (read `messages` and index) at enablement; its index will otherwise miss pre-installation
> rows. The built-in DB-FTS provider is unaffected — its index is DB-synced via triggers on every
> insert, including backfill.

## 26.8 Migration and backfill

Adding search to an existing deployment runs the one-time `1782400000000-AddMessagesFts` migration:

- **PostgreSQL** adds the generated `body_ts` column and the `GIN` index. The column is populated for
  all existing rows by Postgres as the `ALTER TABLE ... ADD COLUMN` applies, and the GIN index builds
  **non-`CONCURRENTLY`** (a one-time blocking build). On a very large `messages` table this can hold
  writes for a while — run the upgrade during a **maintenance window**. (You can set `SEARCH_ENABLED=false`
  to skip wiring the route while the migration runs; the migration applies regardless.)
- **SQLite** creates the `messages_fts` virtual table, backfills from the existing `messages` rows in
  one `INSERT ... SELECT`, and installs the sync triggers. This is fast for typical SQLite row counts
  but scales with table size.

The migration is safe to re-run (idempotent guards) and has a `down` path that drops the FTS schema on
both dialects. After it applies, search works immediately — no separate reindex command.

---

> See also: [06 - API Specification](./06-api-specification.md) (§6.4.12 Search),
> [05 - Database Design](./05-database-design.md),
> [03 - System Architecture](./03-system-architecture.md),
> [19 - Plugin Architecture](./19-plugin-architecture.md),
> [15 - Project Roadmap](./15-project-roadmap.md).
