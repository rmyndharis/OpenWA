import {
  BadRequestException,
  Injectable,
  NotImplementedException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { setImmediate } from 'node:timers/promises';
import { createLogger } from '../../../common/services/logger.service';
import { awaitNoOpenTransaction } from '../../../common/utils/shared-connection';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import { MessageDirection } from '../../message/entities/message.entity';
import type { SearchProvider, SearchQuery, SearchResults, SearchHit } from '../search.types';
import {
  SEARCH_CONTAINS_MIN_TERM_LENGTH,
  SEARCH_CONTAINS_TERMS_MAX_LENGTH,
  SEARCH_CONTAINS_WINDOW,
  SEARCH_LIMIT_MAX,
} from '../search.constants';
import { ContainsTermsRefusedError, containsTerms, foldSearchText } from '../search-terms';
import { containsSnippet } from '../search-snippet';
import { containsScore } from '../search-score';

const MAX_SNIPPET_WORDS = 24;

/**
 * One SQLite FTS5 external-content index over `messages.body`, kept in sync by the `<table>_ai/_ad/_au`
 * triggers ensureSqliteIndex creates. `tokenize` is the FTS5 tokenizer spec; absent means FTS5's
 * default (unicode61), which is what the word index has always used.
 */
interface Fts5Index {
  table: string;
  tokenize?: string;
  /**
   * Backfill in batches that yield to the event loop, after the triggers exist, instead of in one
   * statement before them (see backfillSqliteIndexInBatches).
   */
  batched?: boolean;
}

/** The match=word index (migration 1782400000000-AddMessagesFts). */
const WORD_INDEX: Fts5Index = { table: 'messages_fts' };

/**
 * The match=contains index, built only with SEARCH_CONTAINS_ENABLED=true (see buildContainsIndex). The
 * trigram tokenizer indexes every three-character window of the body, so any substring of three or more
 * characters is a lookup instead of a scan; remove_diacritics makes it accent-insensitive like unicode61.
 */
const TRIGRAM_INDEX: Fts5Index = { table: 'messages_trgm', tokenize: 'trigram remove_diacritics 1', batched: true };

/** Rowids per backfill batch: about 10 ms of event loop each, at the 9.4 µs a row measured on 1M messages. */
const TRIGRAM_BACKFILL_BATCH = 1000;

/**
 * The session-level advisory lock one replica holds while it builds the Postgres trigram index, in the
 * two-int4 form: 0x7472676d ("trgm") first, a first key no other OpenWA lock uses (the boot migration
 * lock's is 0x4f5741, "OWA"), then the oid of the `messages` table the index is built on, so deployments
 * that share a database in different schemas (POSTGRES_SCHEMA) each build their own.
 */
export const TRIGRAM_BUILD_LOCK_KEY = 0x7472676d;
export const TRIGRAM_BUILD_LOCK = `$1, to_regclass('messages')::oid::int`;

/** How long a build kept from running (see retryContainsBuild) waits before trying again. */
const TRIGRAM_BUILD_RETRY_MS = 30_000;

/** Why match=contains answers 501, one message per cause, each naming what to change. */
const CONTAINS_UNAVAILABLE = {
  disabled: 'Contains search is disabled: set SEARCH_CONTAINS_ENABLED=true and restart to build its index.',
  building:
    'Contains search is not ready: its index is still being built (SEARCH_CONTAINS_ENABLED=true). Retry shortly.',
  failed:
    'Contains search is unavailable: building its index failed (SEARCH_CONTAINS_ENABLED=true); see the server log.',
  postgresExtensions:
    'Contains search is unavailable: install the pg_trgm and unaccent extensions (CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent;) and restart.',
  sqliteTrigram:
    'Contains search is unavailable: this SQLite build has no FTS5 trigram tokenizer (SQLite 3.45+ is required).',
} as const;

/**
 * Three letters or digits in a row, the only characters pg_trgm takes trigrams from: letters of every
 * kind, decimal digits and letter numbers (`Ⅻ`), never other numbers (`²`, `①`). The nine modifier
 * letters left out are the ones openwa_unaccent turns into punctuation before pg_trgm reads them (`ʼ`
 * into an apostrophe, `ˆ` into `^`).
 */
const POSTGRES_TRIGRAM_SOURCE = new RegExp(
  `(?:(?![\\u02b9-\\u02bd\\u02c6\\u02c8\\u02cb\\u02d0])[\\p{L}\\p{Nl}\\p{Nd}]){${SEARCH_CONTAINS_MIN_TERM_LENGTH}}`,
  'u',
);

/**
 * POSTGRES_TRIGRAM_SOURCE on a database whose ctype is C or POSIX: pg_trgm classifies characters with the
 * C library there, which knows no letter or digit outside ASCII, so it takes no trigram from any other.
 */
const POSTGRES_ASCII_TRIGRAM_SOURCE = new RegExp(`[A-Za-z0-9]{${SEARCH_CONTAINS_MIN_TERM_LENGTH}}`);

/**
 * The contains candidate SELECT list. It carries no snippet or score column: searchContains computes
 * both in the application (see containsSnippet and containsScore).
 */
const CONTAINS_COLUMNS = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from" AS "from", m."body", m."timestamp", m."type", m."direction"`;

/**
 * What the Postgres catalog holds for contains search: the schema of each extension it needs (null when
 * not installed), whether the `openwa_unaccent` wrapper exists, and the trigram index: null when absent,
 * false while a CONCURRENTLY build runs or after one died, true once usable.
 */
interface TrigramStateRow {
  trgm: string | null;
  unaccent: string | null;
  fn: boolean;
  idx: boolean | null;
}

/** Descending string order for the `id` tiebreak, as `ORDER BY "id" DESC` sorts a UUID column. */
function compareDescending(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

/**
 * The trigram tokenizer shipped in SQLite 3.34, but its remove_diacritics option only in 3.45; an older
 * library rejects the whole CREATE VIRTUAL TABLE. better-sqlite3 bundles its own SQLite, so this only
 * fails on a build linked against an old system library, where contains search then answers 501.
 */
export function sqliteSupportsTrigramDiacritics(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 3 || (major === 3 && minor >= 45);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `unaccent()` is STABLE (its result depends on a dictionary that could change), and Postgres only
 * indexes IMMUTABLE expressions, so the trigram index is built on this wrapper. Naming the dictionary
 * explicitly and schema-qualifying both references pins what the wrapper calls regardless of the
 * caller's search_path, which is what makes declaring it IMMUTABLE safe. The schema is whatever the
 * unaccent extension was installed into, read from the catalog.
 */
export function postgresUnaccentFunctionDdl(unaccentSchema: string): string {
  const schema = quoteIdent(unaccentSchema);
  return `CREATE OR REPLACE FUNCTION openwa_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT ${schema}.unaccent('${schema.replace(/'/g, "''")}.unaccent'::regdictionary, $1) $$`;
}

/** A LIKE/ILIKE pattern that finds `term` anywhere, with its own `\`, `%` and `_` matched literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * likePattern in Postgres SQL, around the folded term: unaccent maps fullwidth `％` and `＿` to `%` and
 * `_`, so escaping before it would let them through as wildcards. The backslashes are written as E''
 * literals, which read them the same whatever standard_conforming_strings says; with it off, a plain
 * `'\'` escapes its closing quote.
 */
function postgresLikePattern(placeholder: string): string {
  return String.raw`'%' || replace(replace(replace(openwa_unaccent(${placeholder}), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'`;
}

/** Shorter than a trigram once folded, so no trigram index can look it up. */
function isShortTerm(term: string): boolean {
  return [...foldSearchText(term)].length < SEARCH_CONTAINS_MIN_TERM_LENGTH;
}

/**
 * Whether pg_trgm can look `term` up. It takes trigrams from runs of letters and digits only, so `:-)` or
 * `😂😂😂` give it nothing and the search would scan the table; SQLite's trigram tokenizer indexes them.
 * `asciiOnly` is a database with a C or POSIX ctype (POSTGRES_ASCII_TRIGRAM_SOURCE).
 */
function postgresCanIndex(term: string, asciiOnly: boolean): boolean {
  return (asciiOnly ? POSTGRES_ASCII_TRIGRAM_SOURCE : POSTGRES_TRIGRAM_SOURCE).test(foldSearchText(term));
}

/** A build that could not get the shared SQLite connection free of another transaction: it is tried again later. */
class ConnectionBusyError extends Error {}

/** Shape returned by the dialect-specific SELECT in buildSqlite / buildPostgres. */
interface FtsResultRow {
  id: string;
  wa_message_id: string | null;
  session_id: string;
  chat_id: string;
  from: string;
  body: string | null;
  timestamp: string | number | null;
  type: string;
  direction: string;
  snippet: string | null;
  score: number | string | null;
}

interface CountRow {
  n: number | string;
}

/** Returns the next placeholder token (`?` for SQLite, `$n` for Postgres). */
type PlaceholderFn = () => string;

/**
 * Built-in, DB-native full-text provider. Index sync is DB-level (generated tsvector / FTS5 triggers),
 * so this class ONLY queries — it never writes the index. See migration 1782400000000-AddMessagesFts.
 *
 * Two match modes, each on its own index: `word` (the default) matches whole words through the word
 * index above and ranks them in SQL; `contains` matches any substring of three or more characters,
 * case- and accent-insensitively, through a trigram index (an FTS5 trigram table on SQLite, a pg_trgm
 * GIN index on Postgres) that only SEARCH_CONTAINS_ENABLED=true builds (see buildContainsIndex), and
 * ranks a bounded window of candidates in the application (see searchContains).
 */
@Injectable()
export class BuiltInFtsProvider implements SearchProvider, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  readonly id = 'builtin-fts';
  readonly label = 'Built-in database full-text search';
  private readonly logger = createLogger('BuiltInFtsProvider');

  /** SEARCH_CONTAINS_ENABLED: the trigram index is opt-in, since it costs about three times the message text. */
  private readonly containsEnabled: boolean;

  /** Why match=contains answers 501 right now (a CONTAINS_UNAVAILABLE message), or null once its index is ready. */
  private containsUnavailable: string | null;

  /** The next attempt at a build another replica held the lock for (see retryContainsBuild). */
  private containsBuildRetry?: NodeJS.Timeout;
  private readonly containsBuildRetryMs = TRIGRAM_BUILD_RETRY_MS;
  private destroyed = false;

  /** Whether the Postgres database has a C or POSIX ctype, read by each build (see postgresCanIndex). */
  private postgresAsciiTrigrams = false;

  // OpenWA has two TypeORM connections (main: auth/audit SQLite, data: messages). Bind explicitly to
  // 'data' so the provider queries the connection that owns the `messages` table + the FTS migration,
  // never the default/`main` one. The bare `DataSource` type alone is ambiguous with two connections.
  constructor(
    @InjectDataSource('data') private readonly dataSource: DataSource,
    // Optional so the provider still builds in a unit test without them; contains search is then off.
    @Optional() config?: ConfigService,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
  ) {
    this.containsEnabled = config?.get<boolean>('search.containsEnabled') === true;
    this.containsUnavailable = this.containsEnabled ? CONTAINS_UNAVAILABLE.building : CONTAINS_UNAVAILABLE.disabled;
  }

  /**
   * Self-heals the FTS schema at bootstrap so search works under an opted-in DATABASE_SYNCHRONIZE=true
   * on SQLite (docker-compose.dev.yml sets it; the default is migrations), where TypeORM creates the
   * `messages` table from the entity but NEVER runs migrations — so the migration that establishes
   * `messages_fts` is skipped and search would 501 on a fresh SQLite box. This re-applies the same
   * idempotent DDL as the migration (1782400000000-AddMessagesFts); `IF NOT EXISTS` / `IF NOT` guards
   * make it a no-op once the schema exists, and on Postgres no DDL is issued at all when the catalog
   * already holds the column and index, so migrations-based deployments take no table lock. Probes the
   * result into `ftsAvailable` so the first search() / health() call doesn't re-probe.
   */
  async onModuleInit(): Promise<void> {
    try {
      this.ftsAvailable = await this.ensureFtsSchema();
      if (this.ftsAvailable) {
        this.logger.log('FTS index ready');
      } else {
        this.logger.warn('FTS index unavailable (SQLite built without FTS5); /api/search will return 501');
      }
    } catch (e) {
      // Never fail boot over index creation: the route 501s cleanly via probeFts()/ensureFts() instead.
      this.logger.error(`Failed to ensure FTS schema: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Starts the contains index build once the HTTP listener is up, and does not wait for it: on a large
   * table it runs long enough that a boot held for it would miss its health probe, and the Helm startup
   * probe would restart the pod in a loop (docs/14).
   */
  onApplicationBootstrap(): void {
    if (!this.containsEnabled || !this.adapterHost) return;
    if (this.adapterHost.listening) void this.buildContainsIndex();
    else this.adapterHost.listen$.subscribe(() => void this.buildContainsIndex());
  }

  /**
   * Whether the DB-native FTS schema this provider queries is present. Cached per instance after the
   * first probe. The migration (1782400000000-AddMessagesFts) is what creates it; on a non-FTS5 SQLite
   * build the migration probes + skips, leaving the schema absent — in that state the provider must
   * 501 cleanly (see ensureFts) instead of crashing on a missing table / column.
   */
  private ftsAvailable: boolean | null = null;

  /**
   * Probes the FTS schema once per instance and caches the result. SQLite: look for the `messages_fts`
   * virtual table in sqlite_master. Postgres: look for the generated `body_ts` column on the SAME
   * `messages` table the search queries resolve — see the to_regclass note below. Safe to call
   * repeatedly; only the first successful probe hits the DB and caches.
   */
  private async probeFts(): Promise<boolean> {
    if (this.ftsAvailable !== null) return this.ftsAvailable;
    if (this.dataSource.options.type === 'postgres') {
      // to_regclass('messages') resolves the name through the session search_path — the identical
      // resolution the runtime queries (`FROM messages m`) use, and the data connection pins
      // search_path to `<schema>,public` when POSTGRES_SCHEMA is non-public (app.module.ts). So the
      // probe inspects the table search will actually hit, in the active schema. An unqualified
      // information_schema scan would instead peek across EVERY visible schema and can lie both ways
      // on a custom-schema deployment: a namesake public.messages.body_ts reports FTS present when
      // the active schema lacks it, and a >1-row match (both schemas carry the column) reports it
      // absent. to_regclass returns NULL when `messages` is unresolvable on the path → zero rows →
      // unavailable, so an undeterminable schema fails closed by construction.
      // Fail-closed on probe error (degraded state, e.g. boot ensure left the pool mid-recovery):
      // report unavailable WITHOUT caching, so search() 501s via ensureFts — the same clean posture
      // as a genuinely absent index, never a raw 500 — and a later call re-probes after recovery.
      let rows: unknown[];
      try {
        rows = await this.dataSource.query(
          `SELECT a.attname FROM pg_attribute a WHERE a.attrelid = to_regclass('messages') AND a.attname = 'body_ts' AND NOT a.attisdropped`,
        );
      } catch (e) {
        this.logger.warn(
          `FTS probe failed; treating the index as unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        return false;
      }
      this.ftsAvailable = Array.isArray(rows) && rows.length >= 1;
    } else {
      const rows: unknown[] = await this.dataSource.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'`,
      );
      this.ftsAvailable = Array.isArray(rows) && rows.length === 1;
    }
    return this.ftsAvailable;
  }

  /**
   * Guards search(): if the FTS schema is absent (non-FTS5 SQLite build or a partial state), throw
   * NotImplementedException so the route surfaces 501 — never let a raw missing-table error escape.
   */
  private async ensureFts(): Promise<void> {
    const ok = await this.probeFts();
    if (!ok) {
      throw new NotImplementedException('Search is unavailable: the database has no full-text index.');
    }
  }

  /**
   * Creates the FTS schema if missing. Mirrors migration 1782400000000-AddMessagesFts verbatim and is
   * idempotent (every statement is `IF NOT EXISTS` / `IF NOT`), so:
   *   - migrations-based deployments: the migration has already run; SQLite runs a set of no-ops,
   *     and Postgres reads the catalog and issues no DDL, because `ALTER TABLE ... IF NOT EXISTS`
   *     still queues for ACCESS EXCLUSIVE on `messages` before it finds the column, stalling every
   *     message read and write behind any open transaction.
   *   - synchronize-based SQLite deployments (DATABASE_SYNCHRONIZE=true, e.g. the dev compose):
   *     migrations are skipped, so this is what actually brings the index up at boot. Without it
   *     search 501s on every such box. Postgres refuses synchronize at boot, so the Postgres
   *     branch only repairs a schema whose FTS migration objects are missing.
   * Returns true when the index is usable, false when the SQLite build lacks FTS5 (no schema left
   * behind — the route 501s cleanly via ensureFts).
   */
  private async ensureFtsSchema(): Promise<boolean> {
    const isPostgres = this.dataSource.options.type === 'postgres';
    if (isPostgres) {
      // Uncached on purpose (probeFts caches and swallows errors). Both objects are looked up on the
      // table to_regclass resolves, the same one the runtime queries hit; only a missing one is created.
      const rows: Array<{ col: boolean; idx: boolean }> = await this.dataSource.query(
        `SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('messages') AND a.attname = 'body_ts' AND NOT a.attisdropped) AS col,
                EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass('messages') AND c.relname = 'idx_messages_body_ts') AS idx`,
      );
      if (!rows[0]?.col) {
        await this.dataSource.query(
          `ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "body_ts" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED`,
        );
      }
      if (!rows[0]?.idx) {
        await this.dataSource.query(
          `CREATE INDEX IF NOT EXISTS "idx_messages_body_ts" ON "messages" USING GIN ("body_ts")`,
        );
      }
      return true;
    }
    // SQLite: probe FTS5 first; skip leaving any schema if this build lacks it.
    if (!(await this.sqliteHasFts5())) return false;
    await this.ensureSqliteIndex(WORD_INDEX);
    return true;
  }

  /** Whether this SQLite build was compiled with FTS5; neither index can exist without it. */
  private async sqliteHasFts5(): Promise<boolean> {
    const fts5: unknown[] = await this.dataSource.query(`SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled`);
    return Boolean(Number((fts5 as Array<{ enabled: number }>)[0]?.enabled));
  }

  /**
   * Creates one FTS5 index over `messages.body` if missing, repairs its contents, and (re)creates its
   * three sync triggers. Shared by the word and trigram indexes, which differ only in table name and
   * tokenizer, so both get the same repair guarantees. Idempotent: on a healthy index every step is a
   * no-op or a trigger replaced by an identical one.
   */
  private async ensureSqliteIndex({ table, tokenize, batched }: Fts5Index): Promise<void> {
    const docsize = `${table}_docsize`;
    await this.dataSource.query(
      `CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING fts5(body, content='messages', content_rowid='rowid'${tokenize ? `, tokenize='${tokenize}'` : ''})`,
    );
    // Backfill the rows this index does not hold. NOT an emptiness test: the index is an FTS5
    // external-content table, so `count(*)` on it scans `messages` and returns THAT table's row
    // count, never the number of indexed documents — a "the index is empty" probe written that way
    // is unsatisfiable, because a zero count means `messages` itself is empty. The indexed documents
    // live in the `<table>_docsize` shadow table, so completeness is a rowid-level anti-join.
    //
    // It has to hold on a PARTIALLY populated index, not just an empty one: once a box has booted
    // once without the backfill, its later writes are indexed by the triggers below while its older
    // rows stay missing, and an emptiness test is false there and repairs nothing. Until those rows
    // are indexed the AFTER UPDATE/DELETE triggers issue FTS5 'delete' commands for documents that
    // were never added, and SQLite rejects the whole statement — so ordinary edits and deletes on
    // them fail, not merely searches. Reads `d."rowid"` rather than `d."id"`: same query plan,
    // without depending on the shadow table's column naming.
    //
    // A rowid-level gap check cannot see a renumbered table. TypeORM synchronize rebuilds `messages`
    // on SQLite by copying the rows without their implicit rowid, so after any delete the survivors
    // get new rowids and the index entries under them describe other messages. The triggers keep
    // `docsize` in step with `messages`, so an index row with no message behind it only appears after
    // such a rebuild, and any rebuild that renumbered a row leaves the old highest rowid behind. Drop
    // the whole index then and let the gap repair below re-add every row.
    const orphanRow: unknown[] = await this.dataSource.query(
      `SELECT EXISTS(SELECT 1 FROM "${docsize}" d
         WHERE NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."rowid" = d."rowid")) AS orphan`,
    );
    if (Number((orphanRow as Array<{ orphan: number }>)[0]?.orphan)) {
      this.logger.warn(`${table} holds rows the messages table no longer has; re-indexing every message`);
      await this.dataSource.query(`INSERT INTO "${table}"("${table}") VALUES ('delete-all')`);
    }
    // A batched index is filled after its triggers exist instead (backfillSqliteIndexInBatches). It is built
    // only once the HTTP listener is up, while a table rebuild at boot (synchronize) drops its triggers with
    // the old table and sessions start writing before the listener: an edit, a delete or a rowid reused
    // after one then leaves entries for text the table no longer holds, which neither the orphan check nor
    // the count sees. Without all three triggers the index is unknown, and it is emptied like one whose
    // count is off.
    if (batched) {
      const [counts] = await this.dataSource.query<Array<{ messages: number; indexed: number; triggers: number }>>(
        `SELECT (SELECT count(*) FROM "messages") AS messages, (SELECT count(*) FROM "${docsize}") AS indexed,
           (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages'
             AND name IN ('${table}_ai', '${table}_ad', '${table}_au')) AS triggers`,
      );
      if (Number(counts.messages) !== Number(counts.indexed) || Number(counts.triggers) !== 3) {
        await this.dataSource.query(`INSERT INTO "${table}"("${table}") VALUES ('delete-all')`);
      }
    } else {
      const gapRow: unknown[] = await this.dataSource.query(
        `SELECT EXISTS(SELECT 1 FROM "messages" m WHERE m."body" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "${docsize}" d WHERE d."rowid" = m."rowid")) AS missing`,
      );
      if (Number((gapRow as Array<{ missing: number }>)[0]?.missing)) {
        // `body IS NOT NULL` mirrors the migration's own backfill exactly: a repair that indexed a NULL
        // body as an empty document would leave the index disagreeing with the schema it repairs.
        await this.dataSource.query(
          `INSERT INTO "${table}"("rowid", "body")
           SELECT m."rowid", m."body" FROM "messages" m WHERE m."body" IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM "${docsize}" d WHERE d."rowid" = m."rowid")`,
        );
      }
    }
    // While a batched backfill runs, an edited or deleted row may not be indexed yet, and an FTS5
    // 'delete' of a document an external-content index never held corrupts it: delete only what docsize
    // lists.
    const deleteOld = batched
      ? `INSERT INTO "${table}"("${table}", "rowid", "body") SELECT 'delete', old."rowid", old."body" WHERE EXISTS (SELECT 1 FROM "${docsize}" WHERE "rowid" = old."rowid");`
      : `INSERT INTO "${table}"("${table}", "rowid", "body") VALUES ('delete', old."rowid", old."body");`;
    // The three sync triggers are CREATE-OR-REPLACE by name via DROP + CREATE; idempotent on re-run.
    await this.dataSource.query(`DROP TRIGGER IF EXISTS ${table}_ai`);
    await this.dataSource.query(`CREATE TRIGGER ${table}_ai AFTER INSERT ON "messages" BEGIN
      INSERT INTO "${table}"("rowid", "body") VALUES (new."rowid", new."body");
    END`);
    await this.dataSource.query(`DROP TRIGGER IF EXISTS ${table}_ad`);
    await this.dataSource.query(`CREATE TRIGGER ${table}_ad AFTER DELETE ON "messages" BEGIN
      ${deleteOld}
    END`);
    await this.dataSource.query(`DROP TRIGGER IF EXISTS ${table}_au`);
    // WHEN clause skips re-indexing on body-unchanged updates (acks/reactions/status) — mirrors the
    // migration. NULL-safe via `IS NOT` so NULL↔non-NULL body transitions still fire.
    await this.dataSource.query(
      `CREATE TRIGGER ${table}_au AFTER UPDATE ON "messages" WHEN OLD.body IS NOT NEW.body BEGIN
      ${deleteOld}
      INSERT INTO "${table}"("rowid", "body") VALUES (new."rowid", new."body");
    END`,
    );
    if (batched) await this.backfillSqliteIndexInBatches(table);
  }

  /**
   * Indexes the rows the index lacks, TRIGRAM_BACKFILL_BATCH rowids at a time, yielding to the event loop
   * between batches so requests and sessions keep being served through a build of seconds per million
   * messages. The triggers already index every row stored meanwhile.
   */
  private async backfillSqliteIndexInBatches(table: string): Promise<void> {
    const [{ last }] = await this.dataSource.query<Array<{ last: number | null }>>(
      `SELECT max("rowid") AS last FROM "messages"`,
    );
    for (let from = 0; from < (last ?? 0); from += TRIGRAM_BACKFILL_BATCH) {
      if (!(await awaitNoOpenTransaction(this.dataSource))) {
        throw new ConnectionBusyError('Another database transaction stayed open');
      }
      await this.dataSource.query(
        `INSERT INTO "${table}"("rowid", "body")
           SELECT m."rowid", m."body" FROM "messages" m
           WHERE m."rowid" > ? AND m."rowid" <= ?
           AND NOT EXISTS (SELECT 1 FROM "${table}_docsize" d WHERE d."rowid" = m."rowid")`,
        [from, from + TRIGRAM_BACKFILL_BATCH],
      );
      await setImmediate();
    }
  }

  /**
   * Builds the match=contains index when SEARCH_CONTAINS_ENABLED is on, and is a no-op otherwise. Never
   * throws: a failure leaves contains search answering 501 with the reason, and match=word untouched.
   * Public so a spec can await the build onApplicationBootstrap leaves running.
   */
  async buildContainsIndex(): Promise<void> {
    if (!this.containsEnabled) return;
    const start = Date.now();
    try {
      this.containsUnavailable =
        this.dataSource.options.type === 'postgres'
          ? await this.buildPostgresTrigramIndex()
          : await this.buildSqliteTrigramIndex();
    } catch (e) {
      if (!(e instanceof ConnectionBusyError)) {
        this.containsUnavailable = CONTAINS_UNAVAILABLE.failed;
        this.logger.error(`Failed to build the trigram index: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      this.containsUnavailable = CONTAINS_UNAVAILABLE.building;
      this.logger.warn(`Trigram index build postponed: ${e.message}`);
    }
    if (this.containsUnavailable === CONTAINS_UNAVAILABLE.building) this.retryContainsBuild();
    else if (this.containsUnavailable) this.logger.warn(this.containsUnavailable);
    else this.logger.log(`Trigram index ready in ${Date.now() - start} ms`);
  }

  /**
   * Another replica holds the Postgres build lock. If it dies or its build fails, the lock is released
   * with no valid index, and only a build attempt of this replica's own finds that, so it tries the lock
   * again until the index is ready or the attempt fails for a cause of its own. A search in the meantime
   * still finds an index the other replica finished (probePostgresTrigram).
   *
   * On SQLite, another transaction (a data import, for one) held the shared connection longer than the
   * build waits for it. The next attempt starts a backfill it cut short again from empty.
   */
  private retryContainsBuild(): void {
    if (this.destroyed) return;
    this.containsBuildRetry = setTimeout(() => {
      if (this.containsUnavailable === CONTAINS_UNAVAILABLE.building) void this.buildContainsIndex();
    }, this.containsBuildRetryMs);
    this.containsBuildRetry.unref();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.containsBuildRetry);
  }

  /** Returns why this SQLite library cannot hold the index, or null once the index is complete. */
  private async buildSqliteTrigramIndex(): Promise<string | null> {
    if (!(await this.sqliteHasFts5())) return CONTAINS_UNAVAILABLE.sqliteTrigram;
    const rows: Array<{ version: string }> = await this.dataSource.query(`SELECT sqlite_version() AS version`);
    if (!sqliteSupportsTrigramDiacritics(rows[0]?.version ?? '')) return CONTAINS_UNAVAILABLE.sqliteTrigram;
    if (!(await awaitNoOpenTransaction(this.dataSource))) {
      throw new ConnectionBusyError('Another database transaction stayed open');
    }
    await this.ensureSqliteIndex(TRIGRAM_INDEX);
    return null;
  }

  /**
   * Runs createPostgresTrigramSchema on a connection of its own: CREATE INDEX CONCURRENTLY cannot run
   * inside a transaction, which rules out a migration, and outlasts the runtime pool's statement_timeout,
   * which is lifted here. The advisory lock lets one replica build while the others answer 501 until the
   * index is valid (see retryContainsBuild). Returns why the index cannot be used yet, or null once it is
   * valid.
   */
  private async buildPostgresTrigramIndex(): Promise<string | null> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ ctype }] = await runner.manager.query<Array<{ ctype: string }>>(
        `SELECT datctype AS ctype FROM pg_database WHERE datname = current_database()`,
      );
      this.postgresAsciiTrigrams = ctype === 'C' || ctype === 'POSIX';
      const [{ locked }] = await runner.manager.query<Array<{ locked: boolean }>>(
        `SELECT pg_try_advisory_lock(${TRIGRAM_BUILD_LOCK}) AS locked`,
        [TRIGRAM_BUILD_LOCK_KEY],
      );
      if (!locked) return CONTAINS_UNAVAILABLE.building;
      let bound: string | undefined;
      try {
        const [shown] = await runner.manager.query<Array<{ statement_timeout?: string }>>('SHOW statement_timeout');
        bound = shown?.statement_timeout;
        await runner.query('SET statement_timeout = 0');
        return await this.createPostgresTrigramSchema(runner);
      } finally {
        // The connection returns to the pool: the next borrower must find its timeout and no lock. Put back
        // by value: the pool sets the timeout on connect, and RESET would drop it to the server default.
        if (bound !== undefined) await runner.query(`SELECT set_config('statement_timeout', $1, false)`, [bound]);
        await runner.query(`SELECT pg_advisory_unlock(${TRIGRAM_BUILD_LOCK})`, [TRIGRAM_BUILD_LOCK_KEY]);
      }
    } finally {
      await runner.release();
    }
  }

  /**
   * Creates what is missing of the extensions, the wrapper function and the GIN trigram index, the index
   * with CREATE INDEX CONCURRENTLY so writes go on during the build. Holding the build lock proves an
   * INVALID index is what a killed build left behind rather than one in progress, so it is rebuilt.
   */
  private async createPostgresTrigramSchema(runner: QueryRunner): Promise<string | null> {
    try {
      // IF NOT EXISTS returns before any privilege check, so a role that may not create the extensions
      // still gets past once an operator has.
      await runner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await runner.query('CREATE EXTENSION IF NOT EXISTS unaccent');
    } catch (e) {
      this.logger.warn(
        `Cannot create the pg_trgm and unaccent extensions: ${e instanceof Error ? e.message : String(e)}`,
      );
      return CONTAINS_UNAVAILABLE.postgresExtensions;
    }
    const [{ trgm, unaccent, fn, idx }] = await this.postgresTrigramState(runner);
    if (!trgm || !unaccent) return CONTAINS_UNAVAILABLE.postgresExtensions;
    if (!fn) await runner.query(postgresUnaccentFunctionDdl(unaccent));
    if (idx === false) await runner.query(`DROP INDEX CONCURRENTLY IF EXISTS "idx_messages_body_trgm"`);
    if (idx !== true) {
      await runner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_messages_body_trgm" ON "messages" USING GIN (openwa_unaccent("body") ${quoteIdent(trgm)}.gin_trgm_ops)`,
      );
    }
    return null;
  }

  /**
   * One catalog read of everything contains search needs on Postgres. The function and the index are
   * looked up through the session search_path, the same resolution the runtime queries use (see the
   * to_regclass note in probeFts).
   */
  private postgresTrigramState(runner?: QueryRunner): Promise<TrigramStateRow[]> {
    return (runner ?? this.dataSource).manager.query<TrigramStateRow[]>(
      `SELECT (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm') AS trgm,
              (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent') AS unaccent,
              to_regprocedure('openwa_unaccent(text)') IS NOT NULL AS fn,
              (SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass('messages') AND c.relname = 'idx_messages_body_trgm') AS idx`,
    );
  }

  /**
   * Marks contains search ready once the catalog holds a valid index, which another replica may have
   * built while this one waited on the lock. Fails closed like probeFts: an error leaves it unavailable.
   */
  private async probePostgresTrigram(): Promise<void> {
    try {
      const [{ trgm, unaccent, fn, idx }] = await this.postgresTrigramState();
      if (trgm && unaccent && fn && idx) this.containsUnavailable = null;
    } catch (e) {
      this.logger.warn(
        `Trigram probe failed; treating contains search as unavailable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Guards a match=contains search: disabled, still building or unbuildable is a 501 that says which. */
  private async ensureContains(): Promise<void> {
    if (this.containsUnavailable && this.containsEnabled && this.dataSource.options.type === 'postgres') {
      await this.probePostgresTrigram();
    }
    if (this.containsUnavailable) throw new NotImplementedException(this.containsUnavailable);
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    if (query.match === 'contains') return this.searchContains(query);
    await this.ensureFts();
    const start = Date.now();
    const isPostgres = this.dataSource.options.type === 'postgres';
    const limit = Math.max(1, Math.min(query.limit ?? 50, SEARCH_LIMIT_MAX));
    const offset = Math.max(0, query.offset ?? 0);

    const { sql, params } = isPostgres
      ? this.buildPostgres(query, limit, offset)
      : this.buildSqlite(query, limit, offset);

    // SQLite FTS5 treats `"`, `(`, `)`, `*`, and bare OR/AND/NOT/NEAR as query syntax, so a malformed
    // query (`?q="hello`, `?q=(test`, `?q=*foo`) raises one of three query-grammar errors at exec time
    // (`fts5: syntax error`, `unterminated string`, `unknown special query`). Surface those as a 400 —
    // matching Postgres's tolerant websearch_to_tsquery, which has no equivalent failure mode — never a
    // raw 500. Generic DB errors (`no such column`, connection drops) are rethrown unchanged.
    const fts5QueryError = /(fts5:\s*syntax\s*error|unterminated\s+string|unknown\s+special\s+query)/i;
    let rows: FtsResultRow[];
    try {
      rows = await this.dataSource.query<FtsResultRow[]>(sql, params);
    } catch (e) {
      if (!isPostgres && fts5QueryError.test(String(e))) {
        throw new BadRequestException('Malformed search query for SQLite full-text search.');
      }
      throw e;
    }
    const hits: SearchHit[] = rows.map(r => this.mapRow(r));
    const total = rows.length < limit && offset === 0 ? rows.length : await this.count(query, isPostgres);

    return { hits, total, tookMs: Date.now() - start, provider: this.id };
  }

  /**
   * match=contains, in two phases (docs/26, "Match modes"):
   *
   *  1. The database returns at most SEARCH_CONTAINS_WINDOW candidates: the most recently stored
   *     messages that contain every term, found through the trigram index, newest first. Both
   *     dialects answer that order from an index and stop once the window is full, so a common match
   *     costs no more than a rare one. A message the index yields that a narrowing term then rules out
   *     does not fill it, so the messages holding the looked-up terms bound the work, multiplied by
   *     the length of the terms (SEARCH_CONTAINS_TERMS_MAX_LENGTH).
   *  2. The application ranks the candidates with containsScore (whole word, then word start, then
   *     inside a word), newest first within a score and `id` last for a total order, and pages them in
   *     memory.
   *
   * Ranking every match in SQL instead (bm25 / word_similarity) costs time in proportion to the
   * matches: about 100 ms on SQLite and 1.6 s on Postgres for a term found in 200k of 1M messages, and
   * on SQLite that time blocks the event loop every session shares. With the window the same search
   * takes about 2 ms on SQLite and 10 to 20 ms on Postgres. The price is that relevance only orders
   * the window: `total` is the window's size at most, and older matches are reached by narrowing the
   * query (more terms, chatId, dateTo), since the filters apply before the window. Scoring one row at
   * a time also means a score never reflects messages outside the caller's scope, so unlike bm25 it
   * is never withheld.
   */
  private async searchContains(query: SearchQuery): Promise<SearchResults> {
    await this.ensureContains();
    const isPostgres = this.dataSource.options.type === 'postgres';
    const terms = BuiltInFtsProvider.containsTermsOf(query.q, isPostgres, this.postgresAsciiTrigrams);
    const start = Date.now();
    const limit = Math.max(1, Math.min(query.limit ?? 50, SEARCH_LIMIT_MAX));
    const offset = Math.max(0, query.offset ?? 0);

    const { sql, params } = isPostgres
      ? this.buildPostgresCandidates(query, terms)
      : this.buildSqliteCandidates(query, terms);
    const rows = await this.dataSource.query<FtsResultRow[]>(sql, params);

    const ranked = rows
      .map(row => ({ row, score: containsScore(row.body ?? '', terms) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.row.timestamp ?? 0) - Number(a.row.timestamp ?? 0) ||
          compareDescending(a.row.id, b.row.id),
      );
    const hits: SearchHit[] = ranked.slice(offset, offset + limit).map(({ row, score }) => ({
      ...this.mapRow(row),
      snippet: containsSnippet(row.body ?? '', terms, MAX_SNIPPET_WORDS),
      score,
    }));

    return { hits, total: ranked.length, tookMs: Date.now() - start, provider: this.id };
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    // Reflects FTS availability (not just raw connectivity): a non-FTS5 build reports unhealthy here
    // for callers of health(). DB errors still map to { ok: false }.
    try {
      const ok = await this.probeFts();
      return { ok, detail: ok ? undefined : 'full-text index absent' };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  private mapRow(r: FtsResultRow): SearchHit {
    return {
      messageId: r.id,
      waMessageId: r.wa_message_id ?? '',
      sessionId: r.session_id,
      chatId: r.chat_id,
      body: r.body ?? '',
      snippet: r.snippet ?? '',
      timestamp: Number(r.timestamp ?? 0),
      type: r.type as MessageType,
      direction: r.direction as MessageDirection,
      from: r.from,
      score: r.score == null ? undefined : Number(r.score),
    };
  }

  /**
   * Dialect-aware placeholder generator. SQLite binds `?` positionally by param-array order
   * (so we emit `?` regardless of slot). Postgres binds `$n` positional by the order tokens
   * APPEAR in the final SQL string — so each call returns the next `$n`, and callers MUST
   * invoke it in SQL-appearance order while pushing the matching param in the same step.
   */
  private static sqlitePlaceholder: PlaceholderFn = () => '?';
  private pgPlaceholder(): PlaceholderFn {
    let n = 0;
    return () => `$${++n}`;
  }

  /**
   * Quote every whitespace-separated token (doubling internal quotes) so user input matches
   * LITERALLY. SQLite FTS5 treats `"`, `(`, `)`, `*`, `@`, and bare AND/OR/NOT/NEAR as query
   * grammar, so a raw query (`?q="hello`, `?q=262813461250071@lid`) raises a grammar error at exec
   * time — and phone numbers / chatIds are natural search terms here. Verified against FTS5:
   * `a b` and `"a" "b"` are semantically identical (implicit AND), so multi-token behavior is
   * unchanged. Postgres already uses the tolerant websearch_to_tsquery and needs no equivalent.
   */
  private static toFts5Query(raw: string): string {
    // A repeated token is dropped: `a a` is `a` under implicit AND, but FTS5 would pay for each copy
    // on every matching row.
    const tokens = [...new Set(raw.trim().split(/\s+/).filter(Boolean))];
    if (tokens.length === 0) return '""';
    return tokens.map(tok => `"${tok.replace(/"/g, '""')}"`).join(' ');
  }

  /**
   * The whitespace-separated terms of a contains query, repeats folded away (`Invoice invoice` is one
   * term). Every term must appear in the body, as with match=word. A trigram index cannot answer a term
   * it takes no trigram from (FTS5 returns nothing for it, pg_trgm scans every row), so such terms only
   * narrow the rows another term already found, and a query made of them alone is a 400 rather than a
   * full-table scan. SQLite takes trigrams from any three characters, pg_trgm only from three letters or
   * digits in a row, ASCII ones on a C or POSIX ctype (see postgresCanIndex). The terms together are bounded
   * by SEARCH_CONTAINS_TERMS_MAX_LENGTH, since each of their characters costs a check on every candidate.
   */
  private static containsTermsOf(q: string, isPostgres: boolean, asciiOnly: boolean): string[] {
    const terms = containsTerms(q);
    const canIndex = (term: string) => (isPostgres ? postgresCanIndex(term, asciiOnly) : !isShortTerm(term));
    if (!terms.some(canIndex)) {
      const unit = isPostgres ? `${asciiOnly ? 'ASCII ' : ''}letters or digits in a row` : 'characters';
      throw new ContainsTermsRefusedError(
        `A contains search needs at least one term of ${SEARCH_CONTAINS_MIN_TERM_LENGTH} or more ${unit}.`,
      );
    }
    const length = terms.reduce((sum, term) => sum + [...foldSearchText(term)].length, 0);
    if (length > SEARCH_CONTAINS_TERMS_MAX_LENGTH) {
      throw new ContainsTermsRefusedError(
        `The terms of a contains search may hold at most ${SEARCH_CONTAINS_TERMS_MAX_LENGTH} characters together, spaces not counted.`,
      );
    }
    return terms;
  }

  // --- SQLite FTS5 -----------------------------------------------------------
  // SQL appearance order: MATCH term -> filters -> LIMIT -> OFFSET. Params pushed in that order.
  // Both dialects tiebreak on `m."id"`: neither `rank`/`score` nor the whole-second `timestamp` is
  // unique (a one-word query can score every hit identically), and without a total order a paged
  // walk repeats some hits and never returns others. Measured on Postgres, which sorts a tie group
  // differently per LIMIT/OFFSET: an ordinary search repeated a row by the third page. SQLite was
  // already self-consistent, but it keeps the term so the two dialects page alike; its plan is
  // unchanged (the ORDER BY already needed a temp b-tree) and the extra column costs about a
  // millisecond a page.
  private buildSqlite(q: SearchQuery, limit: number, offset: number) {
    const ph = BuiltInFtsProvider.sqlitePlaceholder;
    const params: unknown[] = [];
    const where: string[] = [`messages_fts MATCH ${ph()}`];
    params.push(BuiltInFtsProvider.toFts5Query(q.q));
    this.applyFilters(where, params, q, 'm.', ph);
    // bm25 weighs a term by how many messages the whole index holds, so the value of a hit a caller
    // scoped to some sessions or chats may read still reflects the ones it may not. It keeps ordering the
    // hits; only the value is withheld. An empty session list is no restriction (applyFilters), an empty
    // chat list is a restriction to nothing.
    const scoped = q.chatIds !== undefined || (q.sessionIds?.length ?? 0) > 0;
    const score = scoped ? 'NULL' : 'rank';
    const cols = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from" AS "from", m."body", m."timestamp", m."type", m."direction", snippet(messages_fts, 0, '<mark>', '</mark>', '…', ${MAX_SNIPPET_WORDS}) AS snippet, ${score} AS score`;
    const sql = `SELECT ${cols} FROM messages_fts JOIN messages m ON m."rowid" = messages_fts."rowid" WHERE ${where.join(' AND ')} ORDER BY rank, m."timestamp" DESC, m."id" DESC LIMIT ${ph()} OFFSET ${ph()}`;
    params.push(limit, offset);
    return { sql, params };
  }

  // --- Postgres tsvector -----------------------------------------------------
  // SQL appearance order: FTS term (in FROM clause) -> filters (in WHERE) -> LIMIT -> OFFSET.
  // The FTS term lives in `FROM messages m, websearch_to_tsquery('simple', $1) AS q(query)`,
  // which renders BEFORE the WHERE filters — so it must be `$1`, filters `$2..`, LIMIT/OFFSET last.
  // Params are pushed in the same order so the Nth param maps to `$N`.
  private buildPostgres(q: SearchQuery, limit: number, offset: number) {
    const ph = this.pgPlaceholder();
    const params: unknown[] = [];
    const ftsTerm = `websearch_to_tsquery('simple', ${ph()}) AS q(query)`;
    params.push(q.q);
    const where: string[] = [`m.body_ts @@ q.query`];
    this.applyFilters(where, params, q, 'm.', ph);
    // StartSel/StopSel are pinned to <mark>/</mark> to match the SQLite FTS5 snippet() output, so the
    // SearchHit.snippet contract stays dialect-agnostic (PG's ts_headline defaults to <b>/</b>).
    const cols = `m."id", m."waMessageId" AS wa_message_id, m."sessionId" AS session_id, m."chatId" AS chat_id, m."from", m."body", m."timestamp", m."type", m."direction", ts_headline('simple', m."body", q.query, 'MaxFragments=1, MaxWords=${MAX_SNIPPET_WORDS}, StartSel=<mark>, StopSel=</mark>') AS snippet, ts_rank(m.body_ts, q.query) AS score`;
    const sql = `SELECT ${cols} FROM messages m, ${ftsTerm} WHERE ${where.join(' AND ')} ORDER BY score DESC, m."timestamp" DESC, m."id" DESC LIMIT ${ph()} OFFSET ${ph()}`;
    params.push(limit, offset);
    return { sql, params };
  }

  // --- SQLite FTS5 trigram candidates (match=contains) -----------------------
  // SQL appearance order: MATCH term -> short-term LIKEs -> filters -> LIMIT. The trigram tokenizer
  // folds case and, with remove_diacritics, accents, so `cafe` finds `Café` and `voic` finds
  // `Invoice`. A term under three characters cannot be looked up in it and is checked with LIKE on the
  // rows the MATCH kept; SQLite's LIKE folds ASCII case only, which covers the ids and abbreviations
  // such terms usually are (`id`, `pm`, `v2`). FTS5 answers `ORDER BY rowid DESC` from its own doclist
  // order, so the LIMIT stops the walk at the window instead of sorting every match; rowid is the
  // insertion order, so these are the most recently stored matches.
  private buildSqliteCandidates(q: SearchQuery, terms: string[]) {
    const ph = BuiltInFtsProvider.sqlitePlaceholder;
    const params: unknown[] = [];
    const where = [`${TRIGRAM_INDEX.table} MATCH ${ph()}`];
    params.push(BuiltInFtsProvider.toFts5Query(terms.filter(term => !isShortTerm(term)).join(' ')));
    for (const term of terms.filter(isShortTerm)) {
      where.push(`m."body" LIKE ${ph()} ESCAPE '\\'`);
      params.push(likePattern(term));
    }
    this.applyFilters(where, params, q, 'm.', ph);
    const sql = `SELECT ${CONTAINS_COLUMNS} FROM ${TRIGRAM_INDEX.table} JOIN messages m ON m."rowid" = ${TRIGRAM_INDEX.table}."rowid" WHERE ${where.join(' AND ')} ORDER BY ${TRIGRAM_INDEX.table}."rowid" DESC LIMIT ${ph()}`;
    params.push(SEARCH_CONTAINS_WINDOW);
    return { sql, params };
  }

  // --- Postgres pg_trgm candidates (match=contains) --------------------------
  // SQL appearance order: one ILIKE per term -> filters -> LIMIT. Each ILIKE compares
  // openwa_unaccent(body), the exact expression the GIN trigram index holds; ILIKE folds case and
  // openwa_unaccent folds accents, and each term has its `%`, `_` and `\` escaped after that fold so it
  // matches literally (postgresLikePattern). unaccent also transliterates letters remove_diacritics
  // leaves alone (Ł, ß, Ø, œ), so Postgres finds some matches SQLite does not (docs/26). The most
  // recently stored first, as on SQLite: IDX_messages_createdAt lets the planner walk them backward and
  // stop at the window when a term is common, while for a rare one it reads the few matches from the
  // GIN index and sorts them.
  private buildPostgresCandidates(q: SearchQuery, terms: string[]) {
    const ph = this.pgPlaceholder();
    const params: unknown[] = [];
    const where = terms.map(term => {
      const placeholder = ph();
      params.push(term);
      return `openwa_unaccent(m."body") ILIKE ${postgresLikePattern(placeholder)}`;
    });
    this.applyFilters(where, params, q, 'm.', ph);
    const sql = `SELECT ${CONTAINS_COLUMNS} FROM messages m WHERE ${where.join(' AND ')} ORDER BY m."createdAt" DESC, m."id" DESC LIMIT ${ph()}`;
    params.push(SEARCH_CONTAINS_WINDOW);
    return { sql, params };
  }

  /** Emits dialect-correct placeholders. For PG, MUST be called in SQL-appearance order. */
  private applyFilters(where: string[], params: unknown[], q: SearchQuery, prefix: string, ph: PlaceholderFn): void {
    if (q.sessionIds && q.sessionIds.length) {
      const placeholders = q.sessionIds.map(() => ph()).join(',');
      where.push(`${prefix}"sessionId" IN (${placeholders})`);
      params.push(...q.sessionIds);
    }
    if (q.sessionId) {
      where.push(`${prefix}"sessionId" = ${ph()}`);
      params.push(q.sessionId);
    }
    if (q.chatId) {
      // Every stored form of the chat when the host expanded it (a chat first stored under a lid and later
      // under the phone is one chat, as in the message list), the literal id otherwise.
      if (q.chatIdAliases?.length) {
        const placeholders = q.chatIdAliases.map(() => ph()).join(',');
        where.push(`${prefix}"chatId" IN (${placeholders})`);
        params.push(...q.chatIdAliases);
      } else {
        where.push(`${prefix}"chatId" = ${ph()}`);
        params.push(q.chatId);
      }
    }
    if (q.chatIds?.length === 0) where.push('1 = 0');
    else if (q.chatIds) {
      const placeholders = q.chatIds.map(() => ph()).join(',');
      where.push(`${prefix}"chatId" IN (${placeholders})`);
      params.push(...q.chatIds);
    }
    if (q.from) {
      if (q.fromAliases?.length) {
        // A group message keeps the group id in `from` and the person in `author`, so both are matched.
        const asSender = q.fromAliases.map(() => ph()).join(',');
        const asAuthor = q.fromAliases.map(() => ph()).join(',');
        where.push(`(${prefix}"from" IN (${asSender}) OR ${prefix}"author" IN (${asAuthor}))`);
        params.push(...q.fromAliases, ...q.fromAliases);
      } else {
        where.push(`${prefix}"from" = ${ph()}`);
        params.push(q.from);
      }
    }
    if (q.direction) {
      where.push(`${prefix}"direction" = ${ph()}`);
      params.push(q.direction);
    }
    if (q.type) {
      const types = Array.isArray(q.type) ? q.type : [q.type];
      const placeholders = types.map(() => ph()).join(',');
      where.push(`${prefix}"type" IN (${placeholders})`);
      params.push(...types);
    }
    // The public contract (DTO + docs) is epoch-ms, but messages.timestamp stores epoch-seconds
    // (WhatsApp messageTimestamp — see the inbound mappers in the engine adapters). Bind ms→seconds
    // at the boundary, otherwise `seconds >= ms` is false for every modern row and dateFrom/dateTo
    // silently exclude all results.
    if (q.dateFrom != null) {
      where.push(`${prefix}"timestamp" >= ${ph()}`);
      params.push(Math.ceil(q.dateFrom / 1000));
    }
    if (q.dateTo != null) {
      where.push(`${prefix}"timestamp" <= ${ph()}`);
      params.push(Math.floor(q.dateTo / 1000));
    }
  }

  private async count(q: SearchQuery, isPostgres: boolean): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (isPostgres) {
      const ph = this.pgPlaceholder();
      const ftsTerm = `websearch_to_tsquery('simple', ${ph()}) AS q(query)`;
      params.push(q.q);
      where.push(`m.body_ts @@ q.query`);
      this.applyFilters(where, params, q, 'm.', ph);
      const sql = `SELECT count(*)::int AS n FROM messages m, ${ftsTerm} WHERE ${where.join(' AND ')}`;
      const rows = await this.dataSource.query<CountRow[]>(sql, params);
      return Number(rows[0]?.n ?? 0);
    }
    const ph = BuiltInFtsProvider.sqlitePlaceholder;
    where.push(`messages_fts MATCH ${ph()}`);
    params.push(BuiltInFtsProvider.toFts5Query(q.q));
    this.applyFilters(where, params, q, 'm.', ph);
    const sql = `SELECT count(*) AS n FROM messages_fts JOIN messages m ON m."rowid" = messages_fts."rowid" WHERE ${where.join(' AND ')}`;
    const rows = await this.dataSource.query<CountRow[]>(sql, params);
    return Number(rows[0]?.n ?? 0);
  }
}
