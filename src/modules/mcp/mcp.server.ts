import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import type { HttpAdapterHost } from '@nestjs/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ChatScopeService } from '../auth/chat-scope.service';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { invokeTool } from '../../core/agent-tools/tool-invoker';
import type { ToolRegistryService } from '../../core/agent-tools/tool-registry.service';
import { UnresolvedApiKeyException, type AuthService } from '../auth/auth.service';
import { allowUnauthenticatedAuditRow } from '../audit/auth-failure-audit-limiter';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { handleToolError, jsonToolResult, smartToolResult } from './tool-result';
import type { KeyRateLimiter } from './mcp-rate-limit';
import { limiterKeyForIp, resolveClientIp } from '../../common/utils/ip';
import { resolveBodyLimit } from '../../config/bootstrap-security';
import { bearerToken } from '../../common/security/bearer-token';

const logger = createLogger('McpServer');

type HttpAdapter = NonNullable<HttpAdapterHost['httpAdapter']>;
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Request-scoped context forwarded to the audit trail on an MCP auth failure (mirrors the REST guard). */
export interface McpRequestContext {
  ipAddress?: string;
  method?: string;
  path?: string;
}

/**
 * Extract the raw API key from request headers. Accepts X-Api-Key or Bearer token. The mount gate parses
 * the Express headers and hands the key it validated to the per-tool check as `authInfo`, so the two
 * cannot disagree on what the credential is (the SDK's own header copy joins duplicate headers).
 */
function extractApiKey(headers: Record<string, string | string[] | undefined> = {}): string | undefined {
  const xApiKey = headers['x-api-key'];
  if (xApiKey) {
    return Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  }
  const auth = headers['authorization'];
  return bearerToken(Array.isArray(auth) ? auth[0] : auth);
}

/**
 * Mirror the REST ApiKeyGuard's auth-failure audit trail for MCP. The MCP mount is raw Express (outside
 * the Nest guard pipeline), so without this a credential-probing flood against /mcp leaves no forensic
 * record. Records a WARN `API_KEY_AUTH_FAILED` for rejected/denied authentication attempts (401/403 only);
 * non-auth errors (e.g. a 400 from bad tool input) are NOT audited — parity with the REST guard, which
 * only records Unauthorized/Forbidden. A rejection that names no stored key (UnresolvedApiKeyException)
 * draws on the per-IP budget the REST guard and Bull Board share; a stored key's rejection is always
 * recorded. Fire-and-forget; best-effort (AuditService swallows insert errors).
 */
export function auditMcpAuthFailure(
  auditService: Pick<AuditService, 'logWarn'> | undefined,
  error: unknown,
  reqContext: McpRequestContext,
): void {
  if (!auditService) return;
  if (error instanceof UnresolvedApiKeyException && !allowUnauthenticatedAuditRow(reqContext.ipAddress ?? '')) {
    return;
  }
  if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
    void auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
      ipAddress: reqContext.ipAddress,
      method: reqContext.method,
      path: reqContext.path,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Read TRUSTED_PROXIES once as a list (shared by the pre-auth throttle and the audit IP resolver). */
function readTrustedProxies(): string[] {
  return (process.env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Resolve the trusted-proxy-aware client IP + HTTP method/path for an audit record. */
function resolveReqContext(req: Request): McpRequestContext {
  return {
    ipAddress: resolveClientIp(req, readTrustedProxies()),
    method: req.method,
    path: req.path,
  };
}

/**
 * Build the MCP server ONCE and register all tools from the registry.
 * The SDK's `registerTool` accepts `AnySchema` (z4.$ZodType) directly, so we
 * pass `tool.inputSchema` verbatim — no `.shape` extraction needed.
 */
function buildServer(
  registry: ToolRegistryService,
  authService: AuthService,
  rateLimiter: KeyRateLimiter,
  readOnly: boolean,
  serverInfo: { name: string; version: string },
  auditService: AuditService | undefined,
  reqContext: McpRequestContext,
  chatScope?: ChatScopeService,
): McpServer {
  const server = new McpServer(
    { name: serverInfo.name, version: serverInfo.version },
    { capabilities: { tools: {}, logging: {} } },
  );

  const tools = registry.list({ readOnly });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The SDK's InputArgs is inferred from this property. Widening it to the whole
        // `ZodRawShapeCompat | AnySchema` constraint would collapse the callback type it derives, so
        // the cast names AnySchema exactly — which zod v4's $ZodType satisfies.
        inputSchema: tool.inputSchema as AnySchema,
        annotations: {
          readOnlyHint: tool.tier === 'read',
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? tool.tier === 'read',
        },
      },
      async (input: Record<string, unknown>, extra: ToolExtra) => {
        const rawKey = extra.authInfo?.token ?? extractApiKey(extra.requestInfo?.headers);
        try {
          const result = await invokeTool(
            tool,
            input,
            rawKey,
            authService,
            id => rateLimiter.check(id),
            // onAuthFailure: mirror the REST ApiKeyGuard — record rejected/denied auth attempts (401/403
            // only) at the auth boundary so the audit trail covers MCP credential probing. Fires inside
            // invokeTool's authorization checks (before the tool handler), so handler-thrown 403s are NOT mislabeled
            // as auth failures. Best-effort; success and non-auth errors skip this.
            error => auditMcpAuthFailure(auditService, error, reqContext),
            chatScope,
          );
          return tool.resultDisposition === 'json'
            ? jsonToolResult(result as object)
            : smartToolResult(result as object);
        } catch (error) {
          return handleToolError(error);
        }
      },
    );
  }

  return server;
}

export interface MountMcpServerOptions {
  basePath?: string;
  serverInfo?: { name: string; version: string };
  readOnly?: boolean;
}

/**
 * Mount the MCP Streamable-HTTP transport on the existing Nest/Express adapter
 * at `POST {basePath}` (default `/mcp`), single-port.
 *
 * Tool handlers are built ONCE at mount time (closure over registry/authService/rateLimiter).
 * Every POST passes the per-IP throttle and then the key gate before any MCP method runs.
 * Per-request: mint a fresh McpServer + StreamableHTTPServerTransport, handle, tear down.
 * Stateless (sessionIdGenerator: undefined): no session map; GET/DELETE answer 405.
 * Creating a new McpServer per request is safe and avoids the single-transport constraint;
 * tool registration is O(n) pure function calls with no I/O overhead.
 */
/**
 * Pre-auth, per-IP throttle for the raw-Express /mcp mount. The global Nest throttler doesn't cover this
 * mount (it bypasses the guard pipeline) and the per-key limiter only fires AFTER key validation — so a
 * missing/invalid/revoked key otherwise reaches a DB lookup unthrottled. This gates by resolved client IP
 * first and returns a JSON-RPC 429 directly (raw Express wouldn't convert a thrown HttpException).
 */
export function createIpThrottle(ipRateLimiter: KeyRateLimiter): RequestHandler {
  return (req, res, next) => {
    const ip = limiterKeyForIp(resolveClientIp(req, readTrustedProxies()));
    // The unit of work is the JSON-RPC message, not the HTTP request: the transport dispatches every
    // element of a batch, and each tools/call element runs its own key lookup and auth-failure audit.
    // An over-budget batch throws on the first check past the cap, so a huge array costs at most
    // `max + 1` checks.
    const messages = Array.isArray(req.body) ? Math.max(1, req.body.length) : 1;
    try {
      for (let i = 0; i < messages; i++) ipRateLimiter.check(ip);
      next();
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 429;
      res.status(status).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: err instanceof Error ? err.message : 'MCP rate limit exceeded' },
        id: null,
      });
    }
  };
}

/**
 * Mount gate: every POST must carry a valid API key before the transport answers anything, including
 * `initialize` (server version) and `tools/list` (tool catalogue). Runs after the per-IP throttle so a
 * flood never reaches the key lookup. Validated with no client IP and no session, as the per-tool check
 * does: a key with `allowedIps` is refused on MCP, and role, session and chat scope stay per tool call.
 * Neither the per-key limiter nor the key's usage stats are charged here; invokeTool charges both per
 * tool call, so a request counts once.
 */
export function createKeyGate(
  authService: Pick<AuthService, 'validateApiKey'>,
  auditService: Pick<AuditService, 'logWarn'> | undefined,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const rawKey = extractApiKey(req.headers);
      if (!rawKey) throw new UnresolvedApiKeyException('Missing API key');
      await authService.validateApiKey(rawKey, undefined, undefined, { recordUsage: false });
      // The transport forwards req.auth to every tool call as extra.authInfo.
      (req as Request & { auth?: AuthInfo }).auth = { token: rawKey, clientId: 'api-key', scopes: [] };
    } catch (err) {
      if (err instanceof HttpException) {
        auditMcpAuthFailure(auditService, err, resolveReqContext(req));
        const status = err.getStatus();
        if (status === 401) res.set('WWW-Authenticate', 'Bearer');
        res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message: err.message }, id: null });
        return;
      }
      logger.error('Error authenticating MCP request', err instanceof Error ? err.stack : String(err));
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      return;
    }
    next();
  };
}

/**
 * Resolve the MCP read-only flag with a SECURE default: read-only unless the operator explicitly opts
 * out with MCP_READONLY=false. Previously an unset MCP_READONLY defaulted to read-WRITE, silently
 * exposing state-changing tools (send messages, group ops) to any MCP caller the moment MCP_ENABLED
 * was on. An explicit `options.readOnly` (tests / programmatic mounts) still wins.
 */
export function resolveMcpReadOnly(optionsReadOnly?: boolean): boolean {
  return optionsReadOnly ?? process.env.MCP_READONLY !== 'false';
}

export function mountMcpServer(
  httpAdapter: HttpAdapter,
  registry: ToolRegistryService,
  authService: AuthService,
  rateLimiter: KeyRateLimiter,
  ipRateLimiter: KeyRateLimiter,
  options: MountMcpServerOptions = {},
  auditService?: AuditService,
  chatScope?: ChatScopeService,
): void {
  const basePath = (options.basePath ?? '/mcp').replace(/\/$/, '') || '/mcp';
  const serverInfo = options.serverInfo ?? { name: 'openwa', version: '0.0.0' };
  const readOnly = resolveMcpReadOnly(options.readOnly);

  // Eagerly compute the tool list at mount time to validate the registry is populated
  // and to emit the log line once. The actual McpServer is re-created per request to
  // avoid the SDK's single-transport-at-a-time constraint under concurrent load.
  const tools = registry.list({ readOnly });
  logger.log(`MCP server mounted at POST ${basePath} (${tools.length} tools, readOnly=${readOnly})`);

  const handler: RequestHandler = async (req: Request, res: Response) => {
    const server = buildServer(
      registry,
      authService,
      rateLimiter,
      readOnly,
      serverInfo,
      auditService,
      resolveReqContext(req),
      chatScope,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('Error handling MCP request', error instanceof Error ? error.stack : String(error));
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  };

  type Mount = (path: string, ...handlers: RequestHandler[]) => unknown;
  const adapter = httpAdapter as unknown as { post: Mount; get: Mount; delete: Mount };
  // The route throttle gates the auth DB lookup and per-request MCP server/transport construction. The
  // process-wide capped json() in src/configure-app.ts runs first for all routes; this route-level parser is a
  // defensive fallback and no-ops once the global parser has consumed the body. It sits before the
  // throttle so the throttle always sees a parsed body and can charge a batch per message.
  // `inflate: false` matches the global parsers: a compressed body is refused by the budget
  // middleware long before this runs, and this keeps the fallback from becoming the one parser that
  // would still gunzip an unaccounted body if that ordering ever changed.
  // `limit` mirrors the same global cap for the same reason: without it a middleware reorder would
  // silently leave this mount uncapped.
  const bodyLimit = resolveBodyLimit(process.env.BODY_SIZE_LIMIT);
  adapter.post(
    basePath,
    express.json({ limit: bodyLimit, inflate: false }),
    createIpThrottle(ipRateLimiter),
    createKeyGate(authService, auditService),
    handler,
  );
  // Stateless transport: no standalone SSE stream and no session to delete. The Streamable HTTP spec
  // requires a GET to be answered with a stream or 405, and SDK clients treat anything but 405 as an
  // error on every connect. Routing these to the transport would open a stream (GET) or answer 200
  // (DELETE), so they are refused here without touching auth or the DB.
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  adapter.get(basePath, methodNotAllowed);
  adapter.delete(basePath, methodNotAllowed);
}
