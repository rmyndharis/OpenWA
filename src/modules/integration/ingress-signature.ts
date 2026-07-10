import { createHmac, timingSafeEqual } from 'node:crypto';
import { IngressSignatureSpec } from '../../core/plugins/plugin.interfaces';

export interface VerifyInput {
  rawBody: string;
  headers: Record<string, string>; // lower-cased keys
  secret: string;
  now: number; // ms epoch (injected so replay tests are deterministic — never Date.now() in here)
  // The integration instance id (from the request path). Substituted into `{id}` in the contentTemplate
  // — a provider that mixes the webhook/instance id into its signature base string (e.g. `{id}.{timestamp}.{rawBody}`)
  // would otherwise be silently 401'd. Always available at the runtime call site.
  instanceId: string;
}

function header(headers: Record<string, string>, name?: string): string | undefined {
  if (!name) return undefined;
  return headers[name.toLowerCase()];
}

/**
 * Inverts the outbound signer (webhook.service.ts:527-531) — but over the provider's declared
 * contentTemplate applied to the RAW request bytes, and with a constant-time compare. `now` is
 * injected so the replay-window check is deterministic in tests.
 */
export function verifyIngressSignature(
  spec: IngressSignatureSpec,
  input: VerifyInput,
): { ok: boolean; reason?: string } {
  if (spec.scheme === 'none') return { ok: true };
  if (!input.secret) return { ok: false, reason: 'empty ingress secret' };

  if (spec.timestampHeader) {
    const tsRaw = header(input.headers, spec.timestampHeader);
    const ts = Number.parseInt(tsRaw ?? '', 10);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'missing/invalid timestamp' };
    const skewSec = Math.abs(input.now / 1000 - ts);
    if (!(spec.toleranceSec && skewSec <= spec.toleranceSec)) {
      return { ok: false, reason: 'replay: timestamp outside tolerance' };
    }
  }

  const provided = header(input.headers, spec.header);
  if (!provided) return { ok: false, reason: 'missing signature header' };

  if (spec.scheme === 'shared-secret') {
    return safeEqualStr(provided, input.secret) ? { ok: true } : { ok: false, reason: 'shared-secret mismatch' };
  }

  // hmac-sha256. Substitute the template tokens in a SINGLE pass with a function replacer: a string
  // replacement would (a) only replace the first occurrence and (b) interpret $&, $`, $', $$, $n in the
  // replacement (the attacker-controlled rawBody), so a body containing a `$`-sequence would diverge the
  // signed bytes from the provider's and reject a legitimately-signed delivery. The function form inserts
  // each value literally and, because rawBody is substituted (not re-scanned), a `{timestamp}` or `{id}`
  // embedded in the body is never re-interpreted. `{id}` resolves to the integration instance id — the only
  // identifier the host has at verify time for a provider that mixes the webhook/instance id into its sig.
  const template = spec.contentTemplate ?? '{rawBody}';
  const timestamp = header(input.headers, spec.timestampHeader) ?? '';
  const signedContent = template.replace(/\{rawBody\}|\{timestamp\}|\{id\}/g, token =>
    token === '{rawBody}' ? input.rawBody : token === '{timestamp}' ? timestamp : input.instanceId,
  );
  const digest = createHmac('sha256', input.secret)
    .update(signedContent)
    .digest(spec.encoding ?? 'hex');
  const expected = (spec.prefix ?? '') + digest;
  return safeEqualStr(provided, expected) ? { ok: true } : { ok: false, reason: 'hmac mismatch' };
}

export function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
