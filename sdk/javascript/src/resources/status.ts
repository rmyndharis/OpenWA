/**
 * Status (Stories) resource — WhatsApp status updates.
 *
 * Backed by `src/modules/status/status.controller.ts`.
 * NOTE: this is WhatsApp "Status/Stories", distinct from session lifecycle status.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { SendImageStatusRequest, SendTextStatusRequest, SendVideoStatusRequest, StatusRecord } from '../types.js';

export class StatusResource {
  constructor(private readonly client: OpenWAClient) {}

  /** Get all status updates. */
  list(sessionId: string): Promise<{ statuses: StatusRecord[] }> {
    return this.client.request<{ statuses: StatusRecord[] }>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/status`,
    });
  }

  /** Get status updates from a specific contact. */
  fromContact(sessionId: string, contactId: string): Promise<{ statuses: StatusRecord[] }> {
    return this.client.request<{ statuses: StatusRecord[] }>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/${encodeSegment(contactId)}`,
    });
  }

  /** Post a text status update. */
  sendText(sessionId: string, body: SendTextStatusRequest): Promise<StatusRecord> {
    return this.client.request<StatusRecord>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/send-text`,
      body,
    });
  }

  /** Post an image status update. */
  sendImage(sessionId: string, body: SendImageStatusRequest): Promise<StatusRecord> {
    return this.client.request<StatusRecord>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/send-image`,
      body,
    });
  }

  /** Post a video status update. */
  sendVideo(sessionId: string, body: SendVideoStatusRequest): Promise<StatusRecord> {
    return this.client.request<StatusRecord>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/send-video`,
      body,
    });
  }

  /** Delete a status update by id. */
  delete(sessionId: string, statusId: string): Promise<void> {
    return this.client.request<void>({
      method: 'DELETE',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/${encodeSegment(statusId)}`,
    });
  }
}
