/** Default and maximum number of items returned by a paginated list endpoint. */
export const DEFAULT_LIST_LIMIT = 1000;

/** Optional pagination window for a list endpoint. */
export interface ListOptions {
  limit?: number;
  offset?: number;
}

/** Normalize a query/list window for both in-memory slicing and database skip/take. */
export function resolveListWindow(limit?: number, offset?: number): { limit: number; offset: number } {
  const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset) ? Math.max(Math.trunc(offset), 0) : 0;
  const normalizedLimit =
    typeof limit === 'number' && Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), DEFAULT_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT;
  return { limit: normalizedLimit, offset: normalizedOffset };
}

/**
 * Bound an in-memory list for an HTTP response.
 *
 * Engine-backed list endpoints (contacts, groups, chats) can return the operator's entire address
 * book / chat set; serializing tens of thousands of items into one JSON body is a heap/GC hazard.
 * This clamps the response window:
 *   - an omitted or non-finite `limit` falls back to {@link DEFAULT_LIST_LIMIT} (the default cap),
 *   - an explicit `limit` is clamped to `[1, DEFAULT_LIST_LIMIT]`,
 *   - `offset` (non-finite -> 0) pages beyond the first window.
 *
 * Pagination is applied at the HTTP/service boundary only — the engine still returns the full set
 * to in-process callers (e.g. plugins), so this never narrows what those consumers see.
 */
export function paginate<T>(items: T[], limit?: number, offset?: number): T[] {
  const { limit: lim, offset: off } = resolveListWindow(limit, offset);
  return items.slice(off, off + lim);
}
