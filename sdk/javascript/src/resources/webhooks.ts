/**
 * Webhooks resource — configure event delivery to external HTTP endpoints.
 *
 * Backed by `src/modules/webhook/webhook.controller.ts`.
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { CreateWebhookRequest, UpdateWebhookRequest, WebhookResponse, WebhookTestResult } from '../types.js';

/** Pagination for the cross-session webhook list and the delivery-failure log. */
export interface WebhookListQuery {
  limit?: number;
  offset?: number;
}

/** Filter for {@link WebhooksResource.deliveryFailures}. */
export interface DeliveryFailureQuery extends WebhookListQuery {
  sessionId?: string;
}

export class WebhooksResource {
  constructor(private readonly client: OpenWAClient) {}

  /**
   * List webhooks across EVERY session the key can see, not one session's. Requires an OPERATOR-level
   * key.
   */
  listAll(query?: WebhookListQuery): Promise<WebhookResponse[]> {
    return this.client.request<WebhookResponse[]>({ method: 'GET', path: '/api/webhooks', query });
  }

  /**
   * Deliveries that were attempted and failed — the diagnostic to reach for when a webhook stopped
   * arriving. Requires an ADMIN-level key.
   *
   * Note it records deliveries that were ATTEMPTED: a delivery a smart filter suppressed never reaches
   * this log. The response has no published schema, so it is returned unshaped.
   */
  deliveryFailures(query?: DeliveryFailureQuery): Promise<unknown> {
    return this.client.request<unknown>({ method: 'GET', path: '/api/webhooks/delivery-failures', query });
  }

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
