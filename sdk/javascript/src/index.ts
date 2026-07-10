/**
 * OpenWA JavaScript/TypeScript SDK.
 *
 * Official client library for the OpenWA WhatsApp API Gateway.
 *
 * @example
 * ```typescript
 * import { OpenWAClient, OpenWAApiError } from '@rmyndharis/openwa';
 *
 * const client = new OpenWAClient({
 *   baseUrl: 'http://localhost:2785',
 *   apiKey: 'owa_k1_…',
 * });
 *
 * await client.sessions.start('my-session');
 * const result = await client.messages.sendText('my-session', {
 *   chatId: '628123456789@c.us',
 *   text: 'Hello from the OpenWA SDK!',
 * });
 * console.log(result.messageId);
 * ```
 *
 * @packageDocumentation
 */

export { OpenWAClient } from './client.js';
export { default } from './client.js';
export type { OpenWAClientOptions } from './client.js';
export * from './errors.js';
export type * from './types.js';
export type { ClientConfig, FetchLike, HttpMethod, RequestOptions } from './http.js';
export { buildUrl, warnIfInsecureHttpUrl } from './http.js';
