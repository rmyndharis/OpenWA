import { ForbiddenException } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'http';
import { hashApiKey } from './api-key-hash';
import { resolveCorsPolicy } from '../../config/bootstrap-security';
import { ipMatches, normalizeIp } from '../../common/utils/ip';

export const BROWSER_SESSION_COOKIE_NAME = 'openwa_session';
export const DASHBOARD_CSRF_HEADER = 'x-requested-with';
export const DASHBOARD_CSRF_HEADER_VALUE = 'OpenWA-Dashboard';

export const DEFAULT_BROWSER_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const MIN_BROWSER_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_BROWSER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function resolveBrowserSessionTtlMs(rawEnv?: string): number {
  const trimmed = rawEnv?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_BROWSER_SESSION_TTL_MS;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_BROWSER_SESSION_TTL_MS;
  return Math.min(MAX_BROWSER_SESSION_TTL_MS, Math.max(MIN_BROWSER_SESSION_TTL_MS, parsed));
}

export function hashBrowserSessionToken(rawToken: string, pepper?: string): string {
  return hashApiKey(rawToken, pepper);
}

export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim();
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * Parse the `openwa_session` cookie value from a raw Cookie header, returning undefined when absent
 * or blank.
 */
export function extractBrowserSessionCookie(cookieHeader: string | string[] | undefined): string | undefined {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== BROWSER_SESSION_COOKIE_NAME) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep raw token bytes when not percent-encoded.
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Surfaces that accept API key headers exclusively and must never authenticate via browser session
 * cookies. Percent-decoding and duplicate-slash collapsing happen before comparison so alternate
 * path spellings cannot bypass the restriction.
 */
export function isCookieAuthDisallowedPath(rawPath: string | undefined): boolean {
  if (!rawPath) return false;
  let normalized = rawPath.split('?')[0];
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep raw string when malformed percent-encoding is present.
  }
  normalized = normalized.replace(/\/+/g, '/').toLowerCase();
  return (
    normalized === '/mcp' ||
    normalized.startsWith('/mcp/') ||
    normalized === '/api/metrics' ||
    normalized.startsWith('/api/metrics/') ||
    normalized === '/api/admin/queues' ||
    normalized.startsWith('/api/admin/queues/')
  );
}

export interface CookieRequestLike {
  secure?: boolean;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
}

function isTrustedProxyPeer(req: CookieRequestLike, trustedProxies: string[]): boolean {
  if (!trustedProxies.length) return false;
  const socketIp = normalizeIp(req.socket?.remoteAddress || req.ip || '');
  return trustedProxies.some(proxy => ipMatches(socketIp, proxy));
}

/**
 * Take the rightmost non-empty comma-separated value of a proxy-appended header (such as
 * `X-Forwarded-Proto` or `X-Forwarded-Host`) so a client-supplied leading entry cannot spoof the
 * hop added by a trusted reverse proxy.
 */
function rightmostHeaderEntry(value: string | string[] | undefined): string | undefined {
  const parts = (Array.isArray(value) ? value : value !== undefined ? [value] : [])
    .flatMap(entry => entry.split(','))
    .map(entry => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

function normalizeHostForProtocol(rawHost: string | undefined, protocol: 'http:' | 'https:'): string | null {
  const trimmed = rawHost?.trim();
  if (!trimmed || /[\s/@?#]/.test(trimmed)) return null;
  try {
    // URL lowercases the host and strips explicit default ports (:80 for http:, :443 for https:)
    // while preserving non-default ports and bracketed IPv6 literals.
    const parsed = new URL(`${protocol}//${trimmed}`);
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      return null;
    }
    return parsed.host;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective Host header for same-origin checks: honors the rightmost valid
 * `X-Forwarded-Host` entry when the immediate peer is a trusted proxy, falling back to `Host`.
 */
export function resolveEffectiveHost(req: CookieRequestLike, trustedProxies: string[]): string | undefined {
  if (isTrustedProxyPeer(req, trustedProxies)) {
    const forwardedHost = rightmostHeaderEntry(req.headers['x-forwarded-host']);
    if (forwardedHost && normalizeHostForProtocol(forwardedHost, 'https:')) {
      return forwardedHost;
    }
  }
  return firstHeaderValue(req.headers.host);
}

/**
 * True only when the request demonstrably arrived over HTTPS (either direct TLS via `req.secure`
 * or via a trusted proxy whose rightmost `X-Forwarded-Proto` is `https`). Deliberately ignores
 * `DASHBOARD_SESSION_COOKIE_SECURE` so cookie-attribute overrides never alter Origin scheme checks.
 */
export function isHttpsTransportRequest(req: CookieRequestLike, trustedProxies: string[]): boolean {
  if (req.secure) return true;
  if (!isTrustedProxyPeer(req, trustedProxies)) return false;
  return rightmostHeaderEntry(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https';
}

/**
 * Whether to attach the `Secure` attribute to `openwa_session`. Explicit
 * `DASHBOARD_SESSION_COOKIE_SECURE` wins (`'true'`/`'false'`); otherwise follows
 * `isHttpsTransportRequest`.
 */
export function isSecureCookieRequest(req: CookieRequestLike, trustedProxies: string[]): boolean {
  const override = process.env.DASHBOARD_SESSION_COOKIE_SECURE?.trim();
  if (override === 'true') return true;
  if (override === 'false') return false;
  return isHttpsTransportRequest(req, trustedProxies);
}

export function formatSessionSetCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${BROWSER_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function formatSessionClearCookie(secure: boolean): string {
  return `${BROWSER_SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

function parseHttpOrigin(origin: string | undefined): URL | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True only when `origin` matches an explicit entry in `CORS_ORIGINS` (never a wildcard `*`).
 */
export function isExplicitCorsOrigin(origin: string | undefined, corsOriginsEnv?: string, nodeEnv?: string): boolean {
  const parsed = parseHttpOrigin(origin);
  if (!parsed) return false;
  const policy = resolveCorsPolicy(corsOriginsEnv, nodeEnv);
  return !policy.allowAnyOrigin && policy.origins.includes(parsed.origin);
}

/**
 * True when `origin` matches the request's effective host (normalizing explicit default ports `:80`
 * and `:443` and enforcing `expectedProtocol` when provided) or an explicit `CORS_ORIGINS` entry.
 * Wildcard `*` never authorizes cookie-bearing requests. When `requireOrigin` is true (e.g.
 * cookie-authenticated WebSocket handshakes for CSWSH defense), a missing `Origin` is rejected.
 */
export function isAllowedBrowserOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  corsOriginsEnv?: string,
  nodeEnv?: string,
  requireOrigin = false,
  expectedProtocol?: 'http:' | 'https:',
): boolean {
  if (!origin) return !requireOrigin;
  const parsed = parseHttpOrigin(origin);
  if (!parsed) return false;
  const parsedProtocol = parsed.protocol as 'http:' | 'https:';
  if (!expectedProtocol || parsedProtocol === expectedProtocol) {
    const normalizedHost = normalizeHostForProtocol(hostHeader, expectedProtocol ?? parsedProtocol);
    if (normalizedHost && parsed.host === normalizedHost) {
      return true;
    }
  }
  return isExplicitCorsOrigin(parsed.origin, corsOriginsEnv, nodeEnv);
}

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Shared CSRF defense for cookie-authenticated non-safe HTTP methods: requires
 * `X-Requested-With: OpenWA-Dashboard` and enforces `Sec-Fetch-Site` plus scheme- and
 * host-normalized `Origin` checks against same-origin or explicit `CORS_ORIGINS`.
 */
export function assertBrowserCsrfSafe(req: CookieRequestLike & { method?: string }, trustedProxies: string[]): void {
  const method = (req.method ?? 'GET').toUpperCase();
  if (SAFE_HTTP_METHODS.has(method)) return;

  const requestedWith = firstHeaderValue(req.headers?.[DASHBOARD_CSRF_HEADER]);
  if (requestedWith !== DASHBOARD_CSRF_HEADER_VALUE) {
    throw new ForbiddenException('Missing or invalid X-Requested-With header');
  }

  const origin = firstHeaderValue(req.headers?.origin);
  const effectiveHost = resolveEffectiveHost(req, trustedProxies);
  // Only pin https: when HTTPS transport is directly proven (TLS socket or trusted HTTPS proxy);
  // a plain HTTP backend behind an unconfigured TLS terminator (nginx/Caddy/Traefik) sees
  // https:// Origin with a non-secure local socket.
  const expectedProtocol: 'https:' | undefined = isHttpsTransportRequest(req, trustedProxies) ? 'https:' : undefined;
  const secFetchSite = firstHeaderValue(req.headers?.['sec-fetch-site'])?.toLowerCase();

  if (secFetchSite && secFetchSite !== 'same-origin') {
    if (!isExplicitCorsOrigin(origin, process.env.CORS_ORIGINS, process.env.NODE_ENV)) {
      throw new ForbiddenException('Cross-site cookie request rejected');
    }
  }

  if (origin !== undefined) {
    if (
      !isAllowedBrowserOrigin(
        origin,
        effectiveHost,
        process.env.CORS_ORIGINS,
        process.env.NODE_ENV,
        true,
        expectedProtocol,
      )
    ) {
      throw new ForbiddenException('Request origin is not allowed');
    }
  }
}
