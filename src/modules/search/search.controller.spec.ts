import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import type { ApiKey } from '../auth/entities/api-key.entity';
import type { SearchQuery, SearchResults } from './search.types';

describe('SearchController', () => {
  const search = jest.fn();
  const ctrl = new SearchController({ search } as unknown as SearchService);

  const ok = { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' } satisfies SearchResults;

  beforeEach(() => {
    search.mockReset();
  });

  it('throws 400 when q is empty', async () => {
    await expect(ctrl.search({ q: '' }, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 400 when q is only whitespace', async () => {
    await expect(ctrl.search({ q: '   ' }, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(search).not.toHaveBeenCalled();
  });

  it('returns results and forwards the key allowedSessions as callerSessionIds', async () => {
    search.mockResolvedValue(ok);
    const apiKey = { allowedSessions: ['s1', 's2'] } as unknown as ApiKey;
    const query: SearchQuery = { q: 'hello', limit: 5 };
    const res = await ctrl.search(query, apiKey);
    expect(search).toHaveBeenCalledWith(query, ['s1', 's2']);
    expect(res).toBe(ok);
  });

  it('passes undefined (no scope) for an unrestricted key (null allowedSessions)', async () => {
    search.mockResolvedValue(ok);
    // A null/empty allowlist (e.g. ADMIN) sees all sessions — mirrors GET /webhooks behavior.
    const apiKey = { allowedSessions: null } as unknown as ApiKey;
    const query: SearchQuery = { q: 'hello' };
    await ctrl.search(query, apiKey);
    expect(search).toHaveBeenCalledWith(query, undefined);
  });

  it('derives callerSessionIds only from the key, never from the query body (anti-smuggling)', async () => {
    search.mockResolvedValue(ok);
    // A caller tries to spoof scope via the query — the controller must ignore it and pass the key's
    // allowlist (here: no key → undefined) as the sole scope source. SearchService additionally
    // clobbers any query.sessionIds at the provider boundary.
    const query: SearchQuery = { q: 'hello', sessionIds: ['sneaky'] };
    await ctrl.search(query, undefined);
    expect(search).toHaveBeenCalledWith(query, undefined);
  });

  it('propagates 501 (NotImplementedException) from the service when no provider is active', async () => {
    search.mockRejectedValue(new NotImplementedException('none'));
    await expect(ctrl.search({ q: 'x' }, undefined)).rejects.toBeInstanceOf(NotImplementedException);
  });
});
