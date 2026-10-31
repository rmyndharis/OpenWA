/**
 * Messages resource — sending and querying messages.
 *
 * Backed by `src/modules/message/message.controller.ts`.
 * NOTE: the real paths use the `/send-` prefix, e.g. `/messages/send-text`.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { BinaryResponse } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
  BatchCancelResponse,
  BatchStatusResponse,
  BulkMessageResponse,
  ChatHistoryMessage,
  ClickButtonRequest,
  DeleteMessageRequest,
  EditMessageRequest,
  ForwardMessageRequest,
  ListMessagesQuery,
  MessageHistoryQuery,
  MessageListResponse,
  MessageResponse,
  PinMessageRequest,
  ReactionRecord,
  ReactMessageRequest,
  ReplyMessageRequest,
  SendBulkRequest,
  SendContactRequest,
  SendLocationRequest,
  SendAudioRequest,
  SendMediaRequest,
  StarMessageRequest,
  UnpinMessageRequest,
  VotePollRequest,
  SendPollRequest,
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
  sendText(sessionId: string, body: SendTextRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-text`,
      body,
    }, idempotencyKey);
  }

  /** Send an image (url or base64). */
  sendImage(sessionId: string, body: SendMediaRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-image', body, idempotencyKey);
  }

  /** Send a video (url or base64). */
  sendVideo(sessionId: string, body: SendMediaRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-video', body, idempotencyKey);
  }

  /** Send an audio file (url or base64). */
  sendAudio(sessionId: string, body: SendAudioRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-audio', body, idempotencyKey);
  }

  /**
   * Send a document (url or base64). `filename` is optional and is the name the recipient sees;
   * without it the gateway uses `"file"`, or the URL basename for a URL send on whatsapp-web.js.
   */
  sendDocument(sessionId: string, body: SendMediaRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-document', body, idempotencyKey);
  }

  /** Send a sticker (url or base64). */
  sendSticker(sessionId: string, body: SendMediaRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.sendMedia(sessionId, 'send-sticker', body, idempotencyKey);
  }

  /** Send a location. */
  sendLocation(sessionId: string, body: SendLocationRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-location`,
      body,
    }, idempotencyKey);
  }

  /** Send a contact card. */
  sendContact(sessionId: string, body: SendContactRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-contact`,
      body,
    }, idempotencyKey);
  }

  /** Render and send a stored message template. */
  sendTemplate(sessionId: string, body: SendTemplateRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-template`,
      body,
    }, idempotencyKey);
  }

  /** Send a native WhatsApp poll (2–12 options). */
  sendPoll(sessionId: string, body: SendPollRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/send-poll`,
      body,
    }, idempotencyKey);
  }

  /** Reply to a specific message. */
  reply(sessionId: string, body: ReplyMessageRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/reply`,
      body,
    }, idempotencyKey);
  }

  /**
   * Click a button on a WhatsApp Business prompt. Baileys only (whatsapp-web.js returns 501).
   * Sends a structured reply proto quoted to the prompt, not a native UI tap.
   */
  clickButton(sessionId: string, body: ClickButtonRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/click-button`,
      body,
    });
  }

  /** Forward a message to another chat. */
  forward(sessionId: string, body: ForwardMessageRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/forward`,
      body,
    }, idempotencyKey);
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

  /** Edit the text of an own message (404 if the message is not found). */
  editMessage(sessionId: string, body: EditMessageRequest): Promise<MessageResponse> {
    return this.client.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/edit`,
      body,
    });
  }

  /** Get the message history for a chat (read live from WhatsApp). **whatsapp-web.js only**: Baileys answers 501. */
  history(sessionId: string, chatId: string, query?: MessageHistoryQuery): Promise<ChatHistoryMessage[]> {
    return this.client.request<ChatHistoryMessage[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/${encodeSegment(chatId)}/history`,
      query,
    });
  }

  /** Get reactions for a specific message. **whatsapp-web.js only**: Baileys answers 501. */
  reactions(sessionId: string, chatId: string, messageId: string): Promise<ReactionRecord[]> {
    return this.client.request<ReactionRecord[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/${encodeSegment(chatId)}/${encodeSegment(messageId)}/reactions`,
    });
  }

  /**
   * Pin a message in its chat. `durationSeconds` must be 86400 (24h), 604800 (7d) or 2592000
   * (30d); it defaults to 24h server-side. In a group only admins may pin.
   */
  pin(sessionId: string, body: PinMessageRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/pin`,
      body,
    });
  }

  /**
   * Cast a vote on a poll. Not supported on the Baileys engine (501).
   * `options` are the option texts, not ids.
   */
  votePoll(sessionId: string, body: VotePollRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/vote-poll`,
      body,
    });
  }

  /**
   * Star or unstar a message. Best-effort on whatsapp-web.js: it silently ignores a message it
   * will not star, so a resolved call is not proof the star is set.
   */
  star(sessionId: string, body: StarMessageRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/star`,
      body,
    });
  }

  /** Remove a message's pin. */
  unpin(sessionId: string, body: UnpinMessageRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/unpin`,
      body,
    });
  }

  /**
   * Fetch a message's stored media bytes: the archived file when one exists, else the inline copy
   * on the message row — which covers media sent by this account; 404 when neither holds bytes.
   */
  media(sessionId: string, chatId: string, messageId: string): Promise<BinaryResponse> {
    return this.client.requestBytes({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/${encodeSegment(chatId)}/${encodeSegment(messageId)}/media`,
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
  cancelBatch(sessionId: string, batchId: string): Promise<BatchCancelResponse> {
    return this.client.request<BatchCancelResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/batch/${encodeSegment(batchId)}/cancel`,
    });
  }
}
