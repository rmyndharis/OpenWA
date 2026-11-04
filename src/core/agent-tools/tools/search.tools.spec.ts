import { BadRequestException, ForbiddenException, NotImplementedException } from '@nestjs/common';
import { ChatScopeService } from '../../../modules/auth/chat-scope.service';
import type { AuthService } from '../../../modules/auth/auth.service';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { SearchService } from '../../../modules/search/search.service';
import { invokeTool } from '../tool-invoker';
import { ContainsTermsRefusedError } from '../../../modules/search/search-terms';
import { searchTools } from './search.tools';

const CHAT = '628111000111@c.us';
const OTHER = '628222000222@c.us';
const results = { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' };

function authFor(key: object): AuthService {
  return {
    validateApiKey: jest.fn().mockResolvedValue(key),
    hasPermission: jest.fn().mockReturnValue(true),
  } as unknown as AuthService;
}

describe('MessageSearch tool', () => {
  const search = jest.fn().mockResolvedValue(results);
  const tool = searchTools({ search } as unknown as SearchService, true)[0];
  const call = (key: object, input: unknown) =>
    invokeTool(tool, input, 'key', authFor(key), undefined, undefined, new ChatScopeService());

  beforeEach(() => search.mockClear());

  it('forwards the query with the key session scope and no chat scope for an unrestricted key', async () => {
    const key = { id: 'k1', allowedSessions: ['s1'], allowedChats: null };
    const input = { q: 'invoice', match: 'word', from: '628111000111', direction: 'incoming', dateFrom: 1, limit: 10 };

    await expect(call(key, input)).resolves.toBe(results);

    expect(search).toHaveBeenCalledWith(input, ['s1'], undefined);
  });

  it('requires OPERATOR: a below-role key is refused before the search runs', async () => {
    expect(tool.requiredRole).toBe(ApiKeyRole.OPERATOR);

    const auth = authFor({ id: 'k1', allowedSessions: null, allowedChats: null });
    (auth.hasPermission as jest.Mock).mockReturnValue(false);
    await expect(
      invokeTool(tool, { q: 'invoice' }, 'key', auth, undefined, undefined, new ChatScopeService()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(search).not.toHaveBeenCalled();
  });

  it('searches every session with match=contains when the agent names neither', async () => {
    await call({ id: 'k1', allowedSessions: null, allowedChats: null }, { q: 'invoice' });

    expect(search).toHaveBeenCalledWith({ q: 'invoice', match: 'contains' }, undefined, undefined);
  });

  it('searches by word while the contains index is not ready, unless the agent asked for contains', async () => {
    const key = { id: 'k1', allowedSessions: null, allowedChats: null };
    search.mockRejectedValueOnce(new NotImplementedException('The contains index is still building'));

    await expect(call(key, { q: 'invoice' })).resolves.toBe(results);
    expect(search).toHaveBeenNthCalledWith(1, { q: 'invoice', match: 'contains' }, undefined, undefined);
    expect(search).toHaveBeenNthCalledWith(2, { q: 'invoice', match: 'word' }, undefined, undefined);

    search.mockClear();
    search.mockRejectedValueOnce(new NotImplementedException('The contains index is still building'));
    await expect(call(key, { q: 'invoice', match: 'contains' })).rejects.toBeInstanceOf(NotImplementedException);
    expect(search).toHaveBeenCalledTimes(1);

    // Only the 501 of an unready index and a refusal of the terms (below) fall back; any other failure
    // reaches the agent as it was.
    search.mockClear();
    search.mockRejectedValueOnce(new BadRequestException('Every term is under three characters'));
    await expect(call(key, { q: 'in' })).rejects.toBeInstanceOf(BadRequestException);
    expect(search).toHaveBeenCalledTimes(1);
  });

  // REST's default word mode answers `ok`, `東京` or a pasted sentence; contains refuses them for their terms.
  it.each([
    ['too short', 'ok', 'A contains search needs at least one term of 3 or more characters.'],
    ['too long', 'a'.repeat(65), 'The terms of a contains search may hold at most 64 characters together.'],
  ])('searches by word when contains refuses %s terms, unless the agent asked for contains', async (_n, q, refusal) => {
    const key = { id: 'k1', allowedSessions: null, allowedChats: null };
    search.mockRejectedValueOnce(new ContainsTermsRefusedError(refusal));

    await expect(call(key, { q })).resolves.toBe(results);
    expect(search).toHaveBeenNthCalledWith(1, { q, match: 'contains' }, undefined, undefined);
    expect(search).toHaveBeenNthCalledWith(2, { q, match: 'word' }, undefined, undefined);

    search.mockClear();
    search.mockRejectedValueOnce(new ContainsTermsRefusedError(refusal));
    await expect(call(key, { q, match: 'contains' })).rejects.toBeInstanceOf(BadRequestException);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('refuses a NUL character in the query before searching, which PostgreSQL would fail on', async () => {
    const key = { id: 'k1', allowedSessions: null, allowedChats: null };
    await expect(call(key, { q: `invoice${String.fromCharCode(0)}` })).rejects.toBeInstanceOf(BadRequestException);
    expect(search).not.toHaveBeenCalled();
  });

  it('bounds dateFrom and dateTo to the safe integer range, as REST does', async () => {
    const key = { id: 'k1', allowedSessions: null, allowedChats: null };

    await expect(call(key, { q: 'invoice', dateFrom: 1e22 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(call(key, { q: 'invoice', dateTo: -1e22 })).rejects.toBeInstanceOf(BadRequestException);
    expect(search).not.toHaveBeenCalled();

    await call(key, { q: 'invoice', dateFrom: -Number.MAX_SAFE_INTEGER, dateTo: Number.MAX_SAFE_INTEGER });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown match mode', async () => {
    await expect(call({ id: 'k1', allowedSessions: null }, { q: 'invoice', match: 'fuzzy' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a blank query before searching', async () => {
    await expect(call({ id: 'k1', allowedSessions: null }, { q: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(search).not.toHaveBeenCalled();
  });

  describe('for a key restricted to selected chats', () => {
    const key = { id: 'k2', allowedSessions: null, allowedChats: [CHAT] };

    it('requires a chatId', async () => {
      await expect(call(key, { q: 'invoice' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(search).not.toHaveBeenCalled();
    });

    it('refuses a chat outside the allowlist', async () => {
      await expect(call(key, { q: 'invoice', chatId: OTHER })).rejects.toBeInstanceOf(ForbiddenException);
      expect(search).not.toHaveBeenCalled();
    });

    it('passes the chat allowlist to the provider for an allowed chat', async () => {
      await call(key, { q: 'invoice', chatId: CHAT });

      expect(search).toHaveBeenCalledWith(
        { q: 'invoice', match: 'contains', chatId: CHAT },
        undefined,
        expect.arrayContaining([CHAT]),
      );
    });
  });

  describe('while SEARCH_CONTAINS_ENABLED is off', () => {
    const wordTool = searchTools({ search } as unknown as SearchService)[0];
    const callWord = (input: unknown) =>
      invokeTool(
        wordTool,
        input,
        'key',
        authFor({ id: 'k1', allowedSessions: null, allowedChats: null }),
        undefined,
        undefined,
        new ChatScopeService(),
      );

    it('defaults to match=word, as REST does', async () => {
      await callWord({ q: 'invoice' });

      expect(search).toHaveBeenCalledWith({ q: 'invoice', match: 'word' }, undefined, undefined);
      expect(wordTool.description).toContain('SEARCH_CONTAINS_ENABLED=true');
    });

    it('passes an explicit match=contains through and surfaces the 501 the provider answers', async () => {
      search.mockRejectedValueOnce(new NotImplementedException('Contains search is disabled'));

      await expect(callWord({ q: 'invoice', match: 'contains' })).rejects.toBeInstanceOf(NotImplementedException);
      expect(search).toHaveBeenCalledWith({ q: 'invoice', match: 'contains' }, undefined, undefined);
    });
  });

  it('answers 501 when the search module is disabled', async () => {
    const disabled = searchTools(undefined)[0];

    await expect(
      invokeTool(disabled, { q: 'invoice' }, 'key', authFor({ id: 'k1', allowedSessions: null })),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });
});
