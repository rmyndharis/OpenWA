import { ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from './api-key.guard';
import { AuthService } from '../auth.service';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';

function createMockApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'uuid-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'owa_k1_xxxx',
    role: ApiKeyRole.OPERATOR,
    allowedIps: null,
    allowedSessions: null,
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
): ExecutionContext {
  const request = {
    headers,
    params,
    ip: socketIp,
    socket: { remoteAddress: socketIp },
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

  function buildGuard(trustedProxies: string[] = []): ApiKeyGuard {
    configService = {
      get: jest.fn().mockReturnValue(trustedProxies),
    };
    return new ApiKeyGuard(authService as AuthService, reflector, configService as ConfigService);
  }

  beforeEach(() => {
    authService = {
      validateApiKey: jest.fn(),
      hasPermission: jest.fn(),
    };

    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

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

  it('should reject when API key validation fails', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(false);

    (authService.validateApiKey as jest.Mock).mockRejectedValue(new UnauthorizedException('Invalid API key'));

    const context = createMockContext({ 'x-api-key': 'bad-key' });

    await expect(guard.canActivate(context)).rejects.toThrow('Invalid API key');
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
});
