import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiKeyRole } from '../entities/api-key.entity';
import { Request } from 'express';
import { ApiKey } from '../entities/api-key.entity';
import { User } from '../entities/user.entity';

export const REQUIRED_ROLE_KEY = 'requiredRole';
export const PUBLIC_KEY = 'isPublic';
export const BILLING_EXEMPT_KEY = 'isBillingExempt';

/**
 * Mark a route as requiring a specific role
 * @example @RequireRole(ApiKeyRole.ADMIN)
 */
export const RequireRole = (role: ApiKeyRole) => SetMetadata(REQUIRED_ROLE_KEY, role);

/**
 * Mark a route as public (no API key required)
 * @example @Public()
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Allow authenticated users to reach payment and account-status routes when billing is overdue. */
export const BillingExempt = () => SetMetadata(BILLING_EXEMPT_KEY, true);

/**
 * Get the current API key from request
 * @example @CurrentApiKey() apiKey: ApiKey
 */
export const CurrentApiKey = createParamDecorator((data: unknown, ctx: ExecutionContext): ApiKey | undefined => {
  const request = ctx.switchToHttp().getRequest<Request & { apiKey?: ApiKey }>();
  return request.apiKey;
});

/**
 * Get the current dashboard user from request
 * @example @CurrentUser() user: User
 */
export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext): User | undefined => {
  const request = ctx.switchToHttp().getRequest<Request & { apiKey?: ApiKey; user?: User }>();
  if (request.user) return request.user;

  if (request.apiKey?.ownerUserId) {
    return {
      id: request.apiKey.ownerUserId,
      tenantId: request.apiKey.tenantId || request.apiKey.ownerUserId,
      role: request.apiKey.role,
    } as User;
  }

  return undefined;
});

/**
 * Get the current authenticated principal from request
 */
export const CurrentPrincipal = createParamDecorator((data: unknown, ctx: ExecutionContext): ApiKey | User | undefined => {
  const request = ctx.switchToHttp().getRequest<Request & { apiKey?: ApiKey; user?: User }>();
  return request.user || request.apiKey;
});
