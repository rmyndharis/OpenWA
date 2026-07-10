import { Injectable, NestMiddleware, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
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
 */
@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  private readonly ipRateLimiter: KeyRateLimiter;

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
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

      next();
    } catch (err) {
      // Forward to Nest's exception layer so the response uses the standard format. A throttle overrun
      // surfaces here as an HttpException(429) → rendered as a standard 429 by the global exception filter.
      next(err);
    }
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
