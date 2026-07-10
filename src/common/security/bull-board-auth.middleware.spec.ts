import { HttpException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { BullBoardAuthMiddleware } from './bull-board-auth.middleware';
import { AuthService } from '../../modules/auth/auth.service';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
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
