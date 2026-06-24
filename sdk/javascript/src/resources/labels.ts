/**
 * Labels resource — WhatsApp Business chat labels.
 *
 * Backed by `src/modules/label/label.controller.ts` (`@Controller('sessions/:sessionId/labels')`).
 * Labels are a WhatsApp Business feature; the session must be a business account.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { AddLabelRequest, LabelRecord, SuccessResult } from '../types.js';

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
