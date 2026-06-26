/**
 * Chats resource — chat-list operations (read/unread/delete/typing state).
 *
 * NOTE: these endpoints live under the session controller
 * (`/api/sessions/:id/chats/*`), but are surfaced here as a dedicated resource
 * for clarity.
 *
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { ChatSummary, DeleteChatRequest, MarkChatRequest, SendChatStateRequest, SuccessResult } from '../types.js';

export interface ListChatsQuery {
  limit?: number;
  offset?: number;
}

export class ChatsResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List active chats, most recent first. */
  list(sessionId: string, query?: ListChatsQuery): Promise<ChatSummary[]> {
    return this.client.request<ChatSummary[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/chats`,
      query,
    });
  }

  /** Mark a chat as read/seen. */
  markRead(sessionId: string, body: MarkChatRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/chats/read`,
      body,
    });
  }

  /** Mark a chat as unread. */
  markUnread(sessionId: string, body: MarkChatRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/chats/unread`,
      body,
    });
  }

  /** Delete a chat from the chat list. */
  delete(sessionId: string, body: DeleteChatRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/chats/delete`,
      body,
    });
  }

  /** Send a chat presence state (typing/recording/paused). */
  sendState(sessionId: string, body: SendChatStateRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/chats/typing`,
      body,
    });
  }
}
