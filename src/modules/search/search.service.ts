import { Injectable, NotImplementedException } from '@nestjs/common';
import { SearchProviderRegistry } from './search-provider.registry';
import { SEARCH_DEFAULT_LIMIT, SEARCH_LIMIT_MAX, SEARCH_OFFSET_MAX } from './search.constants';
import type { SearchQuery, SearchResults } from './search.types';

@Injectable()
export class SearchService {
  constructor(private readonly registry: SearchProviderRegistry) {}

  async search(query: SearchQuery, callerSessionIds?: string[]): Promise<SearchResults> {
    const provider = this.registry.active();
    if (!provider) throw new NotImplementedException('Search is not configured (no active search provider).');
    // Auth scoping is authoritative — a caller cannot override it via the query.
    // Bound pagination host-side so EVERY provider (built-in + plugin) receives capped values: the
    // built-in re-clamps in its own SQL, but a plugin would otherwise receive the raw caller value
    // and could pressure host heap by returning an oversized page.
    const scoped: SearchQuery = {
      ...query,
      sessionIds: callerSessionIds,
      limit: Math.min(query.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_LIMIT_MAX),
      offset: Math.min(query.offset ?? 0, SEARCH_OFFSET_MAX),
    };
    return provider.search(scoped);
  }

  async health() {
    const provider = this.registry.active();
    if (!provider) return { ok: false, detail: 'no provider' };
    return provider.health();
  }
}
