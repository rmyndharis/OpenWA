/**
 * Messages resource — sending and querying messages.
 *
 * Backed by `src/modules/message/message.controller.ts`.
 * NOTE: the real paths use the `/send-` prefix, e.g. `/messages/send-text`.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
  BatchStatusResponse,
  BulkMessageResponse,
  ChatHistoryMessage,
  DeleteMessageRequest,
  ForwardMessageRequest,
  ListMessagesQuery,
  MessageHistoryQuery,
  MessageListResponse,
  MessageResponse,
  ReactionRecord,
  ReactMessageRequest,
  ReplyMessageRequest,
  SendBulkRequest,
  SendContactRequest,
  SendLocationRequest,
  SendMediaRequest,
  SendTemplateRequest,
  SendTextRequest,
  SuccessResult,
} from '../types.js';

export class MessagesResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List messages, optionally filtered by chat or sender. Returns a `{ messages, total }` page. */
  list(sessionId: string, query?: ListMessagesQuery): Promise<MessageListResponse> {
    return this.client.request<MessageListResponse>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages`,
      query,
    });
  }

  /** Send a text message. */
  sendText(sessionId: string, body: SendTextRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-text`,
      body,
    });
  }

  /** Send an image (url or base64). */
  sendImage(sessionId: string, body: SendMediaRequest): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-image', body);
  }

  /** Send a video (url or base64). */
  sendVideo(sessionId: string, body: SendMediaRequest): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-video', body);
  }

  /** Send an audio file (url or base64). */
  sendAudio(sessionId: string, body: SendMediaRequest): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-audio', body);
  }

  /** Send a document (url or base64; `filename` required). */
  sendDocument(sessionId: string, body: SendMediaRequest): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-document', body);
  }

  /** Send a sticker (url or base64). */
  sendSticker(sessionId: string, body: SendMediaRequest): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-sticker', body);
  }

  /** Send a location. */
  sendLocation(sessionId: string, body: SendLocationRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-location`,
      body,
    });
  }

  /** Send a contact card. */
  sendContact(sessionId: string, body: SendContactRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-contact`,
      body,
    });
  }

  /** Render and send a stored message template. */
  sendTemplate(sessionId: string, body: SendTemplateRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-template`,
      body,
    });
  }

  /** Reply to a specific message. */
  reply(sessionId: string, body: ReplyMessageRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/reply`,
      body,
    });
  }

  /** Forward a message to another chat. */
  forward(sessionId: string, body: ForwardMessageRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/forward`,
      body,
    });
  }

  /** React to a message (empty `emoji` removes the reaction). */
  react(sessionId: string, body: ReactMessageRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/react`,
      body,
    });
  }

  /** Delete a message. */
  delete(sessionId: string, body: DeleteMessageRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/delete`,
      body,
    });
  }

  /** Get the message history for a chat (read live from WhatsApp). */
  history(sessionId: string, chatId: string, query?: MessageHistoryQuery): Promise<ChatHistoryMessage[]> {
    return this.client.request<ChatHistoryMessage[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/${encodeSegment(chatId)}/history`,
      query,
    });
  }

  /** Get reactions for a specific message. */
  reactions(sessionId: string, chatId: string, messageId: string): Promise<ReactionRecord[]> {
    return this.client.request<ReactionRecord[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/${encodeSegment(chatId)}/${encodeSegment(messageId)}/reactions`,
    });
  }

  /**
   * Send a batch of messages asynchronously. Returns HTTP 202 with a batch id;
   * poll the status via {@link batchStatus}.
   */
  sendBulk(sessionId: string, body: SendBulkRequest): Promise<BulkMessageResponse> {
    return this.client.request<BulkMessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-bulk`,
      body,
    });
  }

  /** Poll the status/progress of a bulk send batch. */
  batchStatus(sessionId: string, batchId: string): Promise<BatchStatusResponse> {
    return this.client.request<BatchStatusResponse>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/batch/${encodeSegment(batchId)}`,
    });
  }

  /** Cancel a running batch. Requires an OPERATOR-level key. */
  cancelBatch(sessionId: string, batchId: string): Promise<BatchStatusResponse> {
    return this.client.request<BatchStatusResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/batch/${encodeSegment(batchId)}/cancel`,
    });
  }
}
