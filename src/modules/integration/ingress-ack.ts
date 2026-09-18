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
  const result: AckResult = { status: spec.status ?? 202 };
  if (spec.body !== undefined) {
    result.body = substitute(spec.body, ctx);
  }
  if (spec.headers) result.headers = { ...spec.headers };
  return result;
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
  if (!declared) return 'text/plain';
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
