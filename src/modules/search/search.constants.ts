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
export const SEARCH_LIMIT_MAX = Number(process.env.SEARCH_LIMIT_MAX) || 100;

/** Generous upper bound on offset across every provider. */
export const SEARCH_OFFSET_MAX = 100_000;

/** Default page size when a caller omits `limit` (matches the built-in provider's historical default). */
export const SEARCH_DEFAULT_LIMIT = 50;
