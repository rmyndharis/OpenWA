import { createHmac, timingSafeEqual } from 'node:crypto';
import { IngressSignatureSpec } from '../../core/plugins/plugin.interfaces';

export interface VerifyInput {
  rawBody: string;
  headers: Record<string, string>; // lower-cased keys
  secret: string;
  now: number; // ms epoch (injected so replay tests are deterministic — never Date.now() in here)
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

  // hmac-sha256
  const template = spec.contentTemplate ?? '{rawBody}';
  const signedContent = template
    .replace('{rawBody}', input.rawBody)
    .replace('{timestamp}', header(input.headers, spec.timestampHeader) ?? '');
  const digest = createHmac('sha256', input.secret)
    .update(signedContent)
    .digest(spec.encoding ?? 'hex');
  const expected = (spec.prefix ?? '') + digest;
  return safeEqualStr(provided, expected) ? { ok: true } : { ok: false, reason: 'hmac mismatch' };
}

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
