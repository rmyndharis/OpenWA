import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { auditMcpAuthFailure, createIpThrottle, mountMcpServer, resolveMcpReadOnly } from './mcp.server';
import { KeyRateLimiter } from './mcp-rate-limit';
import { AuditAction } from '../audit/entities/audit-log.entity';
import type { AnyToolDescriptor } from '../../core/agent-tools/tool-descriptor';
import type { ToolRegistryService } from '../../core/agent-tools/tool-registry.service';
import type { AuthService } from '../auth/auth.service';
import type { AuditService } from '../audit/audit.service';

// The request-handling path news up an McpServer + StreamableHTTPServerTransport per POST. Both SDK
// classes are mocked so tests can observe the per-request transport (handleRequest args) and invoke
// the registered tool callbacks exactly as the SDK would — no sockets, no MCP protocol traffic.
// The closures dereference the mock handles lazily, so the factories stay valid before module init.
type ToolCallback = (input: Record<string, unknown>, extra: unknown) => Promise<unknown>;
const mockRegisteredTools: Array<{ name: string; callback: ToolCallback }> = [];
const mockServerConnect = jest.fn<Promise<void>, unknown[]>();
const mockServerClose = jest.fn<Promise<void>, unknown[]>();
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    registerTool: (
      name: string,
      _config: unknown,
      callback: (input: Record<string, unknown>, extra: unknown) => Promise<unknown>,
    ) => {
      mockRegisteredTools.push({ name, callback });
    },
    connect: (...args: unknown[]) => mockServerConnect(...args),
    close: () => mockServerClose(),
  })),
}));

const mockHandleRequest = jest.fn<Promise<void>, unknown[]>();
const mockTransportClose = jest.fn<Promise<void>, unknown[]>();
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation(() => ({
    handleRequest: (...args: unknown[]) => mockHandleRequest(...args),
    close: () => mockTransportClose(),
  })),
}));

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

// mountMcpServer is raw Express: every POST builds a fresh McpServer + transport and dispatches via
// transport.handleRequest(req, res, req.body). These tests drive that route handler directly with
// mock req/res. Auth is NOT a mount gate — it runs per tool call inside invokeTool (via the callback
// registered with the per-request server), so a bad key is refused as a tool error result during the
// dispatch, not as a rejected POST: transport.handleRequest is always reached once the IP throttle
// and body parser have passed the request through.
// mcp.module.ts is pure Nest wiring (module registration + the raw-Express mount call), stays at 0%
// coverage, and is intentionally not a target.
describe('mountMcpServer (raw-Express request-handling path)', () => {
  const prevTrustedProxies = process.env.TRUSTED_PROXIES;

  beforeEach(() => {
    delete process.env.TRUSTED_PROXIES; // resolveClientIp then uses the socket IP, deterministically
    mockRegisteredTools.length = 0;
    mockServerConnect.mockReset().mockResolvedValue(undefined);
    mockServerClose.mockReset().mockResolvedValue(undefined);
    mockHandleRequest.mockReset().mockResolvedValue(undefined);
    mockTransportClose.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (prevTrustedProxies === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = prevTrustedProxies;
  });

  interface Harness {
    routeHandler: (req: Request, res: Response) => Promise<void>;
    tool: AnyToolDescriptor;
    authService: { validateApiKey: jest.Mock; hasPermission: jest.Mock };
    auditService: { logWarn: jest.Mock };
  }

  const mount = (): Harness => {
    const tool = {
      name: 'MessageSendText',
      description: 'Send a text message (session-scoped write tool)',
      inputSchema: z.object({ sessionId: z.string(), to: z.string(), text: z.string() }),
      tier: 'write',
      sessionScoped: true,
      handler: jest.fn().mockResolvedValue({ sent: true }),
    } as unknown as AnyToolDescriptor;
    const registry = { list: jest.fn(() => [tool]) };
    const authService = { validateApiKey: jest.fn(), hasPermission: jest.fn(() => true) };
    const auditService = { logWarn: jest.fn() };
    let routeHandlers: unknown[] = [];
    const adapter = {
      post: jest.fn((_path: string, ...handlers: unknown[]) => {
        routeHandlers = handlers;
      }),
    };
    mountMcpServer(
      adapter as unknown as Parameters<typeof mountMcpServer>[0],
      registry as unknown as ToolRegistryService,
      authService as unknown as AuthService,
      new KeyRateLimiter(1000, 60_000),
      new KeyRateLimiter(1000, 60_000),
      { readOnly: false },
      auditService as unknown as AuditService,
    );
    // adapter.post received [createIpThrottle(...), express.json(...), mcpHandler]; the tests drive
    // the terminal handler directly with a pre-parsed body, as the file's middleware harness does.
    const routeHandler = routeHandlers[routeHandlers.length - 1] as Harness['routeHandler'];
    return { routeHandler, tool, authService, auditService };
  };

  type ResMock = { on: jest.Mock; status: jest.Mock; json: jest.Mock; headersSent: boolean };
  const makeRes = (): ResMock => {
    const res: ResMock = { on: jest.fn(), status: jest.fn(), json: jest.fn(), headersSent: false };
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
  };

  const post = async (
    h: Harness,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ req: Request; res: ResMock }> => {
    const req = {
      method: 'POST',
      path: '/mcp',
      headers,
      body,
      socket: { remoteAddress: '203.0.113.7' },
    } as unknown as Request;
    const res = makeRes();
    await h.routeHandler(req, res as unknown as Response);
    return { req, res };
  };

  // The single registered tool callback, captured when the driven POST built its per-request server.
  const toolCallback = (): ToolCallback => {
    expect(mockRegisteredTools).toHaveLength(1);
    return mockRegisteredTools[0].callback;
  };

  it('dispatches the request to transport.handleRequest with the parsed body', async () => {
    const h = mount();
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'MessageSendText', arguments: { sessionId: 's1', to: '123', text: 'hi' } },
    };
    const { req, res } = await post(h, body, { 'x-api-key': 'good-key' });

    expect(mockServerConnect).toHaveBeenCalledTimes(1); // fresh server+transport wired per request
    expect(mockHandleRequest).toHaveBeenCalledWith(req, res, body);
    expect(res.on).toHaveBeenCalledWith('close', expect.any(Function)); // per-request teardown wired
    expect(res.status).not.toHaveBeenCalled(); // no error fallback
  });

  it('refuses an invalid API key inside the dispatch: tool error result, tool handler never runs', async () => {
    const h = mount();
    h.authService.validateApiKey.mockRejectedValue(new UnauthorizedException('API key is invalid'));
    await post(h, { jsonrpc: '2.0', id: 1 }, { 'x-api-key': 'bad-key' });

    // Invoke the registered tool callback exactly as the SDK would while handling a tools/call.
    const result = (await toolCallback()(
      { sessionId: 's1', to: '123', text: 'hi' },
      { requestInfo: { headers: { 'x-api-key': 'bad-key' } } },
    )) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      name: 'UnauthorizedException',
      message: 'API key is invalid',
    });
    expect(h.authService.validateApiKey).toHaveBeenCalledWith('bad-key', undefined, 's1');
    expect(h.tool.handler).not.toHaveBeenCalled(); // refused before the tool runs
    // ...and the auth failure hits the audit trail with the real request context (mirrors REST).
    expect(h.auditService.logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({
        ipAddress: '203.0.113.7',
        method: 'POST',
        path: '/mcp',
        errorMessage: 'API key is invalid',
      }),
    );
  });

  it('fails closed on a session-scoped tool call without sessionId (guard fires before the auth lookup)', async () => {
    const h = mount();
    await post(h, { jsonrpc: '2.0', id: 1 }, { authorization: 'Bearer good-key' });

    const result = (await toolCallback()(
      { to: '123', text: 'hi' }, // no sessionId
      { requestInfo: { headers: { authorization: 'Bearer good-key' } } },
    )) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
      message: 'sessionId is required for this tool',
    });
    // Fenced at the runtime boundary before the auth DB lookup, so a session-restricted key can
    // never ride an undefined scope past validateApiKey's allowedSessions check.
    expect(h.authService.validateApiKey).not.toHaveBeenCalled();
    expect(h.tool.handler).not.toHaveBeenCalled();
    expect(h.auditService.logWarn).not.toHaveBeenCalled(); // 400 parity with REST: not an auth failure
  });

  it('answers a JSON-RPC 500 when the transport throws', async () => {
    const h = mount();
    mockHandleRequest.mockRejectedValueOnce(new Error('boom'));
    const { res } = await post(h, { jsonrpc: '2.0', id: 1 });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    });
  });
});
