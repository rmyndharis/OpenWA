import { ExecutionContext, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { runWithRequestId, getRequestActor } from '../../../common/services/request-context';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';
import { AuthService, UnresolvedApiKeyException } from '../auth.service';
import { ChatScopeService } from '../chat-scope.service';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/entities/audit-log.entity';
import { CHAT_QUOTED_ALLOWED_KEY, CHAT_SCOPED_KEY, REQUIRED_ROLE_KEY } from '../decorators/auth.decorators';

function createMockApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'uuid-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'owa_k1_xxxx',
    role: ApiKeyRole.OPERATOR,
    allowedIps: null,
    allowedSessions: null,
    allowedChats: null,
    isActive: true,
    expiresAt: null,
    lastUsedAt: null,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockContext(
  headers: Record<string, string> = {},
  params: Record<string, string> = {},
  socketIp = '127.0.0.1',
  body?: unknown,
  query: Record<string, unknown> = {},
): ExecutionContext {
  const request = {
    headers,
    params,
    ip: socketIp,
    socket: { remoteAddress: socketIp },
    body,
    query,
  };

  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let authService: jest.Mocked<Partial<AuthService>>;
  let reflector: jest.Mocked<Reflector>;
  let configService: jest.Mocked<Partial<ConfigService>>;
  let auditService: jest.Mocked<Partial<AuditService>>;
  /** Per-call metadata the guard reads via Reflector; tests set only what they need. */
  let metadata: Record<string, unknown>;

  function buildGuard(trustedProxies: string[] = []): ApiKeyGuard {
    configService = {
      get: jest.fn().mockReturnValue(trustedProxies),
    };
    return new ApiKeyGuard(
      authService as AuthService,
      reflector,
      configService as ConfigService,
      auditService as AuditService,
      new ChatScopeService(),
    );
  }

  beforeEach(() => {
    authService = {
      validateApiKey: jest.fn(),
      hasPermission: jest.fn(),
    };

    metadata = {};
    reflector = {
      getAllAndOverride: jest.fn((key: string) => metadata[key]),
    } as unknown as jest.Mocked<Reflector>;

    auditService = {
      logWarn: jest.fn().mockResolvedValue(null),
    };

    guard = buildGuard();
  });

  it('should allow access to @Public() routes without API key', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true); // isPublic = true

    const context = createMockContext();
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.validateApiKey).not.toHaveBeenCalled();
  });

  it('should reject requests without X-API-Key header', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false); // not public

    const context = createMockContext({});

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toThrow('API key is required');
  });

  it('should accept X-API-Key header', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(undefined); // no required role

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({ 'x-api-key': 'my-key' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.validateApiKey).toHaveBeenCalledWith('my-key', '127.0.0.1', undefined);
  });

  it('should accept Authorization Bearer header', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({ authorization: 'Bearer my-bearer-key' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.validateApiKey).toHaveBeenCalledWith('my-bearer-key', '127.0.0.1', undefined);
  });

  // RFC 7235 section 2.1: the auth scheme is case-insensitive; MCP and metrics already read it so.
  it.each(['bearer my-bearer-key', 'BEARER   my-bearer-key'])('accepts the scheme in any case: %j', async header => {
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
    (authService.validateApiKey as jest.Mock).mockResolvedValue(createMockApiKey());

    const result = await guard.canActivate(createMockContext({ authorization: header }));

    expect(result).toBe(true);
    expect(authService.validateApiKey).toHaveBeenCalledWith('my-bearer-key', '127.0.0.1', undefined);
  });

  it('should reject when API key validation fails', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false);

    (authService.validateApiKey as jest.Mock).mockRejectedValue(new UnauthorizedException('Invalid API key'));

    const context = createMockContext({ 'x-api-key': 'bad-key' });

    await expect(guard.canActivate(context)).rejects.toThrow('Invalid API key');
  });

  it('records an API_KEY_AUTH_FAILED audit event when a key is rejected (with ip + reason)', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false); // not public
    (authService.validateApiKey as jest.Mock).mockRejectedValue(new UnauthorizedException('Invalid API key'));

    const context = createMockContext({ 'x-api-key': 'bad-key' }, {}, '203.0.113.9');
    await expect(guard.canActivate(context)).rejects.toThrow('Invalid API key');
    await new Promise(resolve => setImmediate(resolve)); // let the fire-and-forget audit write settle

    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ ipAddress: '203.0.113.9', errorMessage: 'Invalid API key' }),
    );
  });

  it('records an audit event when a missing key is rejected', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false);

    const context = createMockContext({}); // no key
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await new Promise(resolve => setImmediate(resolve));

    expect(auditService.logWarn).toHaveBeenCalledWith(AuditAction.API_KEY_AUTH_FAILED, expect.any(Object));
  });

  // A request with no key costs the caller nothing, and the throttler counts per route handler, so
  // the unauthenticated audit rows are bounded per client IP. These tests use IPs no other test in
  // this file uses: the budget is a module-level singleton shared with the Bull Board mount.
  describe('unauthenticated audit rows are bounded per client IP', () => {
    const settle = () => new Promise(resolve => setImmediate(resolve));

    it('writes at most 10 rows a minute for one IP, while every request still gets its 401', async () => {
      let rejected = 0;
      for (let i = 0; i < 50; i++) {
        await guard.canActivate(createMockContext({}, {}, '198.51.100.71')).catch(err => {
          if (err instanceof UnauthorizedException) rejected++;
        });
      }
      await settle();

      expect(rejected).toBe(50);
      expect(auditService.logWarn).toHaveBeenCalledTimes(10);

      // A different client keeps its own budget.
      await expect(guard.canActivate(createMockContext({}, {}, '198.51.100.72'))).rejects.toThrow(
        UnauthorizedException,
      );
      await settle();
      expect(auditService.logWarn).toHaveBeenCalledTimes(11);
      expect(auditService.logWarn).toHaveBeenLastCalledWith(
        AuditAction.API_KEY_AUTH_FAILED,
        expect.objectContaining({ ipAddress: '198.51.100.72' }),
      );
    });

    it('still records every 403 from an IP whose 401 budget is spent', async () => {
      for (let i = 0; i < 11; i++) {
        await guard.canActivate(createMockContext({}, {}, '198.51.100.73')).catch(() => undefined);
      }
      await settle();
      expect(auditService.logWarn).toHaveBeenCalledTimes(10);

      metadata[REQUIRED_ROLE_KEY] = ApiKeyRole.ADMIN;
      (authService.validateApiKey as jest.Mock).mockResolvedValue(createMockApiKey({ role: ApiKeyRole.VIEWER }));
      (authService.hasPermission as jest.Mock).mockReturnValue(false);
      for (let i = 0; i < 3; i++) {
        await expect(
          guard.canActivate(createMockContext({ 'x-api-key': 'viewer-key' }, {}, '198.51.100.73')),
        ).rejects.toThrow(ForbiddenException);
      }
      await settle();
      expect(auditService.logWarn).toHaveBeenCalledTimes(13);
    });

    it('still records a rejected stored key from an IP whose budget is spent, but not an unknown one', async () => {
      for (let i = 0; i < 11; i++) {
        await guard.canActivate(createMockContext({}, {}, '198.51.100.74')).catch(() => undefined);
      }
      await settle();
      expect(auditService.logWarn).toHaveBeenCalledTimes(10);

      (authService.validateApiKey as jest.Mock).mockRejectedValue(new UnresolvedApiKeyException('Invalid API key'));
      await expect(
        guard.canActivate(createMockContext({ 'x-api-key': 'unknown' }, {}, '198.51.100.74')),
      ).rejects.toThrow(UnauthorizedException);
      await settle();
      expect(auditService.logWarn).toHaveBeenCalledTimes(10);

      for (const err of [
        new UnauthorizedException('API key is revoked'),
        new UnauthorizedException('API key has expired'),
        new ForbiddenException('API key not authorized for this session'),
      ]) {
        (authService.validateApiKey as jest.Mock).mockRejectedValue(err);
        await expect(guard.canActivate(createMockContext({ 'x-api-key': 'stored' }, {}, '198.51.100.74'))).rejects.toBe(
          err,
        );
      }
      await settle();
      expect(auditService.logWarn).toHaveBeenCalledTimes(13);
      expect(auditService.logWarn).toHaveBeenLastCalledWith(
        AuditAction.API_KEY_AUTH_FAILED,
        expect.objectContaining({
          ipAddress: '198.51.100.74',
          errorMessage: 'API key not authorized for this session',
        }),
      );
    });
  });

  it('does not record an audit event on a successful authorization', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
    (authService.validateApiKey as jest.Mock).mockResolvedValue(createMockApiKey());

    const context = createMockContext({ 'x-api-key': 'good-key' });
    await guard.canActivate(context);
    await new Promise(resolve => setImmediate(resolve));

    expect(auditService.logWarn).not.toHaveBeenCalled();
  });

  it('should reject when role permission is insufficient', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(ApiKeyRole.ADMIN); // required role = ADMIN

    const apiKey = createMockApiKey({ role: ApiKeyRole.VIEWER });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    (authService.hasPermission as jest.Mock).mockReturnValue(false);

    const context = createMockContext({ 'x-api-key': 'viewer-key' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('rejects a session-scoped key on a @RequireUnscopedKey route, whatever its role', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(ApiKeyRole.ADMIN) // required role = ADMIN
      .mockReturnValueOnce(undefined) // not @SessionScoped
      .mockReturnValueOnce(true); // @RequireUnscopedKey

    const apiKey = createMockApiKey({ role: ApiKeyRole.ADMIN, allowedSessions: ['sess-A'] });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    (authService.hasPermission as jest.Mock).mockReturnValue(true);

    const context = createMockContext({ 'x-api-key': 'scoped-admin-key' }, {}, '203.0.113.44');

    await expect(guard.canActivate(context)).rejects.toThrow('Session-scoped API keys are not permitted on this route');
    await new Promise(resolve => setImmediate(resolve)); // let the fire-and-forget audit write settle
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ ipAddress: '203.0.113.44' }),
    );
  });

  // Both post-authentication denials threw BEFORE the actor was stamped, so every 403 the guard
  // raises wrote an audit row whose apiKeyId/apiKeyName were null — attributable to an IP that,
  // behind NAT or a proxy without TRUSTED_PROXIES, is common to every tenant. The operator could
  // see that a key was denied but not WHICH key, so could not revoke it.
  describe('a post-authentication denial is attributable to the credential', () => {
    const actorAfterDenial = async (setupReflector: () => void, apiKey: ReturnType<typeof createMockApiKey>) => {
      setupReflector();
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
      const context = createMockContext({ 'x-api-key': 'k' }, {}, '203.0.113.44');
      let actor: ReturnType<typeof getRequestActor>;
      await runWithRequestId('req-1', async () => {
        await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
        actor = getRequestActor();
      });
      return actor;
    };

    it('stamps the key on an insufficient-role denial', async () => {
      const apiKey = createMockApiKey({ id: 'key-uuid-1', name: 'Reporting key', role: ApiKeyRole.VIEWER });
      (authService.hasPermission as jest.Mock).mockReturnValue(false);

      const actor = await actorAfterDenial(() => {
        reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(ApiKeyRole.ADMIN);
      }, apiKey);

      expect(actor).toMatchObject({ apiKeyId: 'key-uuid-1', apiKeyName: 'Reporting key', ipAddress: '203.0.113.44' });
    });

    it('stamps the key on a session-scoped-key denial', async () => {
      const apiKey = createMockApiKey({ id: 'key-uuid-2', name: 'Tenant A', allowedSessions: ['sess-A'] });
      (authService.hasPermission as jest.Mock).mockReturnValue(true);

      const actor = await actorAfterDenial(() => {
        reflector.getAllAndOverride
          .mockReturnValueOnce(false)
          .mockReturnValueOnce(ApiKeyRole.ADMIN)
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce(true);
      }, apiKey);

      expect(actor).toMatchObject({ apiKeyId: 'key-uuid-2', apiKeyName: 'Tenant A' });
    });

    // Negative twin: a denial BEFORE the key resolves still has no key to name, and must not
    // invent one — the IP is genuinely all there is.
    it('leaves an unauthenticated denial attributable to the IP alone', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      (authService.validateApiKey as jest.Mock).mockRejectedValue(new UnauthorizedException('bad key'));
      const context = createMockContext({ 'x-api-key': 'nope' }, {}, '203.0.113.44');

      let actor: ReturnType<typeof getRequestActor>;
      await runWithRequestId('req-2', async () => {
        await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
        actor = getRequestActor();
      });

      expect(actor?.apiKeyId).toBeUndefined();
      expect(actor?.ipAddress).toBe('203.0.113.44');
    });
  });

  it('admits an unrestricted key on a @RequireUnscopedKey route', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(ApiKeyRole.ADMIN) // required role = ADMIN
      .mockReturnValueOnce(undefined) // not @SessionScoped
      .mockReturnValueOnce(true); // @RequireUnscopedKey

    const apiKey = createMockApiKey({ role: ApiKeyRole.ADMIN, allowedSessions: null });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
    (authService.hasPermission as jest.Mock).mockReturnValue(true);

    const context = createMockContext({ 'x-api-key': 'admin-key' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('admits a session-scoped key on routes WITHOUT the @RequireUnscopedKey marker', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(undefined) // no required role
      .mockReturnValueOnce(undefined) // not @SessionScoped
      .mockReturnValueOnce(undefined); // not @RequireUnscopedKey

    const apiKey = createMockApiKey({ allowedSessions: ['sess-A'] });
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({ 'x-api-key': 'scoped-key' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('should pass session ID from route params to validateApiKey', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({ 'x-api-key': 'key' }, { sessionId: 'sess-123' });
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '127.0.0.1', 'sess-123');
  });

  it('does not treat a non-session route :id as a session id (no @SessionScoped)', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(undefined) // no required role
      .mockReturnValueOnce(undefined); // controller is NOT @SessionScoped

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    // e.g. GET /plugins/:id or /auth/api-keys/:id — :id is a plugin/key id, not a session.
    const context = createMockContext({ 'x-api-key': 'key' }, { id: 'plugin-x' });
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '127.0.0.1', undefined);
  });

  it('treats :id as the session id on a @SessionScoped controller (session scoping preserved)', async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // not public
      .mockReturnValueOnce(undefined) // no required role
      .mockReturnValueOnce(true); // controller IS @SessionScoped (SessionController)

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    // GET /sessions/:id/... — :id IS the session, so allowedSessions must still be enforced.
    const context = createMockContext({ 'x-api-key': 'key' }, { id: 'sess-B' });
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '127.0.0.1', 'sess-B');
  });

  it('ignores X-Forwarded-For by default (no trusted proxies) to prevent IP spoofing', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    // Attacker forges X-Forwarded-For; the direct socket IP must win.
    const context = createMockContext({
      'x-api-key': 'key',
      'x-forwarded-for': '203.0.113.50, 70.41.3.18',
    });
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '127.0.0.1', undefined);
  });

  it('uses the rightmost untrusted hop when the request comes from a trusted proxy', async () => {
    guard = buildGuard(['10.0.0.0/8']);
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    // Direct peer 10.0.0.1 is a trusted proxy; XFF = [real client, inner proxy].
    const context = createMockContext(
      { 'x-api-key': 'key', 'x-forwarded-for': '203.0.113.50, 10.0.0.5' },
      {},
      '10.0.0.1',
    );
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '203.0.113.50', undefined);
  });

  it('ignores X-Forwarded-For when the direct peer is not a trusted proxy', async () => {
    guard = buildGuard(['10.0.0.0/8']);
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    // Attacker connects directly (203.0.113.99) and forges a trusted-looking XFF.
    const context = createMockContext({ 'x-api-key': 'key', 'x-forwarded-for': '10.0.0.5' }, {}, '203.0.113.99');
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '203.0.113.99', undefined);
  });

  it('normalizes an IPv4-mapped IPv6 proxy address (e.g. ::ffff:10.0.0.1)', async () => {
    guard = buildGuard(['10.0.0.0/8']);
    reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);

    const apiKey = createMockApiKey();
    (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

    const context = createMockContext({ 'x-api-key': 'key', 'x-forwarded-for': '203.0.113.50' }, {}, '::ffff:10.0.0.1');
    await guard.canActivate(context);

    expect(authService.validateApiKey).toHaveBeenCalledWith('key', '203.0.113.50', undefined);
  });

  describe('chat scope enforcement', () => {
    // The guard is default deny for a chat-restricted key: the handler must be marked @ChatScoped
    // to be reachable at all. These tests are about the membership fence, so mark the route.
    beforeEach(() => {
      metadata[CHAT_SCOPED_KEY] = 'fenced';
    });

    const ALLOWED_GROUP = '120363000000000000@g.us';
    const FORBIDDEN_GROUP = '120363999999999999@g.us';
    const ALLOWED_CONTACT = '919999999999@c.us';
    const FORBIDDEN_CONTACT = '918888888888@c.us';

    it('rejects a route param chat outside allowedChats with 403', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, { chatId: FORBIDDEN_GROUP });
      await expect(guard.canActivate(context)).rejects.toThrow(
        new ForbiddenException('API key not authorized for this chat'),
      );
    });

    it('admits a route param chat inside allowedChats', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, { chatId: ALLOWED_GROUP });
      expect(await guard.canActivate(context)).toBe(true);
    });

    it('rejects a single-send body.chatId outside allowedChats with 403', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        chatId: FORBIDDEN_GROUP,
        text: 'hi',
      });
      await expect(guard.canActivate(context)).rejects.toThrow(
        new ForbiddenException('API key not authorized for this chat'),
      );
    });

    it('admits a single-send body.chatId inside allowedChats', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        chatId: ALLOWED_GROUP,
        text: 'hi',
      });
      expect(await guard.canActivate(context)).toBe(true);
    });

    it('rejects message forward when fromChatId is outside allowedChats with 403', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP, ALLOWED_CONTACT] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        fromChatId: FORBIDDEN_GROUP,
        toChatId: ALLOWED_CONTACT,
        messageId: 'm1',
      });
      await expect(guard.canActivate(context)).rejects.toThrow(
        new ForbiddenException('API key not authorized for this chat'),
      );
    });

    it('rejects message forward when toChatId is outside allowedChats with 403', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP, ALLOWED_CONTACT] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        fromChatId: ALLOWED_GROUP,
        toChatId: FORBIDDEN_CONTACT,
        messageId: 'm1',
      });
      await expect(guard.canActivate(context)).rejects.toThrow(
        new ForbiddenException('API key not authorized for this chat'),
      );
    });

    it('admits message forward when both fromChatId and toChatId are inside allowedChats', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP, ALLOWED_CONTACT] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        fromChatId: ALLOWED_GROUP,
        toChatId: ALLOWED_CONTACT,
        messageId: 'm1',
      });
      expect(await guard.canActivate(context)).toBe(true);
    });

    it('rejects bulk send when any message recipient is outside allowedChats with 403', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        messages: [
          { chatId: ALLOWED_GROUP, type: 'text', content: { text: 'one' } },
          { chatId: FORBIDDEN_CONTACT, type: 'text', content: { text: 'two' } },
        ],
      });
      await expect(guard.canActivate(context)).rejects.toThrow(
        new ForbiddenException('API key not authorized for this chat'),
      );
    });

    it('admits bulk send when every message recipient is inside allowedChats', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP, ALLOWED_CONTACT] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        messages: [
          { chatId: ALLOWED_GROUP, type: 'text', content: { text: 'one' } },
          { chatId: ALLOWED_CONTACT, type: 'text', content: { text: 'two' } },
        ],
      });
      expect(await guard.canActivate(context)).toBe(true);
    });

    it('fences a :groupId path param', async () => {
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const denied = createMockContext({ 'x-api-key': 'key' }, { groupId: FORBIDDEN_GROUP });
      await expect(guard.canActivate(denied)).rejects.toThrow(
        new ForbiddenException('API key not authorized for this chat'),
      );

      const allowed = createMockContext({ 'x-api-key': 'key' }, { groupId: ALLOWED_GROUP });
      expect(await guard.canActivate(allowed)).toBe(true);
    });

    it('fences a :contactId path param', async () => {
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_CONTACT] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const denied = createMockContext({ 'x-api-key': 'key' }, { contactId: FORBIDDEN_CONTACT });
      await expect(guard.canActivate(denied)).rejects.toThrow(
        new ForbiddenException('API key not authorized for this chat'),
      );

      const allowed = createMockContext({ 'x-api-key': 'key' }, { contactId: ALLOWED_CONTACT });
      expect(await guard.canActivate(allowed)).toBe(true);
    });

    it('admits a quotedMessageId on a route marked @ChatQuotedAllowed (the reply route)', async () => {
      metadata[CHAT_QUOTED_ALLOWED_KEY] = true;
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      // Both engines bind the reply's quote to the named chat, so it cannot reach another one.
      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        chatId: ALLOWED_GROUP,
        quotedMessageId: 'm-in-this-chat',
      });
      expect(await guard.canActivate(context)).toBe(true);
    });

    it('expands each distinct bulk recipient once, however often it repeats', async () => {
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP, ALLOWED_CONTACT] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);
      const allows = jest.spyOn(ChatScopeService.prototype, 'allows');
      try {
        const messages = Array.from({ length: 100 }, (_, i) => ({
          chatId: i % 2 ? ALLOWED_GROUP : ALLOWED_CONTACT,
          type: 'text',
        }));
        const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', { messages });
        expect(await guard.canActivate(context)).toBe(true);
        expect(allows).toHaveBeenCalledTimes(2);
      } finally {
        allows.mockRestore();
      }
    });

    it('rejects an oversized bulk body before any per-entry lookup', async () => {
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const messages = Array.from({ length: 101 }, () => ({ chatId: ALLOWED_GROUP, type: 'text' }));
      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', { messages });
      await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
    });

    it('refuses a quotedMessageId — a chat reference the guard cannot fence', async () => {
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      // The chat is allowed, but the quote resolves from the global store and could be a message
      // from a chat outside the allowlist.
      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        chatId: ALLOWED_GROUP,
        quotedMessageId: 'm-from-elsewhere',
      });
      await expect(guard.canActivate(context)).rejects.toThrow(
        new ForbiddenException('API key is restricted to selected chats'),
      );
    });

    it('refuses a chat-restricted key on a route that is not marked @ChatScoped', async () => {
      delete metadata[CHAT_SCOPED_KEY];
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {});
      await expect(guard.canActivate(context)).rejects.toThrow(
        new ForbiddenException('API key is restricted to selected chats'),
      );
    });

    it('fences ?chatId= on the query string', async () => {
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const denied = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', undefined, { chatId: FORBIDDEN_GROUP });
      await expect(guard.canActivate(denied)).rejects.toThrow(
        new ForbiddenException('API key not authorized for this chat'),
      );

      const allowed = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', undefined, { chatId: ALLOWED_GROUP });
      expect(await guard.canActivate(allowed)).toBe(true);
    });

    it('rejects a present but non-string chat field instead of skipping it', async () => {
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      // The global ValidationPipe coerces with enableImplicitConversion, so a numeric chatId would
      // reach the handler as a string the fence never checked — refuse it here.
      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', { chatId: 120363 });
      await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
    });

    it('rejects a bulk `messages` field that is present but not an array', async () => {
      const apiKey = createMockApiKey({ allowedChats: [ALLOWED_GROUP] });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const context = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', { messages: 'nope' });
      await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
    });

    it('admits forward and bulk send for an unrestricted key (allowedChats null)', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const apiKey = createMockApiKey({ allowedChats: null });
      (authService.validateApiKey as jest.Mock).mockResolvedValue(apiKey);

      const forwardContext = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        fromChatId: FORBIDDEN_GROUP,
        toChatId: FORBIDDEN_CONTACT,
        messageId: 'm1',
      });
      expect(await guard.canActivate(forwardContext)).toBe(true);

      reflector.getAllAndOverride.mockReturnValueOnce(false).mockReturnValueOnce(undefined);
      const bulkContext = createMockContext({ 'x-api-key': 'key' }, {}, '127.0.0.1', {
        messages: [{ chatId: FORBIDDEN_CONTACT, type: 'text', content: { text: 'unrestricted' } }],
      });
      expect(await guard.canActivate(bulkContext)).toBe(true);
    });
  });
});
