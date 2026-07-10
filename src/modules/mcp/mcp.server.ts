import { ForbiddenException, HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { invokeTool } from '../../core/agent-tools/tool-invoker';
import type { ToolRegistryService } from '../../core/agent-tools/tool-registry.service';
import type { AuthService } from '../auth/auth.service';
import type { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { handleToolError, jsonToolResult, smartToolResult } from './tool-result';
import type { KeyRateLimiter } from './mcp-rate-limit';
import { resolveClientIp } from '../../common/utils/ip';

const logger = new Logger('McpServer');

type HttpAdapter = NonNullable<HttpAdapterHost['httpAdapter']>;
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Request-scoped context forwarded to the audit trail on an MCP auth failure (mirrors the REST guard). */
export interface McpRequestContext {
  ipAddress?: string;
  method?: string;
  path?: string;
}

/** Extract the raw API key from MCP request headers. Accepts X-Api-Key or Bearer token. */
function extractApiKey(extra: ToolExtra): string | undefined {
  const headers = extra.requestInfo?.headers ?? {};
  const xApiKey = headers['x-api-key'];
  if (xApiKey) {
    return Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  }
  const auth = headers['authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (authStr?.toLowerCase().startsWith('bearer ')) {
    return authStr.slice(7).trim();
  }
  return undefined;
}

/**
 * Mirror the REST ApiKeyGuard's auth-failure audit trail for MCP. The MCP mount is raw Express (outside
 * the Nest guard pipeline), so without this a credential-probing flood against /mcp leaves no forensic
 * record. Records a WARN `API_KEY_AUTH_FAILED` for rejected/denied authentication attempts (401/403 only);
 * non-auth errors (e.g. a 400 from bad tool input) are NOT audited — parity with the REST guard, which
 * only records Unauthorized/Forbidden. Fire-and-forget; best-effort (AuditService swallows insert errors).
 */
export function auditMcpAuthFailure(
  auditService: Pick<AuditService, 'logWarn'> | undefined,
  error: unknown,
  reqContext: McpRequestContext,
): void {
  if (!auditService) return;
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
        // inputSchema accepts AnySchema (zod v4 $ZodType is compatible)
        inputSchema: tool.inputSchema as Parameters<typeof server.registerTool>[1]['inputSchema'],
        annotations: {
          readOnlyHint: tool.tier === 'read',
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? tool.tier === 'read',
        },
      },
      async (input: Record<string, unknown>, extra: ToolExtra) => {
        const rawKey = extractApiKey(extra);
        try {
          const result = await invokeTool(
            tool,
            input,
            rawKey,
            authService,
            id => rateLimiter.check(id),
            // onAuthFailure: mirror the REST ApiKeyGuard — record rejected/denied auth attempts (401/403
            // only) at the auth boundary so the audit trail covers MCP credential probing. Fires inside
            // invokeTool's auth phase (before the tool handler), so handler-thrown 403s are NOT mislabeled
            // as auth failures. Best-effort; success and non-auth errors skip this.
            error => auditMcpAuthFailure(auditService, error, reqContext),
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

  logger.log(`MCP server built with ${tools.length} tools (readOnly=${readOnly})`);
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
 * Per-request: mint a fresh McpServer + StreamableHTTPServerTransport, handle, tear down.
 * Stateless (sessionIdGenerator: undefined) — no session map, no GET/DELETE reconnect.
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
    const ip = resolveClientIp(req, readTrustedProxies());
    try {
      ipRateLimiter.check(ip);
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
): void {
  const basePath = (options.basePath ?? '/mcp').replace(/\/$/, '') || '/mcp';
  const serverInfo = options.serverInfo ?? { name: 'openwa', version: '0.0.0' };
  const readOnly = resolveMcpReadOnly(options.readOnly);

  // Eagerly compute the tool list at mount time to validate the registry is populated
  // and to emit the log line once. The actual McpServer is re-created per request to
  // avoid the SDK's single-transport-at-a-time constraint under concurrent load.
  const tools = registry.list({ readOnly });
  logger.log(`MCP server mounted at POST ${basePath} (${tools.length} tools)`);

  const handler: RequestHandler = async (req: Request, res: Response) => {
    const server = buildServer(
      registry,
      authService,
      rateLimiter,
      readOnly,
      serverInfo,
      auditService,
      resolveReqContext(req),
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

  const adapter = httpAdapter as unknown as { post: (path: string, ...handlers: RequestHandler[]) => unknown };
  // ipThrottle runs BEFORE express.json()/handler so an unauthenticated flood is rejected before any body
  // parsing or DB lookup.
  adapter.post(basePath, createIpThrottle(ipRateLimiter), express.json(), handler);
}
