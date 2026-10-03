import { createHmac, timingSafeEqual } from 'crypto';

/**
 * The SSO hand-off token XenAI Tech mints for XenWA: a compact HS256 JWT signed with the shared
 * `XENWA_SSO_SECRET`. It lives at most 60 seconds and carries a nonce that XenWA burns on first use,
 * so a token lifted from a log or a browser history cannot be replayed.
 */
export interface XenwaSsoClaims {
  /** XenAI Tech user id (stable link key). */
  sub: string;
  email: string;
  name?: string;
  role?: string;
  image?: string;
  nonce: string;
  iat: number;
  exp: number;
  aud: string;
  iss?: string;
}

export class XenwaSsoTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XenwaSsoTokenError';
  }
}

/** Longest lifetime accepted regardless of what `exp` says (defends against a mis-minted token). */
export const MAX_TOKEN_LIFETIME_SECONDS = 120;
/** Clock skew tolerated between the two servers. */
const CLOCK_SKEW_SECONDS = 30;

function b64urlDecode(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Sign claims (used by tests and by any operator tooling; XenAI Tech has its own copy). */
export function signXenwaSsoToken(claims: XenwaSsoClaims, secret: string): string {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const sig = b64urlEncode(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

/**
 * Verify signature, algorithm, audience, lifetime and required claims. Does NOT check nonce reuse —
 * the caller burns the nonce in the database so replay protection survives a restart.
 */
export function verifyXenwaSsoToken(
  token: string,
  secret: string,
  audience: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): XenwaSsoClaims {
  if (!secret || secret.length < 32) throw new XenwaSsoTokenError('SSO is not configured');
  if (typeof token !== 'string' || token.length > 8192) throw new XenwaSsoTokenError('Malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new XenwaSsoTokenError('Malformed token');
  const [h, p, s] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8')) as { alg?: string };
  } catch {
    throw new XenwaSsoTokenError('Malformed token');
  }
  if (header.alg !== 'HS256') throw new XenwaSsoTokenError('Unsupported token algorithm');

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = b64urlDecode(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new XenwaSsoTokenError('Invalid token signature');
  }

  let claims: Partial<XenwaSsoClaims>;
  try {
    claims = JSON.parse(b64urlDecode(p).toString('utf8')) as Partial<XenwaSsoClaims>;
  } catch {
    throw new XenwaSsoTokenError('Malformed token');
  }

  if (claims.aud !== audience) throw new XenwaSsoTokenError('Token audience mismatch');
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    throw new XenwaSsoTokenError('Token lifetime missing');
  }
  if (claims.exp < nowSeconds - CLOCK_SKEW_SECONDS) throw new XenwaSsoTokenError('Token expired');
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new XenwaSsoTokenError('Token issued in the future');
  if (claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) throw new XenwaSsoTokenError('Token lifetime too long');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 64) {
    throw new XenwaSsoTokenError('Token subject missing');
  }
  if (
    typeof claims.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) ||
    claims.email.length > 254
  ) {
    throw new XenwaSsoTokenError('Token email missing');
  }
  if (typeof claims.nonce !== 'string' || claims.nonce.length < 16 || claims.nonce.length > 128) {
    throw new XenwaSsoTokenError('Token nonce missing');
  }

  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : undefined,
    role: typeof claims.role === 'string' ? claims.role.slice(0, 32) : undefined,
    image:
      typeof claims.image === 'string' && /^https?:\/\//.test(claims.image) ? claims.image.slice(0, 1024) : undefined,
    nonce: claims.nonce,
    iat: claims.iat,
    exp: claims.exp,
    aud: claims.aud,
    iss: typeof claims.iss === 'string' ? claims.iss : undefined,
  };
}
