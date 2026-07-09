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
    return reply.results;
  }

  async health(): Promise<SearchHealth> {
    const result = await this.transport.healthCheck(this.timeoutMs);
    return { ok: result.healthy, detail: result.message };
  }
}
