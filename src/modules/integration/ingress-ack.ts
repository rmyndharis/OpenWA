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
