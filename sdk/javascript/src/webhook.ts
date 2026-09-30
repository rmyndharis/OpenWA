const encoder = new TextEncoder();

/**
 * Check a webhook delivery's `X-OpenWA-Signature` header (`sha256=<hex HMAC-SHA256>`) against the
 * webhook secret. Pass the raw request body exactly as received; a re-serialized parse can differ
 * byte for byte and will not verify. Resolves `false` (never throws) for a missing, malformed or
 * non-matching signature and for an empty secret.
 *
 * Uses WebCrypto, so it runs in browsers, edge runtimes, Deno, Bun and Node; on Node 18, which has
 * no global `crypto`, it loads `node:crypto`'s WebCrypto instead.
 */
export async function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
): Promise<boolean> {
  const hex = /^sha256=([0-9a-fA-F]{64})$/.exec(signature ?? '')?.[1];
  if (!hex || !secret) return false;
  const subtle = globalThis.crypto?.subtle ?? (await nodeSubtle());
  const key = await subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const mac = new Uint8Array(32);
  for (let i = 0; i < 32; i++) mac[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const body = typeof rawBody === 'string' ? encoder.encode(rawBody) : new Uint8Array(rawBody);
  // subtle.verify compares in constant time.
  return subtle.verify('HMAC', key, mac, body);
}

async function nodeSubtle(): Promise<SubtleCrypto> {
  // A string-typed specifier keeps TypeScript from resolving Node's types and bundlers from
  // pulling the module into browser builds; only a runtime without global WebCrypto gets here.
  const specifier: string = 'node:crypto';
  const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)) as {
    webcrypto: { subtle: SubtleCrypto };
  };
  return mod.webcrypto.subtle;
}
