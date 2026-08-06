/**
 * Status (Stories) resource — WhatsApp status updates.
 *
 * Backed by `src/modules/status/status.controller.ts`.
 * NOTE: this is WhatsApp "Status/Stories", distinct from session lifecycle status.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { BinaryResponse } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type {
  SendImageStatusRequest,
  SendTextStatusRequest,
  SendVideoStatusRequest,
  SendVoiceStatusRequest,
  StatusRecord,
  StatusResult,
} from '../types.js';

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

  /** Fetch the stored media bytes for a status update (404 when there is no stored media). */
  media(sessionId: string, statusId: string): Promise<BinaryResponse> {
    return this.client.requestBytes({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/${encodeSegment(statusId)}/media`,
    });
  }

  /** Post a text status update. */
  sendText(sessionId: string, body: SendTextStatusRequest): Promise<StatusResult> {
    return this.client.request<StatusResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/send-text`,
      body,
    });
  }

  /** Post an image status update. */
  sendImage(sessionId: string, body: SendImageStatusRequest): Promise<StatusResult> {
    return this.client.request<StatusResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/send-image`,
      body,
    });
  }

  /** Post a video status update. */
  sendVideo(sessionId: string, body: SendVideoStatusRequest): Promise<StatusResult> {
    return this.client.request<StatusResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/send-video`,
      body,
    });
  }

  /**
   * Post an audio status as a voice note. No caption: WhatsApp has nowhere to render one.
   *
   * WhatsApp plays a status voice note only as Ogg/Opus and neither engine transcodes, so convert
   * first with `media.convertVoice` and post the base64 it returns. Requires an OPERATOR key.
   */
  sendVoice(sessionId: string, body: SendVoiceStatusRequest): Promise<StatusResult> {
    return this.client.request<StatusResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/status/send-voice`,
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
