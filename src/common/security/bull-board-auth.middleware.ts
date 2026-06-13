import { Injectable, NestMiddleware, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';

/**
 * Protects the Bull Board UI (/admin/queues).
 *
 * Bull Board is mounted as raw Express middleware by @bull-board/nestjs, so the
 * global ApiKeyGuard — which only runs on Nest controller handlers — does not
 * cover it. This middleware requires a valid ADMIN-role API key, supplied via
 * the X-API-Key header, an Authorization: Bearer token, or an ?apiKey query
 * param (the latter for direct browser access).
 */
@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  constructor(private readonly authService: AuthService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const rawKey = this.extractKey(req);
      if (!rawKey) {
        throw new UnauthorizedException('API key is required to access the queue dashboard');
      }

      const apiKey = await this.authService.validateApiKey(rawKey, this.getClientIp(req));
      if (!this.authService.hasPermission(apiKey, ApiKeyRole.ADMIN)) {
        throw new ForbiddenException('Admin role required to access the queue dashboard');
      }

      next();
    } catch (err) {
      // Forward to Nest's exception layer so the response uses the standard format.
      next(err);
    }
  }

  private extractKey(req: Request): string | undefined {
    const header = req.headers['x-api-key'];
    if (typeof header === 'string' && header) return header;

    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

    const queryKey = req.query?.apiKey;
    if (typeof queryKey === 'string' && queryKey) return queryKey;

    return undefined;
  }

  private getClientIp(req: Request): string {
    return req.socket?.remoteAddress || req.ip || '';
  }
}
