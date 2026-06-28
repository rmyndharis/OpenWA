import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { ChatState } from '../../../engine/interfaces/whatsapp-engine.interface';
import type { SessionService } from '../../../modules/session/session.service';
import { SessionResponseDto } from '../../../modules/session/dto/session-response.dto';
import type { ToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');

export function sessionTools(session: SessionService): ToolDescriptor[] {
  return [
    {
      name: 'SessionFindAll',
      description:
        'List the WhatsApp sessions this API key may access (id, name, status). Use to discover available sessions before calling session-scoped tools. Supports limit/offset paging.',
      tier: 'read',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: (input: { limit?: number; offset?: number }, apiKey) =>
        session
          .findAll(apiKey.allowedSessions, { limit: input.limit, offset: input.offset })
          .then(ss => ss.map(s => SessionResponseDto.fromEntity(s))),
    },
    {
      name: 'SessionFindOne',
      description: 'Get one session by its UUID, including connection status and phone number.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({ sessionId }),
      handler: (input: { sessionId: string }) =>
        session.findOne(input.sessionId).then(s => SessionResponseDto.fromEntity(s)),
    },
    {
      name: 'SessionGetChats',
      description: 'List recent chats for a session (most recent first). Use limit/offset to page through large lists.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: (input: { sessionId: string; limit?: number; offset?: number }) =>
        session.getChats(input.sessionId, { limit: input.limit, offset: input.offset }),
    },
    {
      name: 'SessionGetStats',
      description: 'Aggregate session counts (total, active, ready, disconnected) the key is allowed to see.',
      tier: 'read',
      inputSchema: z.object({}),
      handler: (_input, apiKey) => session.getStats(apiKey.allowedSessions),
    },
    {
      name: 'SessionMarkChatRead',
      description: 'Mark a chat as read (clears unread count). Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID (e.g. 1234567890@c.us)'),
      }),
      handler: (input: { sessionId: string; chatId: string }) =>
        session.sendSeen(input.sessionId, input.chatId).then(success => ({ success })),
    },
    {
      name: 'SessionMarkChatUnread',
      description: 'Mark a chat as unread. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID (e.g. 1234567890@c.us)'),
      }),
      handler: (input: { sessionId: string; chatId: string }) =>
        session.markUnread(input.sessionId, input.chatId).then(success => ({ success })),
    },
    {
      name: 'SessionSendChatState',
      description: "Show a typing/recording indicator in a chat, or clear it with 'paused'. Requires OPERATOR role.",
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID (e.g. 1234567890@c.us)'),
        state: z
          .enum(['typing', 'recording', 'paused'])
          .describe("'typing' or 'recording' shows the indicator; 'paused' clears it"),
      }),
      handler: (input: { sessionId: string; chatId: string; state: ChatState }) =>
        session.sendChatState(input.sessionId, input.chatId, input.state).then(() => ({ success: true })),
    },
  ];
}
