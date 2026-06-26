import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ZodError } from 'zod';
import type { AuthService } from '../../modules/auth/auth.service';
import type { ToolDescriptor } from './tool-descriptor';

/**
 * Run one tool call with REST-equivalent guarantees, reusing core's own auth:
 * auth (role + allowedSessions + IP fail-closed) → validate input → handler.
 * Mirrors the REST guard-then-pipe order (auth before validation).
 * `clientIp` is undefined over MCP — a key with allowedIps therefore fails closed
 * inside validateApiKey (documented limitation).
 *
 * @param onAuthenticated Optional callback invoked with `apiKey.id` immediately
 * after `validateApiKey` succeeds and BEFORE role/input checks. Use this to
 * key rate-limiters off the authenticated identity rather than the raw header
 * string, preventing pre-auth bucket allocation by anonymous callers.
 */
export async function invokeTool(
  tool: ToolDescriptor,
  rawInput: unknown,
  rawKey: string | undefined,
  authService: AuthService,
  onAuthenticated?: (apiKeyId: string) => void,
): Promise<unknown> {
  if (!rawKey) {
    throw new UnauthorizedException('Missing API key');
  }
  // Pre-extract sessionId for the scope check BEFORE full validation (REST reads
  // req.params.sessionId in the guard, before the pipe).
  const probe = (rawInput ?? {}) as Record<string, unknown>;
  const sessionId = tool.sessionScoped && typeof probe.sessionId === 'string' ? probe.sessionId : undefined;

  const apiKey = await authService.validateApiKey(rawKey, undefined, sessionId);
  onAuthenticated?.(apiKey.id);

  if (tool.requiredRole && !authService.hasPermission(apiKey, tool.requiredRole)) {
    throw new ForbiddenException('API key lacks the required role');
  }

  let input: unknown;
  try {
    input = tool.inputSchema.parse(rawInput);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new BadRequestException(e.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`));
    }
    throw e;
  }
  return tool.handler(input, apiKey);
}
