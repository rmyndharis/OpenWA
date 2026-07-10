import { ServiceUnavailableException } from '@nestjs/common';
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
