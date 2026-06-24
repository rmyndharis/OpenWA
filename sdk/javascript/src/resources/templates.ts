/**
 * Templates resource — stored message templates with `{{variable}}` placeholders.
 *
 * Backed by `src/modules/template/template.controller.ts`.
 * @packageDocumentation
 */

import type { OpenWAClient } from '../client.js';
import type { CreateTemplateRequest, TemplateRecord, UpdateTemplateRequest } from '../types.js';

export class TemplatesResource {
  constructor(private readonly client: OpenWAClient) {}

  /** List all templates for a session. */
  list(sessionId: string): Promise<TemplateRecord[]> {
    return this.client.request<TemplateRecord[]>({
      method: 'GET',
      path: `/api/sessions/${sessionId}/templates`,
    });
  }

  /** Get a single template by id. */
  get(sessionId: string, id: string): Promise<TemplateRecord> {
    return this.client.request<TemplateRecord>({
      method: 'GET',
      path: `/api/sessions/${sessionId}/templates/${id}`,
    });
  }

  /** Create a new template. */
  create(sessionId: string, body: CreateTemplateRequest): Promise<TemplateRecord> {
    return this.client.request<TemplateRecord>({
      method: 'POST',
      path: `/api/sessions/${sessionId}/templates`,
      body,
    });
  }

  /** Update a template. */
  update(sessionId: string, id: string, body: UpdateTemplateRequest): Promise<TemplateRecord> {
    return this.client.request<TemplateRecord>({
      method: 'PUT',
      path: `/api/sessions/${sessionId}/templates/${id}`,
      body,
    });
  }

  /** Delete a template. */
  delete(sessionId: string, id: string): Promise<void> {
    return this.client.request<void>({
      method: 'DELETE',
      path: `/api/sessions/${sessionId}/templates/${id}`,
    });
  }
}
