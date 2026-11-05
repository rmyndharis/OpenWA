import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';
import { ChatScopeService } from '../chat-scope.service';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';
import { CHAT_SCOPED_KEY } from '../decorators/auth.decorators';
import * as chatScope from '../../../common/security/chat-scope';

// A chat-restricted key is fenced once per request: the allowlist it carries is the same for every chat id the
// request names, so compiling it again for each one only repeats work that grows with the allowlist.
describe('ApiKeyGuard chat fence cost', () => {
  const allowlist = Array.from({ length: 2000 }, (_, i) => `${628100000000 + i}@c.us`);
  const key: ApiKey = {
    id: 'k1',
    name: 'restricted',
    keyHash: 'h',
    keyPrefix: 'owa_k1_xxxxx',
    role: ApiKeyRole.OPERATOR,
    allowedIps: null,
    allowedSessions: null,
    allowedChats: allowlist,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function context(body: unknown): ExecutionContext {
    const request = {
      headers: { 'x-api-key': 'raw' },
      params: { sessionId: 's1' },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      body,
      query: {},
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  function newGuard(): ApiKeyGuard {
    return new ApiKeyGuard(
      { validateApiKey: jest.fn().mockResolvedValue(key), hasPermission: jest.fn().mockReturnValue(true) } as never,
      {
        getAllAndOverride: jest.fn((k: string) => (k === CHAT_SCOPED_KEY ? 'fenced' : undefined)),
      } as never as Reflector,
      { get: jest.fn().mockReturnValue([]) } as never as ConfigService,
      { logWarn: jest.fn() } as never,
      new ChatScopeService(),
    );
  }

  const bulk = (chatIds: string[]) => ({ messages: chatIds.map(chatId => ({ chatId, type: 'text', content: {} })) });

  afterEach(() => jest.restoreAllMocks());

  it('compiles the allowlist once for a bulk send that names many allowed chats', async () => {
    const compile = jest.spyOn(chatScope, 'buildChatScope');

    await expect(newGuard().canActivate(context(bulk(allowlist.slice(0, 100))))).resolves.toBe(true);

    // One request, one allowlist: 100 compilations of a 2000-entry list is what the request cost before.
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('compiles nothing for a request that names no chat', async () => {
    const compile = jest.spyOn(chatScope, 'buildChatScope');

    await expect(newGuard().canActivate(context({ text: 'hi' }))).resolves.toBe(true);

    expect(compile).not.toHaveBeenCalled();
  });

  it('still refuses a chat outside the allowlist, after the one compilation', async () => {
    const compile = jest.spyOn(chatScope, 'buildChatScope');
    const chats = [allowlist[0], '628999999999@c.us', allowlist[1]];

    await expect(newGuard().canActivate(context(bulk(chats)))).rejects.toThrow(
      new ForbiddenException('API key not authorized for this chat'),
    );

    expect(compile).toHaveBeenCalledTimes(1);
  });
});
