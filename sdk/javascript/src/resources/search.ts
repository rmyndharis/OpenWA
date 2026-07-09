/**
 * Search resource — cross-session message search via the active search provider.
 *
 * Backed by `src/modules/search/search.controller.ts` (`GET /search`).
 * @packageDocumentation
 */

import type { OpenWAClient } from '../client.js';
import type { SearchParams, SearchResults } from '../types.js';

export class SearchResource {
  constructor(private readonly client: OpenWAClient) {}

  /**
   * Search persisted messages across sessions via the active search provider
   * (built-in DB full-text or a configured plugin). Requires an OPERATOR-level
   * API key; a scoped key's reach is bounded by its `allowedSessions`.
   */
  search(params: SearchParams): Promise<SearchResults> {
    return this.client.request<SearchResults>({
      method: 'GET',
      path: '/api/search',
      query: params,
    });
  }
}
