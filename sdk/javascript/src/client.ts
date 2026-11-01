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
 * // Sessions are addressed by the UUID that create() returns, not by name.
 * const session = await client.sessions.create({ name: 'my-session' });
 * await client.sessions.start(session.id);
 * // Link the account before sending: scan sessions.getQrCode (or use sessions.requestPairingCode for a number with no linked session),
 * // then wait for status 'ready'. An unlinked session answers the send with 409.
 * await client.messages.sendText(session.id, {
 *   chatId: '628123456789@c.us',
 *   text: 'Hello from the OpenWA SDK!',
 * });
 * ```
 *
 * @packageDocumentation
 */

import { request, requestBytes, encodeSegment, hasUnsendableChar, toTimeoutMs, warnIfInsecureHttpUrl, type BinaryResponse, type ClientConfig, type FetchLike, type RequestOptions } from './http.js';
import { CallsResource } from './resources/calls.js';
import { MediaResource } from './resources/media.js';
import { CatalogResource } from './resources/catalog.js';
import { ChannelsResource } from './resources/channels.js';
import { ChatsResource } from './resources/chats.js';
import { ContactsResource } from './resources/contacts.js';
import { GroupsResource } from './resources/groups.js';
import { HealthResource } from './resources/health.js';
import { LabelsResource } from './resources/labels.js';
import { MessagesResource } from './resources/messages.js';
import { ProfileResource } from './resources/profile.js';
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
  /** Per-request timeout in milliseconds (default 30000); `0` or `Infinity` turns it off. */
  timeoutMs?: number;
  /** Default headers applied to every request. */
  defaultHeaders?: Record<string, string>;
  /** Injectable transport; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export class OpenWAClient {
  // Defined non-enumerable in the constructor, so the API key does not appear when a client is logged,
  // inspected or serialized (`declare` keeps the class field from creating an enumerable one).
  private declare readonly config: Required<Omit<ClientConfig, 'fetch'>> & { fetch: FetchLike };

  constructor(options: OpenWAClientOptions) {
    if (!options.baseUrl) throw new Error('OpenWAClient: baseUrl is required');
    // A key read from a secret file usually ends in a newline: trimmed, as the other clients do. A control or
    // non-Latin-1 character left inside is refused here, because fetch's own error quotes the whole value.
    const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : options.apiKey;
    if (!apiKey) throw new Error('OpenWAClient: apiKey is required');
    if (typeof apiKey !== 'string' || hasUnsendableChar(apiKey)) {
      throw new Error('OpenWAClient: apiKey contains a control or non-Latin-1 character; check for a stray newline');
    }
    for (const [name, value] of Object.entries(options.defaultHeaders ?? {})) {
      // fetch trims spaces, tabs and line breaks at both ends of a value, so only what is left can be refused.
      if (hasUnsendableChar(String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ''))) {
        throw new Error(
          `OpenWAClient: defaultHeaders value for "${name}" contains a control or non-Latin-1 character; check for a stray newline`,
        );
      }
    }

    Object.defineProperty(this, 'config', {
      enumerable: false,
      value: {
        baseUrl: options.baseUrl,
        apiKey,
        timeoutMs: toTimeoutMs(options.timeoutMs ?? 30000),
        defaultHeaders: options.defaultHeaders ?? {},
        // Looked up on each call rather than captured here, so a fetch installed on globalThis after
        // the client is built (a polyfill or a test stub) is the one used.
        fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      },
    });

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
  readonly profile = new ProfileResource(this);
  readonly calls = new CallsResource(this);
  readonly media = new MediaResource(this);

  // ── Auth ─────────────────────────────────────────────────────────

  /** Validate the configured API key and resolve its role. */
  auth(): Promise<AuthValidateResponse> {
    return this.request<AuthValidateResponse>({ method: 'POST', path: '/api/auth/validate' });
  }

  // ── Internal API ─────────────────────────────────────────────────

  /** Issue a raw request against the API. (Public for advanced use.) */
  request<T>(options: RequestOptions, idempotencyKey?: string): Promise<T> {
    if (idempotencyKey !== undefined && idempotencyKey !== null) {
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length < 1 ||
        idempotencyKey.length > 255 ||
        /[^\x21-\x7E]/.test(idempotencyKey)
      ) {
        return Promise.reject(new TypeError('OpenWA: idempotencyKey must be 1-255 visible ASCII characters'));
      }
      const headers = { ...options.headers };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'idempotency-key') delete headers[name];
      }
      headers['Idempotency-Key'] = idempotencyKey;
      options = { ...options, headers };
    }
    return request<T>(this.config, options);
  }

  /** Issue a raw request expecting a non-JSON (binary) body. (Public for advanced use.) */
  requestBytes(options: RequestOptions): Promise<BinaryResponse> {
    return requestBytes(this.config, options);
  }

  /**
   * Shared transport helper for image/video/audio/document/sticker sends. Public resource methods
   * expose the narrower per-route request types (including audio-only `ptt`).
   */
  sendMedia(sessionId: string, segment: string, body: SendMediaRequest, idempotencyKey?: string): Promise<MessageResponse> {
    return this.request<MessageResponse>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/messages/${encodeSegment(segment)}`,
      body,
    }, idempotencyKey);
  }
}

export default OpenWAClient;
