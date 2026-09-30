import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiKeyRole } from '../entities/api-key.entity';
import { Request } from 'express';
import { ApiKey } from '../entities/api-key.entity';

export const REQUIRED_ROLE_KEY = 'requiredRole';
export const PUBLIC_KEY = 'isPublic';
export const SESSION_SCOPED_KEY = 'sessionScoped';
export const UNSCOPED_KEY = 'requireUnscopedKey';
export const CHAT_SCOPED_KEY = 'chatScoped';
export const CHAT_QUOTED_ALLOWED_KEY = 'chatQuotedAllowed';

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
 * Mark a controller (or route) as off-limits to session-scoped API keys, regardless of role. The
 * ApiKeyGuard session fence can only compare against a session id carried in the route params, so
 * surfaces with no session dimension at all (e.g. API-key lifecycle management) would otherwise be
 * fully reachable by a scoped key — letting it mint or widen credentials beyond its own confinement.
 * @example @RequireUnscopedKey() @Controller('auth/api-keys')
 */
export const RequireUnscopedKey = () => SetMetadata(UNSCOPED_KEY, true);

/** How a handler is safe for a chat-restricted key. See {@link ChatScoped}. */
export type ChatScopeKind = 'fenced' | 'filtered' | 'agnostic';

/**
 * Mark a handler (or controller) a chat-restricted key — one carrying `allowedChats` — may reach,
 * and say WHICH way it is safe. This is an ALLOWLIST, not a restriction: a chat-restricted key is
 * refused with 403 on every route that is NOT marked, so surfaces with no chat dimension (webhooks,
 * automation rules, status, key management, channels, Bull Board) — and every route added later —
 * stay closed without having to enumerate them.
 *
 * - `'fenced'` — names a chat the ApiKeyGuard inspects: a `:chatId` / `:groupId` / `:contactId`
 *   path param, or a REQUIRED guard-read body field (`chatId` / `fromChatId` / `toChatId` /
 *   `messages[]`). An optional `?chatId=` qualifies only when the handler also calls
 *   `this.chatScope.requireChat(apiKey, chatId)`, which refuses a restricted key that omits it or
 *   sends it blank; on its own the guard would have nothing to check.
 * - `'filtered'` — lists chats instead of naming one, and filters the result through
 *   ChatScopeService.
 * - `'agnostic'` — names no chat and cannot reach one, so the mark itself is the assertion. This is
 *   the one category the structural coverage spec cannot derive (a webhook with `events: ['*']` also
 *   names no chat), so every `'agnostic'` grant must also be listed in the spec's AGNOSTIC_GRANTS.
 *
 * @example @ChatScoped('fenced') @Get(':chatId')
 */
export const ChatScoped = (kind: ChatScopeKind) => SetMetadata(CHAT_SCOPED_KEY, kind);

/**
 * Exempt a handler from the chat fence's blanket refusal of `quotedMessageId`. Only mark a route
 * whose quote is bound to the chat it is sent into: `POST .../messages/reply` requires a
 * `quotedMessageId` and BOTH engines resolve it inside the named chat (Baileys asserts the stored
 * message belongs to it, whatsapp-web.js fetches it from that chat), so the quote cannot name a
 * chat outside the allowlist. Every other route refuses a quote outright, because a quote is a chat
 * reference the guard cannot see.
 */
export const ChatQuotedAllowed = () => SetMetadata(CHAT_QUOTED_ALLOWED_KEY, true);

/**
 * Get the current API key from request
 * @example @CurrentApiKey() apiKey: ApiKey
 */
export const CurrentApiKey = createParamDecorator((data: unknown, ctx: ExecutionContext): ApiKey | undefined => {
  const request = ctx.switchToHttp().getRequest<Request & { apiKey?: ApiKey }>();
  return request.apiKey;
});
