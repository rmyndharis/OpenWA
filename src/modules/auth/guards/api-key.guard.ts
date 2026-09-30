import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService, UnresolvedApiKeyException } from '../auth.service';
import { ChatScopeService } from '../chat-scope.service';
import { BULK_MESSAGES_MAX } from '../../message/dto/bulk-message.dto';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';
import {
  REQUIRED_ROLE_KEY,
  PUBLIC_KEY,
  SESSION_SCOPED_KEY,
  UNSCOPED_KEY,
  CHAT_SCOPED_KEY,
  CHAT_QUOTED_ALLOWED_KEY,
  ChatScopeKind,
} from '../decorators/auth.decorators';
import { resolveClientIp } from '../../../common/utils/ip';
import { bearerToken } from '../../../common/security/bearer-token';
import { setRequestActor } from '../../../common/services/request-context';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/entities/audit-log.entity';
import { allowUnauthenticatedAuditRow } from '../../audit/auth-failure-audit-limiter';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly chatScope: ChatScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    try {
      return await this.authorize(request, context);
    } catch (err) {
      // Record rejected/denied authentication attempts so the audit log has a forensic trail for
      // credential probing. Fire-and-forget: audit logging is best-effort and must never turn a
      // 401/403 into a failure of the guard itself.
      if (err instanceof UnauthorizedException || err instanceof ForbiddenException) {
        // Stamp at least the IP so the failed-auth audit row below is attributable even though the
        // key was never resolved. setRequestActor is a no-op outside a request scope.
        const clientIp = this.getClientIp(request);
        setRequestActor({ ipAddress: clientIp });
        // A 401 that resolved no key is bounded per client IP (see UnresolvedApiKeyException); any
        // rejection of a stored key, 401 or 403, is always recorded.
        if (!(err instanceof UnresolvedApiKeyException) || allowUnauthenticatedAuditRow(clientIp)) {
          void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
            ipAddress: clientIp,
            method: request.method,
            path: request.path,
            errorMessage: err.message,
          });
        }
      }
      throw err;
    }
  }

  private async authorize(request: Request, context: ExecutionContext): Promise<boolean> {
    const apiKeyHeader = this.extractApiKey(request);

    if (!apiKeyHeader) {
      throw new UnresolvedApiKeyException('API key is required');
    }

    const requiredRole = this.reflector.getAllAndOverride<ApiKeyRole>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Resolve the session id used for the key's allowedSessions scope. `:sessionId` is always a
    // session; the bare `:id` param is only a session on controllers marked @SessionScoped (i.e.
    // SessionController) — on other routes `:id` is an unrelated resource id (API key, plugin, …)
    // and must NOT be fed to the allowedSessions check, which would spuriously deny a scoped key.
    const sessionScoped = this.reflector.getAllAndOverride<boolean>(SESSION_SCOPED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const sessionId = (request.params['sessionId'] || (sessionScoped ? request.params['id'] : undefined)) as
      string | undefined;
    const clientIp = this.getClientIp(request);

    // Validate API key
    const apiKey = await this.authService.validateApiKey(apiKeyHeader, clientIp, sessionId);

    // Stamp the resolved actor into the per-request async context so downstream audit log writes —
    // which fire from services deep in the call stack without DI access to the key — can attribute
    // the action to this key + IP. Without this every audit row's apiKey/ipAddress column is blank
    // because call sites pass only { sessionId } etc.
    //
    // Stamped HERE, the moment the key is known, rather than after the authorization checks below:
    // both of those throw, and the catch that audits the denial cannot see `apiKey` (it is a const
    // inside this method). Stamping afterwards meant every 403 the guard raised was recorded against
    // an IP alone — behind NAT or a proxy without TRUSTED_PROXIES that IP is common to every tenant,
    // so the operator could see that a key had been denied but not which one to revoke.
    setRequestActor({ apiKeyId: apiKey.id, apiKeyName: apiKey.name, ipAddress: clientIp });

    if (requiredRole && !this.authService.hasPermission(apiKey, requiredRole)) {
      throw new ForbiddenException(`Insufficient permissions. Required: ${requiredRole}`);
    }

    // Chat fence — DEFAULT DENY. A key carrying `allowedChats` may reach only a handler marked
    // @ChatScoped, and only for a chat inside its allowlist. Surfaces with no chat dimension
    // (webhooks, automation rules, status, key management, channels) — and every route added later —
    // are refused without being enumerated. An unrestricted key (no allowlist) skips this entirely,
    // so the model stays fail-open for every key that was not scoped.
    if (this.chatScope.isRestricted(apiKey)) {
      const chatScoped = this.reflector.getAllAndOverride<ChatScopeKind>(CHAT_SCOPED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!chatScoped) {
        throw new ForbiddenException('API key is restricted to selected chats');
      }
      await this.assertChatsAllowed(request, apiKey, context);
    }

    // Routes marked @RequireUnscopedKey carry no session dimension, so the allowedSessions check
    // above can never bite on them. A session-scoped key reaching such a surface (e.g. API-key
    // lifecycle management) could mint or widen credentials beyond its own confinement — reject it
    // outright, whatever its role. The denial is audited by the caller's catch block.
    const requireUnscoped = this.reflector.getAllAndOverride<boolean>(UNSCOPED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requireUnscoped && (apiKey.allowedSessions?.length ?? 0) > 0) {
      throw new ForbiddenException('Session-scoped API keys are not permitted on this route');
    }

    // Attach API key to request for use in controllers
    (request as Request & { apiKey: typeof apiKey }).apiKey = apiKey;
    // Expose the trusted-proxy-aware client IP so controllers (e.g. the audit trail on key lifecycle
    // ops) reuse the already-resolved value instead of re-deriving it.
    (request as Request & { clientIp?: string }).clientIp = clientIp;

    return true;
  }

  /** Route params the guard treats as a chat id. */
  private static readonly CHAT_ROUTE_PARAMS = ['chatId', 'groupId', 'contactId'] as const;
  /** Body fields that name a chat; bulk send nests the same name inside `messages[]`. */
  private static readonly CHAT_BODY_FIELDS = ['chatId', 'fromChatId', 'toChatId'] as const;
  /** The bulk cap, shared with the DTO so the two cannot drift; applied BEFORE any per-entry lookup. */
  private static readonly CHAT_BULK_MAX = BULK_MESSAGES_MAX;

  /**
   * Every chat id the guard can see in the request: route params, `?chatId=`, the body fields sends
   * use, and each `messages[].chatId`. A field that is PRESENT but not a string is rejected rather
   * than skipped — the global ValidationPipe coerces afterwards (enableImplicitConversion), so
   * skipping here would let a handler receive a string the fence never checked.
   */
  private chatIdsIn(request: Request): Array<[string, unknown]> {
    const out: Array<[string, unknown]> = [];
    for (const name of ApiKeyGuard.CHAT_ROUTE_PARAMS) out.push([name, request.params[name]]);
    out.push(['chatId', (request.query ?? {})['chatId']]);
    const body: unknown = request.body;
    if (body === null || typeof body !== 'object') return out;
    const b = body as Record<string, unknown>;
    for (const field of ApiKeyGuard.CHAT_BODY_FIELDS) out.push([field, b[field]]);
    const messages = b.messages;
    if (messages === undefined || messages === null) return out;
    if (!Array.isArray(messages)) throw new BadRequestException('messages must be an array');
    // Reject an oversized batch here, before the per-entry lid lookups below: the pipe's
    // @ArrayMaxSize(100) only runs after the guard, so without this one request could drive
    // thousands of sequential table queries.
    if (messages.length > ApiKeyGuard.CHAT_BULK_MAX) {
      throw new BadRequestException(`messages must contain at most ${ApiKeyGuard.CHAT_BULK_MAX} entries`);
    }
    messages.forEach((item, i) => {
      if (item === null || typeof item !== 'object') return;
      out.push([`messages[${i}].chatId`, (item as { chatId?: unknown }).chatId]);
    });
    return out;
  }

  /**
   * Enforce a restricted key's allowlist. Only the chat ids actually present are expanded (at most
   * two lid-table lookups each), so a route that names no chat costs nothing.
   */
  private async assertChatsAllowed(request: Request, apiKey: ApiKey, context: ExecutionContext): Promise<void> {
    // A bulk send repeats the same chat freely; each distinct id is expanded once.
    const checked = new Set<string>();
    for (const [field, value] of this.chatIdsIn(request)) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        throw new BadRequestException(`${field} must be a single chat id string`);
      }
      if (value.length === 0 || checked.has(value)) continue;
      checked.add(value);
      if (!(await this.chatScope.allows(apiKey, value))) {
        throw new ForbiddenException('API key not authorized for this chat');
      }
    }

    // `quotedMessageId` is a chat reference the guard does not otherwise read: the quote resolves
    // from the global message store, so a restricted key could quote a message from a chat outside
    // its allowlist into an allowed one. Refuse it outright, unless the handler is marked
    // @ChatQuotedAllowed because it binds the quote to the chat it sends into (the reply route).
    const quotedAllowed = this.reflector.getAllAndOverride<boolean>(CHAT_QUOTED_ALLOWED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const body: unknown = request.body;
    if (!quotedAllowed && body !== null && typeof body === 'object') {
      const quoted = (body as { quotedMessageId?: unknown }).quotedMessageId;
      if (quoted !== undefined && quoted !== null && quoted !== '') {
        throw new ForbiddenException('API key is restricted to selected chats');
      }
    }
  }

  private extractApiKey(request: Request): string | undefined {
    // Support both X-API-Key header and Authorization Bearer
    const xApiKey = request.headers['x-api-key'] as string;
    if (xApiKey) return xApiKey;

    return bearerToken(request.headers['authorization']);
  }

  /**
   * Resolve the real client IP used for the API key's allowedIps whitelist.
   *
   * X-Forwarded-For is client-controllable, so it is only honored when the
   * request actually arrives from a configured trusted proxy (TRUSTED_PROXIES).
   * With no trusted proxies configured, the header is ignored entirely and the
   * direct socket address is used — preventing IP-whitelist spoofing.
   */
  private getClientIp(request: Request): string {
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    return resolveClientIp(request, trustedProxies);
  }
}
