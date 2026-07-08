import { Injectable, NotImplementedException } from '@nestjs/common';
import { SearchProviderRegistry } from './search-provider.registry';
import type { SearchQuery, SearchResults } from './search.types';

@Injectable()
export class SearchService {
  constructor(private readonly registry: SearchProviderRegistry) {}

  async search(query: SearchQuery, callerSessionIds?: string[]): Promise<SearchResults> {
    const provider = this.registry.active();
    if (!provider) throw new NotImplementedException('Search is not configured (no active search provider).');
    // Auth scoping is authoritative — a caller cannot override it via the query.
    const scoped: SearchQuery = { ...query, sessionIds: callerSessionIds };
    return provider.search(scoped);
  }

  async health() {
    const provider = this.registry.active();
    if (!provider) return { ok: false, detail: 'no provider' };
    return provider.health();
  }
}
