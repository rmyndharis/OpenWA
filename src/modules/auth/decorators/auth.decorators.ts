import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiKeyRole } from '../entities/api-key.entity';
import { Request } from 'express';
import { ApiKey } from '../entities/api-key.entity';

export const REQUIRED_ROLE_KEY = 'requiredRole';
export const PUBLIC_KEY = 'isPublic';
export const SESSION_SCOPED_KEY = 'sessionScoped';

/**
 * Mark a route as requiring a specific role
 * @example @RequireRole(ApiKeyRole.ADMIN)
 */
export const RequireRole = (role: ApiKeyRole) => SetMetadata(REQUIRED_ROLE_KEY, role);

/**
 * Mark a controller (or route) whose `:id` route param denotes a WhatsApp session id, so the
 * ApiKeyGuard enforces a key's `allowedSessions` scope against it. Without this, `:id` is treated
 * as an opaque resource id (e.g. an API-key or plugin id) and is NOT used for session scoping —
 * preventing the guard from spuriously denying a session-restricted key on unrelated routes.
 * @example @SessionScoped() @Controller('sessions')
 */
export const SessionScoped = () => SetMetadata(SESSION_SCOPED_KEY, true);

/**
 * Mark a route as public (no API key required)
 * @example @Public()
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Get the current API key from request
 * @example @CurrentApiKey() apiKey: ApiKey
 */
export const CurrentApiKey = createParamDecorator((data: unknown, ctx: ExecutionContext): ApiKey | undefined => {
  const request = ctx.switchToHttp().getRequest<Request & { apiKey?: ApiKey }>();
  return request.apiKey;
});
