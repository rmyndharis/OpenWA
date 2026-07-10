/**
 * OpenWA JavaScript/TypeScript SDK — client core.
 *
 * The {@link OpenWAClient} is the single entry point. It holds configuration
 * (base URL, API key, timeout, injectable transport) and exposes domain
 * resources as properties:
 *
 * ```typescript
 * import { OpenWAClient } from '@rmyndharis/openwa';
 *
 * const client = new OpenWAClient({
 *   baseUrl: 'http://localhost:2785',
 *   apiKey: 'owa_k1_…',
 * });
 *
 * await client.sessions.start('my-session');
 * await client.messages.sendText('my-session', {
 *   chatId: '628123456789@c.us',
 *   text: 'Hello from the OpenWA SDK!',
 * });
 * ```
 *
 * @packageDocumentation
 */

import { request, encodeSegment, warnIfInsecureHttpUrl, type ClientConfig, type FetchLike, type RequestOptions } from './http.js';
import { CatalogResource } from './resources/catalog.js';
import { ChannelsResource } from './resources/channels.js';
import { ChatsResource } from './resources/chats.js';
import { ContactsResource } from './resources/contacts.js';
import { GroupsResource } from './resources/groups.js';
import { HealthResource } from './resources/health.js';
import { LabelsResource } from './resources/labels.js';
import { MessagesResource } from './resources/messages.js';
import { SearchResource } from './resources/search.js';
import { SessionsResource } from './resources/sessions.js';
import { StatusResource } from './resources/status.js';
import { TemplatesResource } from './resources/templates.js';
import { WebhooksResource } from './resources/webhooks.js';
import type { AuthValidateResponse, MessageResponse, SendMediaRequest } from './types.js';

export interface OpenWAClientOptions {
  /** Base URL of the OpenWA API, e.g. `http://localhost:2785`. */
  baseUrl: string;
  /** API key sent as `X-API-Key`. */
  apiKey: string;
  /** Per-request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Default headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export class OpenWAClient {
  private readonly config: Required<Omit<ClientConfig, 'fetch'>> & { fetch: FetchLike };

  constructor(options: OpenWAClientOptions) {
    if (!options.baseUrl) throw new Error('OpenWAClient: baseUrl is required');
    if (!options.apiKey) throw new Error('OpenWAClient: apiKey is required');

    this.config = {
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs ?? 30000,
      defaultHeaders: options.defaultHeaders ?? {},
      fetch: options.fetch ?? globalThis.fetch,
    };

    warnIfInsecureHttpUrl(options.baseUrl);
  }

  // ── Resources ────────────────────────────────────────────────────

  readonly sessions = new SessionsResource(this);
  readonly messages = new MessagesResource(this);
  readonly contacts = new ContactsResource(this);
  readonly groups = new GroupsResource(this);
  readonly webhooks = new WebhooksResource(this);
  readonly chats = new ChatsResource(this);
  readonly status = new StatusResource(this);
  readonly health = new HealthResource(this);
  readonly labels = new LabelsResource(this);
  readonly channels = new ChannelsResource(this);
  readonly catalog = new CatalogResource(this);
  readonly templates = new TemplatesResource(this);
  readonly search = new SearchResource(this);

  // ── Auth ─────────────────────────────────────────────────────────

  /** Validate the configured API key and resolve its role. */
  auth(): Promise<AuthValidateResponse> {
    return this.request<AuthValidateResponse>({ method: 'POST', path: '/api/auth/validate' });
  }

  // ── Internal API ─────────────────────────────────────────────────

  /** Issue a raw request against the API. (Public for advanced use.) */
  request<T>(options: RequestOptions): Promise<T> {
    return request<T>(this.config, options);
  }

  /**
   * Shared media-send helper used by the image/video/audio/document/sticker
   * methods, which all share the {@link SendMediaRequest} shape and only differ
   * by their path segment.
   */
  sendMedia(sessionId: string, segment: string, body: SendMediaRequest): Promise<MessageResponse> {
    return this.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/${segment}`,
      body,
    });
  }
}

export default OpenWAClient;
