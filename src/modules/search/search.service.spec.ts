import { NotImplementedException } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchProviderRegistry } from './search-provider.registry';
import { SEARCH_DEFAULT_LIMIT, SEARCH_LIMIT_MAX, SEARCH_OFFSET_MAX } from './search.constants';
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

  it('clamps an excessive limit to SEARCH_LIMIT_MAX before it reaches any provider', async () => {
    // Without the host-side clamp a plugin provider would receive the raw caller value (9999) and
    // could pressure host heap by returning an oversized page. The built-in already rejected this in
    // its own SQL; the clamp extends the same bound to every provider.
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = new SearchService(reg);
    await svc.search({ q: 'x', limit: 9999 });
    const received = (search.mock.calls[0] as [{ limit: number }])[0].limit;
    expect(received).toBe(SEARCH_LIMIT_MAX);
    expect(received).toBeLessThan(9999);
  });

  it('clamps an excessive offset to SEARCH_OFFSET_MAX before it reaches any provider', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = new SearchService(reg);
    await svc.search({ q: 'x', offset: 99_999_999 });
    const received = (search.mock.calls[0] as [{ offset: number }])[0].offset;
    expect(received).toBe(SEARCH_OFFSET_MAX);
    expect(received).toBeLessThan(99_999_999);
  });

  it('applies the default limit when the caller omits it', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = new SearchService(reg);
    await svc.search({ q: 'x' });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: SEARCH_DEFAULT_LIMIT }));
  });

  it('passes in-bounds limit/offset through unchanged', async () => {
    const reg = new SearchProviderRegistry();
    const search = jest.fn().mockResolvedValue(emptyResults);
    reg.register(mkProvider('builtin-fts', search));
    const svc = new SearchService(reg);
    await svc.search({ q: 'x', limit: 10, offset: 20 });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 20 }));
  });
});
