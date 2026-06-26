/**
 * Webhooks resource — configure event delivery to external HTTP endpoints.
 *
 * Backed by `src/modules/webhook/webhook.controller.ts`.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { CreateWebhookRequest, UpdateWebhookRequest, WebhookResponse, WebhookTestResult } from '../types.js';

export class WebhooksResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List all webhooks for a session. */
  list(sessionId: string): Promise<WebhookResponse[]> {
    return this.client.request<WebhookResponse[]>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/webhooks`,
    });
  }

  /** Get a single webhook by id. */
  get(sessionId: string, id: string): Promise<WebhookResponse> {
    return this.client.request<WebhookResponse>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/webhooks/${encodeSegment(id)}`,
    });
  }

  /** Create a new webhook. */
  create(sessionId: string, body: CreateWebhookRequest): Promise<WebhookResponse> {
    return this.client.request<WebhookResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/webhooks`,
      body,
    });
  }

  /** Update a webhook. */
  update(sessionId: string, id: string, body: UpdateWebhookRequest): Promise<WebhookResponse> {
    return this.client.request<WebhookResponse>({
      method: 'PUT',
      path: `/api/sessions/${encodeSegment(sessionId)}/webhooks/${encodeSegment(id)}`,
      body,
    });
  }

  /** Delete a webhook. */
  delete(sessionId: string, id: string): Promise<void> {
    return this.client.request<void>({
      method: 'DELETE',
      path: `/api/sessions/${encodeSegment(sessionId)}/webhooks/${encodeSegment(id)}`,
    });
  }

  /** Trigger a test dispatch to the webhook URL and report the result. */
  test(sessionId: string, id: string): Promise<WebhookTestResult> {
    return this.client.request<WebhookTestResult>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/webhooks/${encodeSegment(id)}/test`,
    });
  }
}
