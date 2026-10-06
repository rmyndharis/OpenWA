import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ZodError } from 'zod';
import { containsNul } from '../../common/validation/no-nul-character';
import type { AuthService } from '../../modules/auth/auth.service';
import type { ChatScopeService } from '../../modules/auth/chat-scope.service';
import type { AnyToolDescriptor } from './tool-descriptor';

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
 * @param onAuthFailure Optional callback invoked with the error when the AUTH
 * phase rejects (missing/invalid/revoked/expired key, wrong role, IP/session not
 * allowed). Chat argument checks run after parsing so normalized values remain
 * authorized. Handler errors do not reach this callback. Re-thrown after it.
 */
export async function invokeTool(
  tool: AnyToolDescriptor,
  rawInput: unknown,
  rawKey: string | undefined,
  authService: AuthService,
  onAuthenticated?: (apiKeyId: string) => void,
  onAuthFailure?: (error: unknown) => void,
  chatScope?: ChatScopeService,
): Promise<unknown> {
  // AUTH PHASE — every rejection here is an authentication/authorization failure (the MCP analog of the
  // REST ApiKeyGuard's authorize()). Wrapped so onAuthFailure can record the audit trail at the boundary.
  let apiKey: Awaited<ReturnType<typeof authService.validateApiKey>>;
  try {
    if (!rawKey) {
      throw new UnauthorizedException('Missing API key');
    }
    // Pre-extract sessionId for the scope check BEFORE full validation (REST reads
    // req.params.sessionId in the guard, before the pipe).
    const probe = (rawInput ?? {}) as Record<string, unknown>;
    const sessionId = tool.sessionScoped && typeof probe.sessionId === 'string' ? probe.sessionId : undefined;

    // Fail closed: a sessionScoped tool MUST carry a non-empty sessionId before auth. Otherwise an
    // undefined scope would skip the per-key allowedSessions check inside validateApiKey, letting a
    // session-restricted key drive the tool against any session. This enforces the fence at the runtime
    // boundary regardless of an individual tool's input schema.
    if (tool.sessionScoped && !sessionId) {
      throw new BadRequestException('sessionId is required for this tool');
    }

    apiKey = await authService.validateApiKey(rawKey, undefined, sessionId);
    onAuthenticated?.(apiKey.id);

    if (tool.requiredRole && !authService.hasPermission(apiKey, tool.requiredRole)) {
      throw new ForbiddenException('API key lacks the required role');
    }

    // Restricted keys may reach only explicitly fenced, filtered or chat-independent tools.
    if ((apiKey.allowedChats?.length ?? 0) > 0 && (!tool.chatScope || !chatScope)) {
      throw new ForbiddenException('API key is restricted to selected chats');
    }
  } catch (error) {
    // auditMcpAuthFailure (the only current caller hook) filters to 401/403, so the BadRequestException
    // for a missing sessionId above is NOT audited (parity with the REST guard, which skips 400s).
    onAuthFailure?.(error);
    throw error;
  }

  // Validate before checking chat arguments; validation errors are not auth failures.
  let input: unknown;
  try {
    input = tool.inputSchema.parse(rawInput);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new BadRequestException(e.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`));
    }
    throw e;
  }
  // PostgreSQL rejects U+0000 in every text parameter; REST refuses the same input in NulBodyPipe.
  if (containsNul(input)) throw new BadRequestException('Tool input must not contain a NUL character');
  if (chatScope?.isRestricted(apiKey)) {
    try {
      // Inspect the parsed values, so schema normalization cannot change the authorized target.
      const values = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      if (typeof tool.chatScope !== 'string') {
        const fields = tool.chatScope ?? [];
        if (fields.length === 0) throw new ForbiddenException('API key is restricted to selected chats');
        for (const field of fields) {
          const chatId = values[field];
          if (typeof chatId !== 'string' || !chatId.trim()) {
            throw new ForbiddenException(`${field} is required for a key restricted to selected chats`);
          }
          if (!(await chatScope.allows(apiKey, chatId))) {
            throw new ForbiddenException('API key not authorized for this chat');
          }
        }
      }
      const quote = values.quotedMessageId;
      if (!tool.chatQuotedAllowed && quote !== undefined && quote !== null && quote !== '') {
        throw new ForbiddenException('API key is restricted to selected chats');
      }
    } catch (error) {
      onAuthFailure?.(error);
      throw error;
    }
  }
  // The single cast the erasure needs, placed next to the parse that justifies it: `input` is
  // whatever this tool's own `inputSchema` just accepted, which is exactly what its handler declares.
  return tool.handler(input as never, apiKey, chatScope);
}
