import { BadRequestException, NotImplementedException } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import type { ApiKey } from '../auth/entities/api-key.entity';
import type { SearchResults } from './search.types';

describe('SearchController', () => {
  const search = jest.fn();
  const ctrl = new SearchController({ search } as unknown as SearchService);

  const ok = { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' } satisfies SearchResults;

  beforeEach(() => {
    search.mockReset();
  });

  it('throws 400 when q is empty', async () => {
    const dto: SearchQueryDto = { q: '' };
    await expect(ctrl.search(dto, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 400 when q is only whitespace', async () => {
    // @IsNotEmpty() on the DTO passes for '   ' (non-empty), so the controller's own trim guard is
    // what rejects whitespace-only q — this test pins that guard in place.
    const dto: SearchQueryDto = { q: '   ' };
    await expect(ctrl.search(dto, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(search).not.toHaveBeenCalled();
  });

  it('returns results and forwards the key allowedSessions as callerSessionIds', async () => {
    search.mockResolvedValue(ok);
    const apiKey = { allowedSessions: ['s1', 's2'] } as unknown as ApiKey;
    const dto: SearchQueryDto = { q: 'hello', limit: 5 };
    const res = await ctrl.search(dto, apiKey);
    expect(search).toHaveBeenCalledWith(dto, ['s1', 's2']);
    expect(res).toBe(ok);
  });

  it('passes undefined (no scope) for an unrestricted key (null allowedSessions)', async () => {
    search.mockResolvedValue(ok);
    // A null/empty allowlist (e.g. ADMIN) sees all sessions — mirrors GET /webhooks behavior.
    const apiKey = { allowedSessions: null } as unknown as ApiKey;
    const dto: SearchQueryDto = { q: 'hello' };
    await ctrl.search(dto, apiKey);
    expect(search).toHaveBeenCalledWith(dto, undefined);
  });

  it('derives callerSessionIds only from the key, never from the query (anti-smuggling)', async () => {
    search.mockResolvedValue(ok);
    // `sessionIds` is not a field on SearchQueryDto, so it cannot be expressed in the query at all;
    // the global ValidationPipe (forbidNonWhitelisted) would reject it, and SearchService clobbers
    // any sessionIds at the provider boundary. The controller itself derives scope solely from the
    // key — here there is no key → undefined.
    const dto: SearchQueryDto = { q: 'hello' };
    await ctrl.search(dto, undefined);
    expect(search).toHaveBeenCalledWith(dto, undefined);
  });

  it('propagates 501 (NotImplementedException) from the service when no provider is active', async () => {
    search.mockRejectedValue(new NotImplementedException('none'));
    await expect(ctrl.search({ q: 'x' }, undefined)).rejects.toBeInstanceOf(NotImplementedException);
  });
});
