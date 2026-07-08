import { NotImplementedException } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchProviderRegistry } from './search-provider.registry';
import type { SearchProvider, SearchResults } from './search.types';

function mkProvider(id: string, search: SearchProvider['search']): SearchProvider {
  return {
    id,
    label: id,
    health: jest.fn().mockResolvedValue({ ok: true }),
    search,
  };
}

const emptyResults = { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' } satisfies SearchResults;

describe('SearchService', () => {
  it('throws 501 (NotImplementedException) when no provider is active', async () => {
    const svc = new SearchService(new SearchProviderRegistry());
    await expect(svc.search({ q: 'x' })).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('delegates to the active provider with sessionIds injected', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = new SearchService(reg);
    await svc.search({ q: 'x' }, ['s1', 's2']);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: 'x', sessionIds: ['s1', 's2'] }));
  });

  it('does not let a caller override sessionIds', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = new SearchService(reg);
    // A smuggled `sessionIds` in the query body must be overwritten by the authoritative caller scope.
    await svc.search({ q: 'x', sessionIds: ['sneaky'] }, ['s1']);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['s1'] }));
  });
});
