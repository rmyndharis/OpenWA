import { Injectable, NestMiddleware, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
import { AuditService } from '../../modules/audit/audit.service';
import { AuditAction } from '../../modules/audit/entities/audit-log.entity';
import { KeyRateLimiter, readIpRateLimitConfig } from '../../modules/mcp/mcp-rate-limit';
import { resolveClientIp } from '../utils/ip';

/**
 * Protects the Bull Board UI (/admin/queues).
 *
 * Bull Board is mounted as raw Express middleware by @bull-board/nestjs, so the
 * global ApiKeyGuard — which only runs on Nest controller handlers — does not
 * cover it. This middleware requires a valid ADMIN-role API key, supplied via
 * the X-API-Key header or an Authorization: Bearer token.
 *
 * The ?apiKey query-string fallback was removed: an ADMIN key in the
 * URL leaks into proxy/access logs, browser history, bookmarks, and the Referer header.
 *
 * A pre-auth per-IP throttle (mirroring the MCP mount's createIpThrottle) bounds a credential-probing
 * flood BEFORE it reaches the validateApiKey DB lookup. It uses the same KeyRateLimiter + IP-rate-limit
 * settings as MCP, so the two raw-Express mounts share one generous pre-auth IP-flood policy.
 *
 * Audit trail at this boundary (the Nest guard cannot see this mount):
 *  - 401/403 rejections are recorded as WARN API_KEY_AUTH_FAILED, mirroring the REST guard and the
 *    MCP mount. The pre-auth IP throttle above is the flood bound — a throttled 429 is NOT audited,
 *    so a probing flood cannot drown the audit table either.
 *  - An authenticated non-GET/HEAD request is recorded as INFO QUEUE_BOARD_MUTATED with method+path.
 *    This is a boundary trace of queue-mutation attempts reaching the Bull Board router (the UI's
 *    retry/remove/pause actions are POSTs); it deliberately does NOT model Bull Board's internal
 *    per-action outcomes, which are invisible from middleware.
 * Session-restricted keys are refused outright: the board is deployment-global, so a key confined to
 * a subset of sessions has no scope to enforce against it.
 * Both are fire-and-forget: audit logging is best-effort and must never affect the auth decision.
 */
@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  private readonly ipRateLimiter: KeyRateLimiter;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly auditService?: AuditService,
    ipRateLimiter?: KeyRateLimiter,
  ) {
    // Default to MCP's pre-auth per-IP policy (max 120 / 60s) when not supplied. Tests inject a tight
    // limiter; production (instantiated manually in main.ts) takes the default.
    this.ipRateLimiter = ipRateLimiter ?? BullBoardAuthMiddleware.createDefaultIpLimiter();
  }

  private static createDefaultIpLimiter(): KeyRateLimiter {
    const { max, windowMs } = readIpRateLimitConfig();
    return new KeyRateLimiter(max, windowMs);
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const clientIp = this.getClientIp(req);
      // Pre-auth, per-IP throttle — runs BEFORE the credential check so a login-attempt flood is rejected
      // before the DB lookup. Mirrors MCP's createIpThrottle. Throws HttpException(429) when exceeded;
      // forwarded to Nest's exception layer below as a standard 429.
      this.ipRateLimiter.check(clientIp);

      const rawKey = this.extractKey(req);
      if (!rawKey) {
        throw new UnauthorizedException('API key is required to access the queue dashboard');
      }

      const apiKey = await this.authService.validateApiKey(rawKey, clientIp);
      if (!this.authService.hasPermission(apiKey, ApiKeyRole.ADMIN)) {
        throw new ForbiddenException('Admin role required to access the queue dashboard');
      }

      // The board shows and mutates every queue in the deployment, and carries no session dimension
      // to scope against. validateApiKey above is called without a session id, so a key restricted to
      // specific sessions passes its scope check by default — reject it here instead. This mirrors
      // @RequireUnscopedKey on the REST surface, which cannot reach this raw-Express mount.
      if ((apiKey.allowedSessions?.length ?? 0) > 0) {
        throw new ForbiddenException('API keys restricted to specific sessions cannot access the queue dashboard');
      }

      // Boundary trace of queue-mutation attempts. GET/HEAD are the UI's read/poll traffic; every
      // other method reaching the Bull Board router mutates queue state, so record it with the
      // authenticated key, the resolved client IP, and the method + full path (no query string).
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        void this.auditService?.logInfo(AuditAction.QUEUE_BOARD_MUTATED, {
          apiKey,
          ipAddress: clientIp,
          method: req.method,
          path: this.auditPath(req),
        });
      }

      next();
    } catch (err) {
      // Audit the rejected/denied attempt for a forensic trail, like the REST guard and the MCP
      // mount do. A throttle overrun (HttpException 429) is deliberately NOT audited: the limiter
      // already rejected it, and logging each throttled hit would let a flood write unbounded rows.
      if (err instanceof UnauthorizedException || err instanceof ForbiddenException) {
        void this.auditService?.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
          ipAddress: this.getClientIp(req),
          method: req.method,
          path: this.auditPath(req),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      // Forward to Nest's exception layer so the response uses the standard format. A throttle overrun
      // surfaces here as an HttpException(429) → rendered as a standard 429 by the global exception filter.
      next(err);
    }
  }

  /** Full request path (mount prefix included) with any query string stripped. */
  private auditPath(req: Request): string {
    const url = req.originalUrl ?? req.url ?? '';
    return url.split('?')[0];
  }

  private extractKey(req: Request): string | undefined {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header) return header;

    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

    // No ?apiKey query fallback — an admin key in the URL leaks into logs/history.
    return undefined;
  }

  private getClientIp(req: Request): string {
    // Mirror the ApiKeyGuard's IP model so allowedIps is enforced consistently for the queue UI:
    // X-Forwarded-For is honored only behind a configured trusted proxy.
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    return resolveClientIp(req, trustedProxies);
  }
}
