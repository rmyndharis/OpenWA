import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { ApiKeyRole } from '../entities/api-key.entity';
import { REQUIRED_ROLE_KEY, PUBLIC_KEY } from '../decorators/auth.decorators';
import { ipMatches, normalizeIp } from '../../../common/utils/ip';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const apiKeyHeader = this.extractApiKey(request);

    if (!apiKeyHeader) {
      throw new UnauthorizedException('API key is required');
    }

    // Get session ID from route params if present
    const sessionId = (request.params['sessionId'] || request.params['id']) as string | undefined;
    const clientIp = this.getClientIp(request);

    // Validate API key
    const apiKey = await this.authService.validateApiKey(apiKeyHeader, clientIp, sessionId);

    // Check role permission
    const requiredRole = this.reflector.getAllAndOverride<ApiKeyRole>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRole && !this.authService.hasPermission(apiKey, requiredRole)) {
      throw new UnauthorizedException(`Insufficient permissions. Required: ${requiredRole}`);
    }

    // Attach API key to request for use in controllers
    (request as Request & { apiKey: typeof apiKey }).apiKey = apiKey;

    return true;
  }

  private extractApiKey(request: Request): string | undefined {
    // Support both X-API-Key header and Authorization Bearer
    const xApiKey = request.headers['x-api-key'] as string;
    if (xApiKey) return xApiKey;

    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return undefined;
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
    const socketIp = normalizeIp(request.socket?.remoteAddress || request.ip || '');
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];

    if (trustedProxies.length === 0) {
      return socketIp;
    }

    const isTrusted = (ip: string): boolean => trustedProxies.some(proxy => ipMatches(ip, proxy));

    // Only trust the forwarded chain if the immediate peer is a trusted proxy.
    if (!isTrusted(socketIp)) {
      return socketIp;
    }

    const forwarded = request.headers['x-forwarded-for'];
    if (!forwarded) {
      return socketIp;
    }

    const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
      .split(',')
      .map(hop => normalizeIp(hop.trim()))
      .filter(Boolean);

    // Walk right-to-left and return the first hop that is not a trusted proxy:
    // the closest address the trusted infrastructure actually observed.
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isTrusted(hops[i])) {
        return hops[i];
      }
    }

    return socketIp;
  }
}
