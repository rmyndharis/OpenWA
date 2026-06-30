import type { Request, Response } from 'express';
import { createIpThrottle } from './mcp.server';
import { KeyRateLimiter } from './mcp-rate-limit';

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
