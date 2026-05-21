import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger, OnModuleInit } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { ApiKeyRole } from '../entities/api-key.entity';
import { REQUIRED_ROLE_KEY, PUBLIC_KEY } from '../decorators/auth.decorators';

@Injectable()
export class ApiKeyGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private trustedProxies: string[] = [];

  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) { }

  onModuleInit(): void {
    const raw = this.configService.get<string>('TRUSTED_PROXIES', '').trim();
    this.trustedProxies = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];

    if (this.trustedProxies.length === 0) {
      this.logger.warn(
        'TRUSTED_PROXIES is not set – X-Forwarded-For will be ignored. ' +
        'Set TRUSTED_PROXIES to your load-balancer IP(s) if running behind a reverse proxy.',
      );
    }
  }

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

  private getClientIp(request: Request): string {
    const remoteAddress = request.socket?.remoteAddress ?? '';

    // No trusted proxies configured → always use the direct connection IP.
    // This prevents X-Forwarded-For spoofing when not running behind a proxy.
    if (this.trustedProxies.length === 0) {
      return remoteAddress;
    }

    // Only read X-Forwarded-For when the direct peer is a known trusted proxy.
    // If the caller is not a trusted proxy, the header could be forged.
    if (!this.isAddressTrusted(remoteAddress)) {
      return remoteAddress;
    }

    const forwarded = request.headers['x-forwarded-for'];
    if (!forwarded) {
      return remoteAddress;
    }

    // Walk right-to-left: rightmost entries are appended by infrastructure we
    // control; leftmost entries are client-supplied and must not be trusted.
    const ips = (forwarded as string).split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = ips.length - 1; i >= 0; i--) {
      if (!this.isAddressTrusted(ips[i])) {
        return ips[i];
      }
    }

    return remoteAddress;
  }

  private isAddressTrusted(ip: string): boolean {
    return this.trustedProxies.some((entry) =>
      entry.includes('/') ? this.ipMatchesCidr(ip, entry) : ip === entry,
    );
  }

  private ipMatchesCidr(ip: string, cidr: string): boolean {
    try {
      const slashIndex = cidr.lastIndexOf('/');
      const range = cidr.slice(0, slashIndex);
      const bits = parseInt(cidr.slice(slashIndex + 1), 10);

      if (isNaN(bits) || bits < 0 || bits > 32) return false;

      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const ipNum = this.ipv4ToInt(ip);
      const rangeNum = this.ipv4ToInt(range);

      return (ipNum & mask) === (rangeNum & mask);
    } catch {
      this.logger.warn(`Malformed CIDR entry in TRUSTED_PROXIES: "${cidr}"`);
      return false;
    }
  }

  private ipv4ToInt(ip: string): number {
    const octets = ip.split('.');
    if (octets.length !== 4) return 0;
    return octets.reduce((acc, octet) => ((acc << 8) | (parseInt(octet, 10) & 0xff)) >>> 0, 0) >>> 0;
  }
}