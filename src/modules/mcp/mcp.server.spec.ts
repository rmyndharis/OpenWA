import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { auditMcpAuthFailure, createIpThrottle, resolveMcpReadOnly } from './mcp.server';
import { KeyRateLimiter } from './mcp-rate-limit';
import { AuditAction } from '../audit/entities/audit-log.entity';

describe('resolveMcpReadOnly (secure-by-default MCP read-only flag)', () => {
  const prev = process.env.MCP_READONLY;
  afterEach(() => {
    if (prev === undefined) delete process.env.MCP_READONLY;
    else process.env.MCP_READONLY = prev;
  });

  it('defaults to read-only when MCP_READONLY is unset (write tools NOT exposed by default)', () => {
    delete process.env.MCP_READONLY;
    expect(resolveMcpReadOnly()).toBe(true);
  });

  it('exposes write tools only on an explicit MCP_READONLY=false opt-out', () => {
    process.env.MCP_READONLY = 'false';
    expect(resolveMcpReadOnly()).toBe(false);
  });

  it('stays read-only for any other value', () => {
    process.env.MCP_READONLY = 'true';
    expect(resolveMcpReadOnly()).toBe(true);
    process.env.MCP_READONLY = 'yes';
    expect(resolveMcpReadOnly()).toBe(true);
  });

  it('an explicit options.readOnly wins over the env', () => {
    process.env.MCP_READONLY = 'false';
    expect(resolveMcpReadOnly(true)).toBe(true);
    delete process.env.MCP_READONLY;
    expect(resolveMcpReadOnly(false)).toBe(false);
  });
});

// The MCP mount is raw Express (outside the Nest guard pipeline) and the per-key limiter only fires
// after key validation, so a missing/invalid-key flood would otherwise reach a DB lookup unthrottled.
// createIpThrottle gates by resolved client IP BEFORE auth and answers with a JSON-RPC 429.
describe('createIpThrottle (pre-auth per-IP MCP throttle)', () => {
  const makeReq = (ip: string): Request => ({ socket: { remoteAddress: ip }, headers: {} }) as unknown as Request;

  type ResMock = { status: jest.Mock; json: jest.Mock; statusCode?: number; body?: unknown };
  const makeRes = (): ResMock => {
    const res: ResMock = { status: jest.fn(), json: jest.fn() };
    res.status.mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json.mockImplementation((b: unknown) => {
      res.body = b;
      return res;
    });
    return res;
  };

  it('passes the first request from an IP and rejects the second with a 429', () => {
    const throttle = createIpThrottle(new KeyRateLimiter(1, 60_000));

    const next1 = jest.fn();
    throttle(makeReq('1.2.3.4'), makeRes() as unknown as Response, next1);
    expect(next1).toHaveBeenCalledWith(); // allowed through, no error

    const next2 = jest.fn();
    const res2 = makeRes();
    throttle(makeReq('1.2.3.4'), res2 as unknown as Response, next2);
    expect(next2).not.toHaveBeenCalled(); // short-circuited
    expect(res2.status).toHaveBeenCalledWith(429);
    expect((res2.body as { error?: { code?: number } }).error?.code).toBe(-32000);
  });

  it('buckets per IP — a different IP is not throttled', () => {
    const throttle = createIpThrottle(new KeyRateLimiter(1, 60_000));
    throttle(makeReq('1.1.1.1'), makeRes() as unknown as Response, jest.fn());

    const next = jest.fn();
    throttle(makeReq('2.2.2.2'), makeRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledWith();
  });
});

// MCP auth is raw Express (outside the Nest guard pipeline) so it bypasses the global ApiKeyGuard's
// auth-failure audit. auditMcpAuthFailure mirrors the REST guard: a WARN API_KEY_AUTH_FAILED record on
// a 401/403 only. Success and non-auth errors (bad input) must NOT be audited — parity with REST.
describe('auditMcpAuthFailure (MCP auth-failure audit trail, mirrors REST ApiKeyGuard)', () => {
  const reqContext = { ipAddress: '203.0.113.7', method: 'POST', path: '/mcp' };
  let auditService: { logWarn: jest.Mock };

  beforeEach(() => {
    auditService = { logWarn: jest.fn() };
  });

  it('writes a WARN API_KEY_AUTH_FAILED record on a missing/invalid key (UnauthorizedException)', () => {
    auditMcpAuthFailure(auditService, new UnauthorizedException('Missing API key'), reqContext);
    expect(auditService.logWarn).toHaveBeenCalledWith(AuditAction.API_KEY_AUTH_FAILED, {
      ipAddress: '203.0.113.7',
      method: 'POST',
      path: '/mcp',
      errorMessage: 'Missing API key',
    });
  });

  it('writes a record on a wrong-role rejection (ForbiddenException)', () => {
    auditMcpAuthFailure(auditService, new ForbiddenException('API key lacks the required role'), reqContext);
    expect(auditService.logWarn).toHaveBeenCalledTimes(1);
    const call = (auditService.logWarn.mock.calls as Array<[unknown, { errorMessage?: string }]>)[0];
    expect(call[1].errorMessage).toBe('API key lacks the required role');
  });

  it('mirrors the REST guard exactly: IP-not-allowed (Unauthorized) is audited', () => {
    // validateApiKey throws Unauthorized for IP-not-allowed / revoked / expired / session-not-allowed.
    auditMcpAuthFailure(auditService, new UnauthorizedException('IP address not allowed'), reqContext);
    expect(auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ errorMessage: 'IP address not allowed' }),
    );
  });

  it('does NOT audit a non-auth error (e.g. bad tool input — BadRequestException)', () => {
    auditMcpAuthFailure(auditService, new BadRequestException('sessionId is required for this tool'), reqContext);
    expect(auditService.logWarn).not.toHaveBeenCalled();
  });

  it('does nothing when auditService is unavailable (mount without DI)', () => {
    expect(() => auditMcpAuthFailure(undefined, new UnauthorizedException('x'), reqContext)).not.toThrow();
  });

  it('success path never reaches the catch (helper only invoked on thrown auth errors)', () => {
    // Structural: auditMcpAuthFailure is only called from the tool handler's catch block, so a
    // successful invokeTool returns a result without auditing. Assert the helper is a no-op on
    // a non-401/403 throw to confirm the success-equivalent (no auth failure) is not audited.
    auditMcpAuthFailure(auditService, new BadRequestException('not an auth failure'), reqContext);
    expect(auditService.logWarn).not.toHaveBeenCalled();
  });
});
