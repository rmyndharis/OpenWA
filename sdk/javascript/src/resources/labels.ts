/**
 * Labels resource — WhatsApp Business chat labels.
 *
 * Backed by `src/modules/label/label.controller.ts` (`@Controller('sessions/:sessionId/labels')`).
 * Labels are a WhatsApp Business feature; the session must be a business account.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { AddLabelRequest, ChatSummary, LabelRecord, SuccessResult, UpsertLabelRequest } from '../types.js';

export class LabelsResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List all labels available in the business account. */
  list(sessionId: string): Promise<LabelRecord[]> {
    return this.client.request<LabelRecord[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/labels`,
    });
  }

  /** Get a single label by id. */
  get(sessionId: string, labelId: string): Promise<LabelRecord> {
    return this.client.request<LabelRecord>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/labels/${encodeSegment(labelId)}`,
    });
  }

  /**
   * Every chat carrying a label. **whatsapp-web.js only** — Baileys has label writes but no label
   * query of any kind, and answers 501.
   */
  chats(sessionId: string, labelId: string): Promise<ChatSummary[]> {
    return this.client.request<ChatSummary[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/labels/${encodeSegment(labelId)}/chats`,
    });
  }

  /**
   * Create or update a label. **Baileys only** — whatsapp-web.js can read and assign labels but
   * cannot edit one, and answers 501.
   *
   * `PUT`, not `POST`, because you choose the id: WhatsApp carries one write keyed on it, so whether
   * this creates or updates depends purely on whether that id already exists. Pick an unused id to
   * create — reusing one rewrites that label rather than failing. Omitted fields are left alone.
   */
  upsert(sessionId: string, labelId: string, body: UpsertLabelRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/labels/${encodeSegment(labelId)}`,
      body,
    });
  }

  /** Delete a label; it disappears from every chat it was on. **Baileys only.** */
  delete(sessionId: string, labelId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'DELETE',
      path: `/api/sessions/${encodeSegment(sessionId)}/labels/${encodeSegment(labelId)}`,
    });
  }

  /** Get the labels currently applied to a chat. */
  forChat(sessionId: string, chatId: string): Promise<LabelRecord[]> {
    return this.client.request<LabelRecord[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/labels/chat/${encodeSegment(chatId)}`,
    });
  }

  /** Add a label to a chat. Requires an OPERATOR-level key. */
  addToChat(sessionId: string, chatId: string, body: AddLabelRequest): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/labels/chat/${encodeSegment(chatId)}`,
      body,
    });
  }

  /** Remove a label from a chat. Requires an OPERATOR-level key. */
  removeFromChat(sessionId: string, chatId: string, labelId: string): Promise<SuccessResult> {
    return this.client.request<SuccessResult>({
      method: 'DELETE',
      path: `/api/sessions/${encodeSegment(sessionId)}/labels/chat/${encodeSegment(chatId)}/${encodeSegment(labelId)}`,
    });
  }
}
