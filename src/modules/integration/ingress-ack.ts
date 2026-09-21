import type { IngressResponseContract } from '../../core/plugins/plugin.interfaces';

export interface AckRenderCtx {
  rawBody: string;
  timestamp: string; // epoch seconds, as a string for substitution
  id: string; // delivery id
}

export type AckResult = { status: number; body?: string; headers?: Record<string, string> };

/**
 * Renders the synchronous ack for an inbound route, computed entirely host-side. `spec` is the route's
 * `response.ack` (undefined → the default 202 'accepted'). The body may interpolate `{rawBody}`,
 * `{timestamp}`, `{id}` from the VERIFIED request. Uses split/join (never String.replace with a string
 * pattern, which would interpret `$&`/`$1` in provider-controlled bytes). Total: never throws — on any
 * unexpected input it falls back to the declared literal.
 */
export function renderAck(spec: IngressResponseContract['ack'] | undefined, ctx: AckRenderCtx): AckResult {
  if (!spec) return { status: 202, body: 'accepted' };
  const result: AckResult = { status: typeof spec.status === 'number' ? spec.status : 202 };
  // validateIngressManifest rejects a non-string body, a non-string header value and a non-integer
  // status, so these guards are the second line rather than the first: this function is documented
  // as total, and it is also reachable from a built-in manifest and from a test fixture that never
  // went through the loader. On a shape the loader would have refused, fall back rather than throw.
  if (typeof spec.body === 'string') {
    result.body = substitute(spec.body, ctx);
  }
  if (spec.headers && typeof spec.headers === 'object') {
    result.headers = Object.fromEntries(Object.entries(spec.headers).filter(([, v]) => typeof v === 'string'));
  }
  return result;
}

/**
 * Header names a route's declared ack may never write. Three groups, all plugin-authored and landing
 * on the gateway's own origin, so none of them may undo what the app sets for every response:
 *
 *  - `content-type`, decided by {@link ackContentType} immediately after;
 *  - the framing and encoding headers, which decide how the response is delimited and decoded. The
 *    host frames the ack itself and never compresses it, so a declared `Content-Encoding: gzip`
 *    describes bytes the ack does not carry and the provider's client fails to decode it, while a
 *    declared `Transfer-Encoding` makes Node re-frame a body it has already given a length, and a
 *    declared `Trailer` makes it refuse to write the response at all. `content-length` is inert,
 *    Express overwrites it, and is fenced with the rest rather than reasoned about separately;
 *  - the browser-facing protections that make a reflected ack body safe in the first place.
 *
 * Anything else a manifest declares still goes out verbatim.
 */
const RESERVED_ACK_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'transfer-encoding',
  'content-encoding',
  'trailer',
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'strict-transport-security',
  'referrer-policy',
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
]);

/** The subset of a declared ack's headers that may reach the wire. Total. */
export function safeAckHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => typeof value === 'string' && !RESERVED_ACK_HEADERS.has(name.toLowerCase()),
    ),
  );
}

/**
 * Media types a route's declared ack Content-Type may actually put on the wire. Express types a bare
 * send() as text/html, which would make a reflected body (a GET challenge echo, an ack template
 * interpolating {rawBody}) XSS material on this origin. A declared type is therefore honored only when
 * a browser will not execute it, and anything else falls back to text/plain. `noSniff` (configure-app)
 * stops a browser re-sniffing an honored type as HTML. Providers that validate the ack need
 * application/json (Supabase Auth rejects a 200 or 202 that is not), and nothing needs more than that.
 */
const HONORED_ACK_MEDIA_TYPES = new Set(['application/json', 'text/plain']);

/** The Content-Type to emit for an ack: the declared value when allowlisted, else text/plain. Total. */
export function ackContentType(headers: Record<string, string> | undefined): string {
  const declared = headers
    ? Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    : undefined;
  if (typeof declared !== 'string' || !declared) return 'text/plain';
  const mediaType = declared.split(';', 1)[0].trim().toLowerCase();
  return HONORED_ACK_MEDIA_TYPES.has(mediaType) ? declared : 'text/plain';
}

function substitute(template: string, ctx: AckRenderCtx): string {
  // split/join avoids `$`-interpretation that String.replace applies to the replacement string.
  return template
    .split('{rawBody}')
    .join(ctx.rawBody)
    .split('{timestamp}')
    .join(ctx.timestamp)
    .split('{id}')
    .join(ctx.id);
}
