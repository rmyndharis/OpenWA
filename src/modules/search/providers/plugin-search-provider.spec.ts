import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { MessageDirection } from '../../message/entities/message.entity';
import { PluginSearchProvider } from './plugin-search-provider';
import type { PluginSearchTransport } from './plugin-search-provider';
import type { SearchHit, SearchResults } from '../search.types';

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

  const mkHit = (overrides: Partial<SearchHit>): SearchHit => ({
    messageId: 'm',
    waMessageId: 'w',
    sessionId: 's1',
    chatId: 'c',
    body: 'hi',
    snippet: 'hi',
    timestamp: 1,
    type: 'text',
    direction: MessageDirection.OUTGOING,
    from: 'a@c.us',
    ...overrides,
  });

  it('strips hits whose sessionId is outside query.sessionIds (host-side re-filter)', async () => {
    // The plugin is trusted to honor sessionIds, but a bug/leak must not surface an out-of-scope hit.
    // Without the host-side filter the leaked hit would pass straight through to the caller.
    const inScope = mkHit({ messageId: 'm1', sessionId: 's1' });
    const leaked = mkHit({ messageId: 'm2', sessionId: 'sX' });
    const results: SearchResults = { hits: [inScope, leaked], total: 2, tookMs: 3, provider: 'plugin:p' };
    const dispatchSearch = jest.fn().mockResolvedValue({ ok: true, results });
    const p = new PluginSearchProvider('p', 'P', fakeTransport({ dispatchSearch }), 1000);

    const res = await p.search({ q: 'hi', sessionIds: ['s1'] });
    expect(res.hits.map(h => h.sessionId)).toEqual(['s1']);
    expect(res.total).toBe(1);
    expect(res.tookMs).toBe(3);
    expect(res.provider).toBe('plugin:p');
  });

  it('preserves the plugin total when all hits are in-scope (pagination must still work)', async () => {
    // A well-behaved plugin returns a full page of in-scope hits with the true total spanning more pages.
    // Overwriting total with the page hit count would make "Load More" (hits.length < total) never fire,
    // stranding every result past page 1 for a scoped key.
    const hits = [mkHit({ messageId: 'm1', sessionId: 's1' }), mkHit({ messageId: 'm2', sessionId: 's1' })];
    const results: SearchResults = { hits, total: 500, tookMs: 3, provider: 'plugin:p' };
    const dispatchSearch = jest.fn().mockResolvedValue({ ok: true, results });
    const p = new PluginSearchProvider('p', 'P', fakeTransport({ dispatchSearch }), 1000);

    const res = await p.search({ q: 'hi', sessionIds: ['s1'] });
    expect(res.hits.map(h => h.sessionId)).toEqual(['s1', 's1']);
    expect(res.total).toBe(500); // preserved — not overwritten to the page count (2)
  });

  it('does not re-filter when sessionIds is unset (admin / unrestricted key)', async () => {
    const h1 = mkHit({ messageId: 'm1', sessionId: 's1' });
    const h2 = mkHit({ messageId: 'm2', sessionId: 'sX' });
    const results: SearchResults = { hits: [h1, h2], total: 2, tookMs: 3, provider: 'plugin:p' };
    const dispatchSearch = jest.fn().mockResolvedValue({ ok: true, results });
    const p = new PluginSearchProvider('p', 'P', fakeTransport({ dispatchSearch }), 1000);

    const res = await p.search({ q: 'hi' });
    expect(res.hits.map(h => h.sessionId)).toEqual(['s1', 'sX']);
    expect(res.total).toBe(2);
  });

  it('treats an empty sessionIds array as unrestricted (parity with the built-in SQL scoping)', async () => {
    // The built-in provider only emits its `IN (...)` clause when sessionIds is set AND non-empty
    // (applyFilters: `q.sessionIds && q.sessionIds.length`); an empty array is a no-op there. The
    // host-side re-filter must match that exactly so swapping providers never changes results for the
    // same query — diverging here would itself be a bug.
    const h1 = mkHit({ messageId: 'm1', sessionId: 's1' });
    const h2 = mkHit({ messageId: 'm2', sessionId: 'sX' });
    const results: SearchResults = { hits: [h1, h2], total: 2, tookMs: 1, provider: 'plugin:p' };
    const dispatchSearch = jest.fn().mockResolvedValue({ ok: true, results });
    const p = new PluginSearchProvider('p', 'P', fakeTransport({ dispatchSearch }), 1000);

    const res = await p.search({ q: 'hi', sessionIds: [] });
    expect(res.hits.map(h => h.sessionId)).toEqual(['s1', 'sX']);
    expect(res.total).toBe(2);
  });

  describe('result shape validation (untrusted wire payload)', () => {
    const providerReturning = (results: unknown): PluginSearchProvider =>
      new PluginSearchProvider(
        'p',
        'P',
        fakeTransport({ dispatchSearch: jest.fn().mockResolvedValue({ ok: true, results }) }),
        1000,
      );

    it('rejects a fabricated negative total with a 502 — never a fabricated 200', async () => {
      await expect(
        providerReturning({ hits: [], total: -5, tookMs: 1, provider: 'plugin:p' }).search({ q: 'x' }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('rejects a non-numeric total (a string like "500" would silently break pagination)', async () => {
      await expect(
        providerReturning({ hits: [], total: '500', tookMs: 1, provider: 'plugin:p' }).search({ q: 'x' }),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('rejects non-array hits with a 502 instead of crashing the re-filter into a 500', async () => {
      await expect(
        providerReturning({ hits: 'nope', total: 0, tookMs: 1, provider: 'plugin:p' }).search({
          q: 'x',
          sessionIds: ['s1'],
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('rejects a hit missing required SearchHit fields', async () => {
      await expect(
        providerReturning({ hits: [{ messageId: 'm1' }], total: 1, tookMs: 1, provider: 'plugin:p' }).search({
          q: 'x',
        }),
      ).rejects.toMatchObject({ status: 502 });
    });

    it('rejects a non-object results payload', async () => {
      await expect(providerReturning(null).search({ q: 'x' })).rejects.toBeInstanceOf(BadGatewayException);
      await expect(providerReturning('garbage').search({ q: 'x' })).rejects.toBeInstanceOf(BadGatewayException);
      await expect(providerReturning([1, 2]).search({ q: 'x' })).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('passes a valid payload with extra fields through untouched (a legit provider never breaks)', async () => {
      const results = {
        hits: [{ ...mkHit({}), extraField: { nested: true } }],
        total: 1,
        tookMs: 2,
        provider: 'plugin:p',
        cursor: 'next-page',
      };
      await expect(providerReturning(results).search({ q: 'x' })).resolves.toBe(results);
    });
  });
});
