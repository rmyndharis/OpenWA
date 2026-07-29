import { HttpException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { BullBoardAuthMiddleware } from './bull-board-auth.middleware';
import { AuthService } from '../../modules/auth/auth.service';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
import { AuditService } from '../../modules/audit/audit.service';
import { AuditAction } from '../../modules/audit/entities/audit-log.entity';
import { KeyRateLimiter } from '../../modules/mcp/mcp-rate-limit';

const res = {} as Response;

const reqFromIp = (ip: string, headers: Record<string, unknown> = {}): Request =>
  ({ headers, query: {}, ip, socket: { remoteAddress: ip } }) as unknown as Request;

describe('BullBoardAuthMiddleware', () => {
  let mw: BullBoardAuthMiddleware;
  let authService: { validateApiKey: jest.Mock; hasPermission: jest.Mock };
  let configService: { get: jest.Mock };

  const reqWith = (headers: Record<string, unknown> = {}, query: Record<string, unknown> = {}): Request =>
    ({ headers, query, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }) as unknown as Request;

  beforeEach(() => {
    authService = { validateApiKey: jest.fn(), hasPermission: jest.fn() };
    configService = { get: jest.fn().mockReturnValue(undefined) }; // no trusted proxies by default
    mw = new BullBoardAuthMiddleware(authService as unknown as AuthService, configService as unknown as ConfigService);
  });

  it('rejects when no API key is provided', async () => {
    const next = jest.fn();
    await mw.use(reqWith({}), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(authService.validateApiKey).not.toHaveBeenCalled();
  });

  it('propagates an invalid-key rejection', async () => {
    authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
    const next = jest.fn();
    await mw.use(reqWith({ 'x-api-key': 'bad' }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
  });

  it('forbids a valid non-admin key', async () => {
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.OPERATOR });
    authService.hasPermission.mockReturnValue(false);
    const next = jest.fn();
    await mw.use(reqWith({ 'x-api-key': 'op' }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenException));
  });

  it('allows a valid ADMIN key via X-API-Key', async () => {
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);
    const next = jest.fn();
    await mw.use(reqWith({ 'x-api-key': 'admin' }), res, next);
    expect(next).toHaveBeenCalledWith();
    expect(authService.validateApiKey).toHaveBeenCalledWith('admin', '127.0.0.1');
  });

  it('rejects an ADMIN key that is restricted to specific sessions', async () => {
    authService.validateApiKey.mockResolvedValue({
      id: 'key-1',
      name: 'scoped-admin',
      role: ApiKeyRole.ADMIN,
      allowedSessions: ['session-a'],
    });
    authService.hasPermission.mockReturnValue(true);

    const req = reqWith({ 'x-api-key': 'raw-key' });
    const next = jest.fn();

    await mw.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = (next.mock.calls as Array<Array<unknown>>)[0]?.[0];
    expect(forwarded).toBeInstanceOf(ForbiddenException);
    expect((forwarded as ForbiddenException).message).toContain('restricted');
  });

  it('admits an ADMIN key with an empty allowedSessions list', async () => {
    authService.validateApiKey.mockResolvedValue({
      id: 'key-2',
      name: 'unscoped-admin',
      role: ApiKeyRole.ADMIN,
      allowedSessions: [],
    });
    authService.hasPermission.mockReturnValue(true);

    const next = jest.fn();
    await mw.use(reqWith({ 'x-api-key': 'raw-key' }), res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('admits an ADMIN key with a null allowedSessions list', async () => {
    authService.validateApiKey.mockResolvedValue({
      id: 'key-3',
      name: 'null-scope-admin',
      role: ApiKeyRole.ADMIN,
      allowedSessions: null,
    });
    authService.hasPermission.mockReturnValue(true);

    const next = jest.fn();
    await mw.use(reqWith({ 'x-api-key': 'raw-key' }), res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('accepts a Bearer token', async () => {
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);

    await mw.use(reqWith({ authorization: 'Bearer abc' }), res, jest.fn());
    expect(authService.validateApiKey).toHaveBeenCalledWith('abc', '127.0.0.1');
  });

  it('honors X-Forwarded-For only behind a configured trusted proxy (allowedIps parity with the guard)', async () => {
    configService.get.mockReturnValue(['127.0.0.1']); // the socket peer is a trusted proxy
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);

    await mw.use(reqWith({ 'x-api-key': 'admin', 'x-forwarded-for': '203.0.113.5' }), res, jest.fn());

    expect(authService.validateApiKey).toHaveBeenCalledWith('admin', '203.0.113.5');
  });

  it('ignores a spoofed X-Forwarded-For when no trusted proxy is configured (uses the socket address)', async () => {
    configService.get.mockReturnValue([]); // no trusted proxies — XFF is attacker-controlled
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);

    await mw.use(reqWith({ 'x-api-key': 'admin', 'x-forwarded-for': '203.0.113.5' }), res, jest.fn());

    expect(authService.validateApiKey).toHaveBeenCalledWith('admin', '127.0.0.1');
  });

  it('rejects an ?apiKey query param (no key in the URL)', async () => {
    const next = jest.fn();
    await mw.use(reqWith({}, { apiKey: 'qkey' }), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(authService.validateApiKey).not.toHaveBeenCalled();
  });
});

// Bull Board is raw Express middleware (outside the Nest guard pipeline) and previously had no pre-auth
// throttle, so a flood of login attempts reached the validateApiKey DB lookup unbounded. The throttle
// mirrors MCP's createIpThrottle: a per-IP sliding window checked BEFORE the credential check.
describe('BullBoardAuthMiddleware pre-auth IP throttle (mirrors MCP createIpThrottle)', () => {
  let authService: { validateApiKey: jest.Mock; hasPermission: jest.Mock };
  let configService: { get: jest.Mock };
  const res = {} as Response;

  beforeEach(() => {
    authService = { validateApiKey: jest.fn(), hasPermission: jest.fn() };
    configService = { get: jest.fn().mockReturnValue(undefined) };
  });

  const adminMw = (ipLimit: number): BullBoardAuthMiddleware => {
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);
    return new BullBoardAuthMiddleware(
      authService as unknown as AuthService,
      configService as unknown as ConfigService,
      undefined, // no audit service needed for the throttle tests
      new KeyRateLimiter(ipLimit, 60_000),
    );
  };

  // Typed extractor for the first argument passed to a next() mock (avoids unsafe any member access).
  const firstNextArg = (mock: jest.Mock): unknown => (mock.mock.calls as Array<Array<unknown>>)[0]?.[0];

  it('N allowed, the (N+1)th from the same IP rejected with 429 (validateApiKey not reached)', async () => {
    const mw = adminMw(3);
    const headers = { 'x-api-key': 'admin' };

    // 3 allowed
    for (let i = 0; i < 3; i++) {
      const next = jest.fn();
      await mw.use(reqFromIp('198.51.100.4', headers), res, next);
      expect(next).toHaveBeenCalledWith(); // no error
    }
    expect(authService.validateApiKey).toHaveBeenCalledTimes(3);

    // 4th from the same IP → throttled before the credential check
    const next = jest.fn();
    await mw.use(reqFromIp('198.51.100.4', headers), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(HttpException));
    expect((firstNextArg(next) as HttpException).getStatus()).toBe(429);
    // The throttled request never reached the DB lookup
    expect(authService.validateApiKey).toHaveBeenCalledTimes(3);
  });

  it('a second IP has an independent bucket', async () => {
    const mw = adminMw(2);
    const headers = { 'x-api-key': 'admin' };

    // Exhaust the bucket for 198.51.100.4
    for (let i = 0; i < 2; i++) {
      await mw.use(reqFromIp('198.51.100.4', headers), res, jest.fn());
    }
    const throttledNext = jest.fn();
    await mw.use(reqFromIp('198.51.100.4', headers), res, throttledNext);
    expect(firstNextArg(throttledNext)).toBeInstanceOf(HttpException);

    // A different IP is unaffected
    const otherNext = jest.fn();
    await mw.use(reqFromIp('203.0.113.9', headers), res, otherNext);
    expect(otherNext).toHaveBeenCalledWith(); // allowed
    expect(authService.validateApiKey).toHaveBeenCalledWith('admin', '203.0.113.9');
  });

  it('a missing key still consumes a throttle slot (pre-auth gate fires first)', async () => {
    const mw = adminMw(1);
    // First request: no key → Unauthorized, but the throttle slot is consumed (check runs before extractKey).
    const next1 = jest.fn();
    await mw.use(reqFromIp('198.51.100.4', {}), res, next1);
    expect(firstNextArg(next1)).toBeInstanceOf(UnauthorizedException);

    // Second request WITH a valid key from the same IP → throttled (bucket already exhausted by #1)
    const next2 = jest.fn();
    await mw.use(reqFromIp('198.51.100.4', { 'x-api-key': 'admin' }), res, next2);
    expect(firstNextArg(next2)).toBeInstanceOf(HttpException);
    expect((firstNextArg(next2) as HttpException).getStatus()).toBe(429);
  });

  it('the default limiter (no injection) is generous — legit operator usage is never throttled', async () => {
    // Mirrors production wiring (main.ts constructs with 2 args → MCP IP-rate-limit policy, 120/60s).
    // A single legit admin request passes; the bucket is shared across all existing happy-path tests
    // (each uses a fresh middleware instance), proving the default is wired and non-blocking.
    const defaultMw = new BullBoardAuthMiddleware(
      authService as unknown as AuthService,
      configService as unknown as ConfigService,
    );
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.ADMIN });
    authService.hasPermission.mockReturnValue(true);
    const next = jest.fn();
    await defaultMw.use(reqFromIp('203.0.113.9', { 'x-api-key': 'admin' }), res, next);
    expect(next).toHaveBeenCalledWith(); // allowed
  });
});

// The Bull Board mount is raw Express, so the Nest guard's audit trail never sees it. The middleware
// now mirrors it at the boundary: 401/403 → WARN API_KEY_AUTH_FAILED; an authenticated non-GET/HEAD
// request → INFO QUEUE_BOARD_MUTATED. A throttled 429 is NOT audited — the pre-auth IP limiter is the
// flood bound for both the credential check and the audit table.
describe('BullBoardAuthMiddleware audit trail', () => {
  let mw: BullBoardAuthMiddleware;
  let authService: { validateApiKey: jest.Mock; hasPermission: jest.Mock };
  let auditService: { logWarn: jest.Mock; logInfo: jest.Mock };
  const res = {} as Response;

  const adminKey = { id: 'key-1', name: 'Admin', role: ApiKeyRole.ADMIN };

  const reqFor = (
    method: string,
    headers: Record<string, unknown> = {},
    originalUrl = '/api/admin/queues/api/queues/webhookQueue/1/retry',
  ): Request =>
    ({
      headers,
      query: {},
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      method,
      originalUrl,
      url: originalUrl,
    }) as unknown as Request;

  beforeEach(() => {
    authService = { validateApiKey: jest.fn(), hasPermission: jest.fn() };
    auditService = { logWarn: jest.fn(), logInfo: jest.fn() };
    const configService = { get: jest.fn().mockReturnValue(undefined) };
    mw = new BullBoardAuthMiddleware(
      authService as unknown as AuthService,
      configService as unknown as ConfigService,
      auditService as unknown as AuditService,
    );
  });

  it('audits a 401 (missing key) with IP, method and path', async () => {
    const next = jest.fn();
    await mw.use(reqFor('GET', {}, '/api/admin/queues/'), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({
        ipAddress: '127.0.0.1',
        method: 'GET',
        path: '/api/admin/queues/',
        errorMessage: 'API key is required to access the queue dashboard',
      }),
    );
  });

  it('audits a 401 (invalid key) rejection from validateApiKey', async () => {
    authService.validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
    const next = jest.fn();
    await mw.use(reqFor('GET', { 'x-api-key': 'bad' }, '/api/admin/queues/'), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ errorMessage: 'Invalid API key' }),
    );
  });

  it('audits a 403 (valid non-admin key)', async () => {
    authService.validateApiKey.mockResolvedValue({ role: ApiKeyRole.OPERATOR });
    authService.hasPermission.mockReturnValue(false);
    const next = jest.fn();
    await mw.use(reqFor('GET', { 'x-api-key': 'op' }, '/api/admin/queues/'), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenException));
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ errorMessage: 'Admin role required to access the queue dashboard' }),
    );
  });

  it('strips the query string from the audited path', async () => {
    const next = jest.fn();
    await mw.use(reqFor('GET', {}, '/api/admin/queues/?foo=bar'), res, next);

    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ path: '/api/admin/queues/' }),
    );
  });

  it('audits an authenticated non-GET request as a queue-board mutation with the actor key and method+path', async () => {
    authService.validateApiKey.mockResolvedValue(adminKey);
    authService.hasPermission.mockReturnValue(true);
    const next = jest.fn();
    await mw.use(reqFor('POST', { 'x-api-key': 'admin' }), res, next);

    expect(next).toHaveBeenCalledWith(); // allowed through
    expect(auditService.logInfo).toHaveBeenCalledWith(
      AuditAction.QUEUE_BOARD_MUTATED,
      expect.objectContaining({
        apiKey: adminKey,
        ipAddress: '127.0.0.1',
        method: 'POST',
        path: '/api/admin/queues/api/queues/webhookQueue/1/retry',
      }),
    );
    expect(auditService.logWarn).not.toHaveBeenCalled();
  });

  it('does not audit GET or HEAD requests (read/poll traffic)', async () => {
    authService.validateApiKey.mockResolvedValue(adminKey);
    authService.hasPermission.mockReturnValue(true);

    await mw.use(reqFor('GET', { 'x-api-key': 'admin' }, '/api/admin/queues/'), res, jest.fn());
    await mw.use(reqFor('HEAD', { 'x-api-key': 'admin' }, '/api/admin/queues/'), res, jest.fn());

    expect(auditService.logInfo).not.toHaveBeenCalled();
    expect(auditService.logWarn).not.toHaveBeenCalled();
  });

  it('does not audit a throttled 429 — the pre-auth IP limiter is the flood bound', async () => {
    const tightMw = new BullBoardAuthMiddleware(
      authService as unknown as AuthService,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      auditService as unknown as AuditService,
      new KeyRateLimiter(1, 60_000),
    );
    authService.validateApiKey.mockResolvedValue(adminKey);
    authService.hasPermission.mockReturnValue(true);

    await tightMw.use(reqFor('GET', { 'x-api-key': 'admin' }, '/api/admin/queues/'), res, jest.fn()); // consumes the slot
    const next = jest.fn();
    await tightMw.use(reqFor('GET', { 'x-api-key': 'admin' }, '/api/admin/queues/'), res, next); // throttled

    expect(next).toHaveBeenCalledWith(expect.any(HttpException));
    expect(auditService.logWarn).not.toHaveBeenCalled();
    expect(auditService.logInfo).not.toHaveBeenCalled();
  });

  it('degrades gracefully when no audit service is provided (rejections still work)', async () => {
    const noAuditMw = new BullBoardAuthMiddleware(
      authService as unknown as AuthService,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
    );
    const next = jest.fn();
    await noAuditMw.use(reqFor('GET', {}, '/api/admin/queues/'), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedException));
  });
});
