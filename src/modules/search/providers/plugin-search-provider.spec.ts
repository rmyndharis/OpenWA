import { ServiceUnavailableException } from '@nestjs/common';
import { PluginSearchProvider } from './plugin-search-provider';
import type { PluginSearchTransport } from './plugin-search-provider';
import type { SearchResults } from '../search.types';

const fakeTransport = (overrides: Partial<PluginSearchTransport> = {}): PluginSearchTransport => ({
  dispatchSearch: jest
    .fn()
    .mockResolvedValue({ ok: true, results: { hits: [], total: 0, tookMs: 1, provider: 'plugin:p' } }),
  healthCheck: jest.fn().mockResolvedValue({ healthy: true, message: undefined }),
  ...overrides,
});

describe('PluginSearchProvider', () => {
  it('id is plugin:<pluginId> and the label passes through', () => {
    const p = new PluginSearchProvider('meili', 'Meilisearch (plugin)', fakeTransport(), 1000);
    expect(p.id).toBe('plugin:meili');
    expect(p.label).toBe('Meilisearch (plugin)');
  });

  it('search returns the results from the transport, forwarding the query + timeout', async () => {
    const results: SearchResults = { hits: [], total: 0, tookMs: 5, provider: 'plugin:p' };
    const dispatchSearch = jest.fn().mockResolvedValue({ ok: true, results });
    const transport = fakeTransport({ dispatchSearch });
    const p = new PluginSearchProvider('p', 'P', transport, 7000);

    await expect(p.search({ q: 'hi' })).resolves.toBe(results);
    expect(dispatchSearch).toHaveBeenCalledWith({ query: { q: 'hi' }, timeoutMs: 7000 });
  });

  it('search throws a 503 ServiceUnavailableException carrying the cause on ok:false', async () => {
    const transport = fakeTransport({
      dispatchSearch: jest.fn().mockResolvedValue({ ok: false, error: 'backend down' }),
    });
    const p = new PluginSearchProvider('p', 'P', transport, 1000);

    await expect(p.search({ q: 'hi' })).rejects.toMatchObject({ status: 503, message: 'backend down' });
    await expect(p.search({ q: 'hi' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('health maps healthy→ok and message→detail', async () => {
    const transport = fakeTransport({
      healthCheck: jest.fn().mockResolvedValue({ healthy: false, message: 'no index' }),
    });
    const p = new PluginSearchProvider('p', 'P', transport, 1000);

    await expect(p.health()).resolves.toEqual({ ok: false, detail: 'no index' });
  });

  it('health omits detail when the worker reports no message', async () => {
    const transport = fakeTransport({ healthCheck: jest.fn().mockResolvedValue({ healthy: true }) });
    const p = new PluginSearchProvider('p', 'P', transport, 1000);

    await expect(p.health()).resolves.toEqual({ ok: true });
  });
});
