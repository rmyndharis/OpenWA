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
import type {
  ArchiveChatRequest,
  ChatSummary,
  DeleteChatRequest,
  MarkChatRequest,
  ChatPresence,
  SendChatStateRequest,
  SuccessResult,
} from '../types.js';

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

  /**
   * Subscribe to a chat's presence. Updates then arrive as `presence.update` webhook/socket events —
   * presence cannot be fetched from either engine, only received.
   *
   * The subscription belongs to the connection and does NOT survive a restart or an automatic
   * reconnect, so re-issue it when the session comes back. Subscribe per chat: WhatsApp emits an
   * update on every transition, so a broad subscription is a firehose. whatsapp-web.js answers 501.
   */
  subscribePresence(sessionId: string, body: MarkChatRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/presence/subscribe`,
      body,
    });
  }

  /**
   * The last presence reported for a chat, or `null` when none has been — the chat was never
   * subscribed, or nothing has changed since. Held in memory, so a restart clears it.
   */
  getPresence(sessionId: string, chatId: string): Promise<ChatPresence | null> {
    return this.client.request<ChatPresence | null>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/presence/${encodeSegment(chatId)}`,
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

  /**
   * Archive or unarchive a chat. `success: false` means the engine declined — on Baileys a chat
   * with no known history cannot be archived.
   */
  archive(sessionId: string, body: ArchiveChatRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/chats/archive`,
      body,
    });
  }

  /**
   * Delete every message in a chat, keeping the chat itself. `success: false` means the engine
   * declined — an unknown chat, or on Baileys a chat with no known history.
   */
  clearMessages(sessionId: string, chatId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'DELETE',
      path: `/api/sessions/${encodeSegment(sessionId)}/chats/${encodeSegment(chatId)}/messages`,
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
