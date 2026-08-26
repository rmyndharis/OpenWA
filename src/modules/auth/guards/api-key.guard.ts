import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthService } from '../auth.service';
import { ApiKey, ApiKeyRole } from '../entities/api-key.entity';
import { REQUIRED_ROLE_KEY, PUBLIC_KEY } from '../decorators/auth.decorators';
import { BILLING_EXEMPT_KEY } from '../decorators/auth.decorators';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/entities/audit-log.entity';
import { BillingService } from '../../billing/billing.service';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
    private readonly billingService: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [context.getHandler(), context.getClass()]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const credentials = this.extractCredentials(request);

    if (!credentials) {
      throw new UnauthorizedException('API key or user token is required');
    }

    const sessionId = (request.params['sessionId'] || request.params['id']) as string | undefined;
    const clientIp = this.getClientIp(request);

    const principal =
      credentials.type === 'user'
        ? await this.authService.validateUserToken(credentials.value)
        : await this.authService.validateApiKey(credentials.value, clientIp, sessionId);

    const requiredRole = this.reflector.getAllAndOverride<ApiKeyRole>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRole && !this.authService.hasPermission(principal, requiredRole)) {
      throw new UnauthorizedException(`Insufficient permissions. Required: ${requiredRole}`);
    }

    const isBillingExempt = this.reflector.getAllAndOverride<boolean>(BILLING_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isBillingExempt) {
      await this.billingService.assertAccess(principal);
    }

    if (credentials.type === 'user') {
      (request as Request & { user: typeof principal }).user = principal;
    } else {
      (request as Request & { apiKey: typeof principal }).apiKey = principal;
      await this.auditService.logInfo(AuditAction.API_KEY_USED, {
        apiKey: principal as ApiKey,
        sessionId,
        ipAddress: clientIp,
        userAgent: request.get('user-agent'),
        method: request.method,
        path: request.originalUrl || request.url,
      });
    }

    return true;
  }

  private extractCredentials(request: Request): { type: 'apiKey' | 'user'; value: string } | undefined {
    const xApiKey = request.headers['x-api-key'] as string;
    if (xApiKey) return { type: 'apiKey', value: xApiKey };

    const authHeader = request.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      return { type: token.startsWith('aeon_u1_') || token.startsWith('owa_u1_') ? 'user' : 'apiKey', value: token };
    }

    return undefined;
  }

  private getClientIp(request: Request): string {
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = (forwarded as string).split(',');
      return ips[0].trim();
    }
    return request.ip || request.socket.remoteAddress || '';
  }
}
