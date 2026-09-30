import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UnresolvedApiKeyException } from '../auth/auth.service';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { auditMcpAuthFailure, createIpThrottle, createKeyGate, mountMcpServer, resolveMcpReadOnly } from './mcp.server';
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
  const makeReq = (ip: string, body?: unknown): Request =>
    ({ socket: { remoteAddress: ip }, headers: {}, body }) as unknown as Request;

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

  it('buckets an IPv6 client on its /64, so rotating addresses inside it shares one bucket', () => {
    const throttle = createIpThrottle(new KeyRateLimiter(1, 60_000));
    throttle(makeReq('2001:db8:1:2::a'), makeRes() as unknown as Response, jest.fn());

    const sameSubnet = jest.fn();
    throttle(makeReq('2001:db8:1:2::b'), makeRes() as unknown as Response, sameSubnet);
    expect(sameSubnet).not.toHaveBeenCalled();

    const otherSubnet = jest.fn();
    throttle(makeReq('2001:db8:1:3::a'), makeRes() as unknown as Response, otherSubnet);
    expect(otherSubnet).toHaveBeenCalledWith();
  });

  // Every element of a JSON-RPC batch is dispatched (and each tools/call runs its own key lookup and
  // auth-failure audit), so the budget is charged per message, not per HTTP request.
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'SessionFindAll', arguments: {} } };

  it('rejects a batch larger than the remaining per-IP budget', () => {
    const throttle = createIpThrottle(new KeyRateLimiter(2, 60_000));
    const next = jest.fn();
    const res = makeRes();
    throttle(makeReq('1.2.3.4', [call, call, call]), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32000);
  });

  it('charges each batch element, so the next request after a full batch is throttled', () => {
    const throttle = createIpThrottle(new KeyRateLimiter(2, 60_000));
    const next1 = jest.fn();
    throttle(makeReq('1.2.3.4', [call, call]), makeRes() as unknown as Response, next1);
    expect(next1).toHaveBeenCalledWith();

    const next2 = jest.fn();
    const res2 = makeRes();
    throttle(makeReq('1.2.3.4', call), res2 as unknown as Response, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).toHaveBeenCalledWith(429);
  });

  it('charges an empty batch as one message', () => {
    const throttle = createIpThrottle(new KeyRateLimiter(1, 60_000));
    const next1 = jest.fn();
    throttle(makeReq('1.2.3.4', []), makeRes() as unknown as Response, next1);
    expect(next1).toHaveBeenCalledWith();

    const next2 = jest.fn();
    throttle(makeReq('1.2.3.4', call), makeRes() as unknown as Response, next2);
    expect(next2).not.toHaveBeenCalled();
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

  it('mirrors the REST guard exactly: IP-not-allowed (Forbidden) is audited', () => {
    // validateApiKey throws Forbidden for IP-not-allowed / session-not-allowed, Unauthorized for revoked / expired.
    auditMcpAuthFailure(auditService, new ForbiddenException('IP address not allowed'), reqContext);
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

describe('createKeyGate (every MCP request needs a valid key)', () => {
  type ResMock = { status: jest.Mock; json: jest.Mock; set: jest.Mock; statusCode?: number; body?: unknown };
  const makeRes = (): ResMock => {
    const res: ResMock = { status: jest.fn(), json: jest.fn(), set: jest.fn() };
    res.status.mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.json.mockImplementation((b: unknown) => {
      res.body = b;
      return res;
    });
    res.set.mockReturnValue(res);
    return res;
  };
  const run = async (
    validateApiKey: jest.Mock,
    headers: Record<string, string> = {},
    logWarn: jest.Mock = jest.fn(),
    ip = '203.0.113.7',
  ) => {
    const gate = createKeyGate({ validateApiKey }, { logWarn });
    const req = {
      method: 'POST',
      path: '/mcp',
      headers,
      socket: { remoteAddress: ip },
    } as unknown as Request;
    const res = makeRes();
    const next = jest.fn();
    await gate(req, res as unknown as Response, next);
    return { res, next, logWarn };
  };

  it('refuses a request with no key before any lookup: 401, JSON-RPC body, audited within the IP budget', async () => {
    const validateApiKey = jest.fn();
    const { res, next, logWarn } = await run(validateApiKey);

    expect(next).not.toHaveBeenCalled();
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.set).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing API key' }, id: null });
    expect(logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ ipAddress: '203.0.113.7', method: 'POST', path: '/mcp' }),
    );
  });

  // The unauthenticated-row budget is a module-level singleton shared with the REST guard, so this
  // test uses an IP no other test in this file uses.
  it('writes at most 10 keyless rows a minute for one IP, and still records a revoked key after that', async () => {
    const logWarn = jest.fn();
    const ip = '198.51.100.91';
    for (let i = 0; i < 11; i++) {
      const { res, next } = await run(jest.fn(), {}, logWarn, ip);
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    }
    expect(logWarn).toHaveBeenCalledTimes(10);

    const revoked = jest.fn().mockRejectedValue(new UnauthorizedException('API key is revoked'));
    const { res } = await run(revoked, { 'x-api-key': 'old-key' }, logWarn, ip);
    expect(res.statusCode).toBe(401);
    expect(logWarn).toHaveBeenCalledTimes(11);
    expect(logWarn).toHaveBeenLastCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ ipAddress: ip, errorMessage: 'API key is revoked' }),
    );
  });

  it('refuses an unknown key with 401 and audits it', async () => {
    const validateApiKey = jest.fn().mockRejectedValue(new UnresolvedApiKeyException('Invalid API key'));
    const { res, next, logWarn } = await run(validateApiKey, { 'x-api-key': 'bad-key' });

    expect(next).not.toHaveBeenCalled();
    expect(validateApiKey).toHaveBeenCalledWith('bad-key', undefined, undefined, { recordUsage: false });
    expect(res.statusCode).toBe(401);
    expect(logWarn).toHaveBeenCalledWith(
      AuditAction.API_KEY_AUTH_FAILED,
      expect.objectContaining({ errorMessage: 'Invalid API key' }),
    );
  });

  it.each([[{ 'x-api-key': 'good-key' }], [{ authorization: 'Bearer good-key' }]])(
    'passes a valid key through without a client IP or session (%j)',
    async headers => {
      const validateApiKey = jest.fn().mockResolvedValue({ id: 'k1' });
      const { res, next } = await run(validateApiKey, headers);

      expect(next).toHaveBeenCalledWith();
      expect(validateApiKey).toHaveBeenCalledWith('good-key', undefined, undefined, { recordUsage: false });
      expect(res.status).not.toHaveBeenCalled();
    },
  );

  it('refuses a malformed Authorization header without a lookup', async () => {
    const validateApiKey = jest.fn();
    const { res, next } = await run(validateApiKey, { authorization: 'Bearer good-key extra' });

    expect(next).not.toHaveBeenCalled();
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('answers 500, unaudited, when the key lookup itself fails', async () => {
    const validateApiKey = jest.fn().mockRejectedValue(new Error('database is down'));
    const { res, next, logWarn } = await run(validateApiKey, { 'x-api-key': 'good-key' });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    expect(logWarn).not.toHaveBeenCalled();
  });
});

// mountMcpServer is raw Express: every POST passes the IP throttle and the key gate, then builds a
// fresh McpServer + transport and dispatches via transport.handleRequest(req, res, req.body). These
// tests drive the terminal handler directly with mock req/res, past the gate. Role, session and chat
// scope still run per tool call inside invokeTool (via the callback registered with the per-request
// server), so a key refused there is answered as a tool error result during the dispatch.
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
    adapter: { post: jest.Mock; get: jest.Mock; delete: jest.Mock };
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
      get: jest.fn(),
      delete: jest.fn(),
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
    // adapter.post received [express.json(...), createIpThrottle(...), mcpHandler]; the tests drive
    // the terminal handler directly with a pre-parsed body, as the file's middleware harness does.
    const routeHandler = routeHandlers[routeHandlers.length - 1] as Harness['routeHandler'];
    return { routeHandler, tool, authService, auditService, adapter };
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

  it('answers GET and DELETE with a JSON-RPC 405 carrying Allow: POST (stateless, no SSE stream)', () => {
    const h = mount();
    for (const verb of ['get', 'delete'] as const) {
      expect(h.adapter[verb]).toHaveBeenCalledWith('/mcp', expect.any(Function));
      const refuse = (h.adapter[verb].mock.calls[0] as unknown[])[1] as (req: Request, res: Response) => void;
      const res = { status: jest.fn(), set: jest.fn(), json: jest.fn() };
      res.status.mockReturnValue(res);
      res.set.mockReturnValue(res);
      refuse({} as Request, res as unknown as Response);
      expect(res.status).toHaveBeenCalledWith(405);
      expect(res.set).toHaveBeenCalledWith('Allow', 'POST');
      expect(res.json).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
    }
  });

  it('parses the body before the per-IP throttle, and checks the key after the throttle', () => {
    const h = mount();
    const [path, parser, ...rest] = h.adapter.post.mock.calls[0] as unknown[];
    expect(path).toBe('/mcp');
    expect((parser as { name?: string }).name).toBe('jsonParser');
    expect(rest).toHaveLength(3); // throttle, key gate, handler
  });

  it('refuses a keyless POST at the gate before any MCP server is built', async () => {
    const h = mount();
    const gate = (h.adapter.post.mock.calls[0] as unknown[])[3] as (
      req: Request,
      res: Response,
      next: () => void,
    ) => Promise<void>;
    const res = { status: jest.fn(), json: jest.fn(), set: jest.fn() };
    res.status.mockReturnValue(res);
    res.set.mockReturnValue(res);
    const next = jest.fn();
    const body = { jsonrpc: '2.0', id: 1, method: 'initialize' };
    await gate(
      {
        method: 'POST',
        path: '/mcp',
        headers: {},
        body,
        socket: { remoteAddress: '203.0.113.7' },
      } as unknown as Request,
      res as unknown as Response,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(h.auditService.logWarn).toHaveBeenCalledWith(AuditAction.API_KEY_AUTH_FAILED, expect.anything());
  });

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

  // One parser for every surface that reads Authorization, so a header the REST guard accepts is
  // accepted here too and one it refuses is refused here too.
  it.each([
    ['bearer good-key', 'good-key'],
    ['Bearer\tgood-key', 'good-key'],
    ['Bearer good-key extra', undefined],
  ])('reads the Authorization header %j like the REST guard', async (header, expected) => {
    const h = mount();
    h.authService.validateApiKey.mockResolvedValue({ id: 'k1' });
    await post(h, { jsonrpc: '2.0', id: 1 }, { authorization: header });

    await toolCallback()(
      { sessionId: 's1', to: '123', text: 'hi' },
      { requestInfo: { headers: { authorization: header } } },
    );

    if (expected === undefined) expect(h.authService.validateApiKey).not.toHaveBeenCalled();
    else expect(h.authService.validateApiKey).toHaveBeenCalledWith(expected, undefined, 's1');
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
