import { createHmac, timingSafeEqual } from 'node:crypto';

/** Identifies the peer node that forwarded an inter-node request. */
export const FORWARDED_HOP_HEADER = 'x-openwa-forwarded';
/** Millisecond epoch timestamp at which the forwarding node signed the hop. */
export const FORWARDED_HOP_TS_HEADER = 'x-openwa-forwarded-ts';
/** Hex-encoded HMAC-SHA256 signature over length-prefixed `(ts, nodeId, METHOD, path)`. */
export const FORWARDED_HOP_SIG_HEADER = 'x-openwa-forwarded-sig';
/** Default maximum clock skew accepted when verifying a forwarded hop timestamp. */
export const DEFAULT_FORWARDED_HOP_MAX_SKEW_MS = 30_000;

const INTEGER_MS_PATTERN = /^\d+$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_FIELD_CHARS = /[\r\n\0]/;

export type ForwardedHopHeaders = {
  [FORWARDED_HOP_HEADER]: string;
  [FORWARDED_HOP_TS_HEADER]: string;
  [FORWARDED_HOP_SIG_HEADER]: string;
};

export interface SignForwardedHopInput {
  secret: string;
  nodeId: string;
  method: string;
  path: string;
  nowMs?: number;
}

export interface VerifyForwardedHopInput {
  secret?: string;
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
  nowMs?: number;
  maxSkewMs?: number;
}

/**
 * Unambiguous length-prefixed framing for the HMAC input so delimiter characters
 * in `nodeId` or `path` (such as `.`) can never create cross-field collisions.
 */
function buildSignaturePayload(ts: string, nodeId: string, method: string, path: string): string {
  return [ts, nodeId, method.toUpperCase(), path].map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('\n');
}

function hasForbiddenFieldChars(value: string): boolean {
  return FORBIDDEN_FIELD_CHARS.test(value);
}

/**
 * Read a single non-empty header value case-insensitively.
 * Rejects multi-value arrays and duplicate keys differing only by case (fail-closed).
 */
function readSingleHeader(
  headers: Record<string, string | string[] | undefined>,
  targetName: string,
): string | undefined {
  let found: string | undefined;
  let seenCount = 0;

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== targetName) continue;
    seenCount++;
    if (seenCount > 1 || typeof value !== 'string' || value.length === 0) {
      return undefined;
    }
    found = value;
  }

  return found;
}

/**
 * Compute authenticated inter-node forwarding headers for one HTTP hop.
 * Throws if `secret` or `nodeId` is empty so unsigned hops are never emitted by mistake.
 */
export function signForwardedHop(input: SignForwardedHopInput): ForwardedHopHeaders {
  const { secret, nodeId, method, path } = input;
  if (!secret || secret.trim().length === 0) {
    throw new Error('Cannot sign forwarded hop without a non-empty secret');
  }
  if (!nodeId || nodeId.trim().length === 0) {
    throw new Error('Cannot sign forwarded hop without a non-empty nodeId');
  }
  if (!method || method.trim().length === 0 || !path || path.trim().length === 0) {
    throw new Error('Cannot sign forwarded hop without a non-empty method and path');
  }
  if (hasForbiddenFieldChars(nodeId) || hasForbiddenFieldChars(method) || hasForbiddenFieldChars(path)) {
    throw new Error('Cannot sign forwarded hop with control characters in nodeId, method, or path');
  }
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error('Cannot sign forwarded hop with an invalid timestamp');
  }
  const ts = String(Math.trunc(now));
  const sig = createHmac('sha256', secret)
    .update(buildSignaturePayload(ts, nodeId, method, path))
    .digest('hex');
  return {
    [FORWARDED_HOP_HEADER]: nodeId,
    [FORWARDED_HOP_TS_HEADER]: ts,
    [FORWARDED_HOP_SIG_HEADER]: sig,
  };
}

/**
 * Verify that an inbound request carries a valid, fresh HMAC signature from a peer node.
 * Always fails closed when the shared secret is unset or any header/field is missing, malformed, or skewed.
 */
export function verifyForwardedHop(input: VerifyForwardedHopInput): boolean {
  const { secret, headers, method, path } = input;
  if (!secret || secret.trim().length === 0) return false;
  if (!headers || !method || method.trim().length === 0 || !path || path.trim().length === 0) return false;

  const nodeId = readSingleHeader(headers, FORWARDED_HOP_HEADER);
  const tsRaw = readSingleHeader(headers, FORWARDED_HOP_TS_HEADER);
  const sigRaw = readSingleHeader(headers, FORWARDED_HOP_SIG_HEADER);
  if (!nodeId || nodeId.trim().length === 0 || !tsRaw || !sigRaw) return false;
  if (hasForbiddenFieldChars(nodeId) || hasForbiddenFieldChars(method) || hasForbiddenFieldChars(path)) return false;

  if (!INTEGER_MS_PATTERN.test(tsRaw)) return false;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts)) return false;

  const now = input.nowMs ?? Date.now();
  const maxSkewMs = input.maxSkewMs ?? DEFAULT_FORWARDED_HOP_MAX_SKEW_MS;
  if (!Number.isFinite(now) || !Number.isFinite(maxSkewMs) || maxSkewMs < 0) return false;
  if (Math.abs(now - ts) > maxSkewMs) return false;

  if (!SHA256_HEX_PATTERN.test(sigRaw)) return false;
  const expected = createHmac('sha256', secret)
    .update(buildSignaturePayload(tsRaw, nodeId, method, path))
    .digest();
  const actual = Buffer.from(sigRaw, 'hex');
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}
