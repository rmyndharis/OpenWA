import { resolveNonNegativeIntEnv } from '../../config/configuration';
import type { SearchMatch } from './search.types';

/**
 * Host-side /search pagination bounds. Applied in SearchService BEFORE delegating to any provider,
 * so every backend (built-in DB full-text + plugin-backed) receives bounded pagination — a plugin
 * cannot be coaxed into returning an unbounded result set that pressures host heap. The built-in
 * provider re-asserts SEARCH_LIMIT_MAX inside its own SQL (defense-in-depth) by importing the same
 * constant, keeping a single source for the cap.
 *
 * SEARCH_LIMIT_MAX is env-driven (default 100, matching the historical built-in default).
 * SEARCH_OFFSET_MAX is a fixed deep-pagination guard (an offset this large is almost always a scan
 * or abuse pattern), intentionally not env-driven to avoid expanding the config surface.
 */
export const SEARCH_LIMIT_MAX = resolveNonNegativeIntEnv(process.env.SEARCH_LIMIT_MAX, 100) || 100;

/** Generous upper bound on offset across every provider. */
export const SEARCH_OFFSET_MAX = 100_000;

/** Default page size when a caller omits `limit` (matches the built-in provider's historical default). */
export const SEARCH_DEFAULT_LIMIT = 50;

/** Longest `q`, in characters. A generous bound: it exists so the request cannot be a megabyte of terms. */
export const SEARCH_QUERY_MAX_LENGTH = 1000;

/**
 * Most words in `q`, counted as the index counts them (see search-terms.ts). Each one costs a pass over
 * every message that matches, and the built-in provider runs on the event loop, so a query of hundreds
 * of words froze every session for seconds. A whitespace-separated word repeated is one word: the
 * provider collapses repeats.
 */
export const SEARCH_TERMS_MAX = 32;

/** Every accepted `match` value, for the DTO, the OpenAPI enum and the MCP tool schema alike. */
export const SEARCH_MATCH_MODES = ['word', 'contains'] as const satisfies readonly SearchMatch[];

/**
 * Shortest term a match=contains search can look up in a trigram index: a trigram is three characters,
 * so a shorter term has none (SQLite's trigram table returns nothing for it, pg_trgm scans every row).
 * A query needs at least one term this long, counted in letters and digits in a row on Postgres, whose
 * pg_trgm takes trigrams from nothing else; shorter ones only narrow what it found.
 */
export const SEARCH_CONTAINS_MIN_TERM_LENGTH = 3;

/**
 * Most characters the terms of a match=contains query may hold together, counted after folding and
 * without the spaces between them. The trigram index checks every trigram of a term on every message
 * that holds all of them, and on SQLite synchronously: a query of `the` repeated, on 200k messages of
 * which 40% hold `the`, `het` and `eth`, took about 100 ms at 64 characters whether written as one term
 * or as several, and 2.8 s at 1000. A longer query answers 400; match=word runs it.
 */
export const SEARCH_CONTAINS_TERMS_MAX_LENGTH = 64;

/**
 * How many candidates a match=contains search ranks: the most recently stored matches, fetched from
 * the index in recency order so the database stops once it holds this many, then ranked in the
 * application. It bounds the ranking work of one search (ranking every match in SQL took about
 * 100 ms on SQLite and 1.6 s on Postgres for 200k matches) and is therefore also the most `total` can
 * report in this mode. Fixed rather than env-driven, like SEARCH_OFFSET_MAX.
 */
export const SEARCH_CONTAINS_WINDOW = 1000;
