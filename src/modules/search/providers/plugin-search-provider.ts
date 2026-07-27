import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import type { SearchProvider, SearchQuery, SearchResults, SearchHealth } from '../search.types';

/**
 * The host-side transport a PluginSearchProvider uses to reach its worker: dispatch a search query and
 * run the plugin's general healthCheck. Satisfied structurally by PluginWorkerHost, so the search module
 * has no static dependency on the plugin sandbox — the loader (which knows both) passes the host in.
 */
export interface PluginSearchTransport {
  dispatchSearch(options: {
    query: SearchQuery;
    timeoutMs: number;
  }): Promise<{ ok: true; results: SearchResults } | { ok: false; error: string }>;
  healthCheck(timeoutMs: number): Promise<{ healthy: boolean; message?: string }>;
}

/** Required string fields of a SearchHit (score stays optional), mirrored for runtime checks. */
const SEARCH_HIT_STRING_FIELDS = [
  'messageId',
  'waMessageId',
  'sessionId',
  'chatId',
  'body',
  'snippet',
  'type',
  'direction',
  'from',
] as const;

/**
 * Validate a SearchResults payload that crossed the worker IPC boundary, returning a description of the
 * first violation or null when the shape is sound. The worker is not a security boundary and the wire
 * payload is untrusted: a plugin bug (or hostile worker) can post anything as `results` — a fabricated
 * `total`, a non-array `hits` (which would 500 the re-filter below), or hits missing the fields the
 * dashboard renders. Rules mirror the declared SearchResults contract; extra fields are tolerated so an
 * additive legit provider is never broken.
 */
export function validatePluginSearchResults(results: unknown): string | null {
  if (!results || typeof results !== 'object' || Array.isArray(results)) return 'results must be an object';
  const r = results as Record<string, unknown>;
  if (!Array.isArray(r.hits)) return 'results.hits must be an array';
  if (typeof r.total !== 'number' || !Number.isFinite(r.total) || r.total < 0) {
    return 'results.total must be a finite number >= 0';
  }
  if (typeof r.tookMs !== 'number' || !Number.isFinite(r.tookMs) || r.tookMs < 0) {
    return 'results.tookMs must be a finite number >= 0';
  }
  if (typeof r.provider !== 'string' || r.provider.length === 0) return 'results.provider must be a non-empty string';
  for (const [index, hit] of (r.hits as unknown[]).entries()) {
    if (!hit || typeof hit !== 'object' || Array.isArray(hit)) return `results.hits[${index}] must be an object`;
    const h = hit as Record<string, unknown>;
    for (const field of SEARCH_HIT_STRING_FIELDS) {
      if (typeof h[field] !== 'string') return `results.hits[${index}].${field} must be a string`;
    }
    if (typeof h.timestamp !== 'number' || !Number.isFinite(h.timestamp)) {
      return `results.hits[${index}].timestamp must be a finite number`;
    }
    if (h.score !== undefined && (typeof h.score !== 'number' || !Number.isFinite(h.score))) {
      return `results.hits[${index}].score must be a finite number when present`;
    }
  }
  return null;
}

/**
 * A SearchProvider backed by a sandboxed plugin's worker. The host routes a query to the worker via the
 * search RPC (dispatchSearch); the plugin runs its own backend logic (Meilisearch, Elasticsearch, etc.)
 * and returns SearchResults. health() reuses the worker's general healthCheck (healthy→ok, message→detail)
 * — no search-specific health message (Part 1 decision). All vendor-specific logic lives in the plugin.
 */
export class PluginSearchProvider implements SearchProvider {
  readonly id: string;

  constructor(
    pluginId: string,
    readonly label: string,
    private readonly transport: PluginSearchTransport,
    private readonly timeoutMs: number,
  ) {
    this.id = `plugin:${pluginId}`;
  }

  async search(query: SearchQuery): Promise<SearchResults> {
    const reply = await this.transport.dispatchSearch({ query, timeoutMs: this.timeoutMs });
    if (!reply.ok) throw new ServiceUnavailableException(reply.error);
    // The result shape is untrusted wire data: reject an invalid payload with an honest 502 (bad
    // upstream) instead of fabricating a 200 — or crashing the re-filter below into a 500.
    const invalid = validatePluginSearchResults(reply.results);
    if (invalid) throw new BadGatewayException(`Search provider ${this.id} returned invalid results: ${invalid}`);
    // Defense-in-depth: the plugin is expected to honor sessionIds, but re-filter host-side so a plugin
    // bug or leak can never surface a hit outside the caller's allowed session scope — mirroring the
    // SQL-enforced scoping the built-in provider gets for free. The guard mirrors the built-in
    // provider's applyFilters condition (`sessionIds && sessionIds.length`) so the two providers never
    // diverge for the same query (an empty array is a no-op on both paths). When no filtering is
    // needed, return the results untouched. Preserve the plugin's total when no hits were out of scope
    // (the normal, well-behaved case) so pagination ("Load More" = hits.length < total) still works;
    // fall back to the filtered page count only when a leak was actually stripped (the plugin's claimed
    // total is then also suspect). tookMs/provider are passthrough metadata unrelated to scope.
    if (!query.sessionIds || !query.sessionIds.length) return reply.results;
    const allowed = new Set(query.sessionIds);
    const scoped = reply.results.hits.filter(h => allowed.has(h.sessionId));
    const leaked = reply.results.hits.length - scoped.length;
    return {
      hits: scoped,
      total: leaked > 0 ? scoped.length : reply.results.total,
      tookMs: reply.results.tookMs,
      provider: reply.results.provider,
    };
  }

  async health(): Promise<SearchHealth> {
    const result = await this.transport.healthCheck(this.timeoutMs);
    return { ok: result.healthy, detail: result.message };
  }
}
