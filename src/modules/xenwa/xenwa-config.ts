import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * XenWA (XenAI Tech integration) settings, read straight from the environment so they are visible
 * to the compose-parity spec. Every value is optional: without XENWA_SSO_SECRET the SSO endpoints
 * answer 503 and the gateway behaves exactly as before.
 */
export interface XenwaConfig {
  /** Shared HMAC secret with XenAI Tech (>= 32 chars). Empty disables SSO. */
  ssoSecret: string;
  /** Expected `aud` claim. */
  audience: string;
  /** XenAI Tech base URL, used for the "Back to XenAI Tech" link and logout. */
  platformUrl: string;
  /** XenAI Tech roles that get an unscoped ADMIN key (platform operators). */
  adminRoles: string[];
  /** How many WhatsApp accounts a regular user may create. */
  maxSessionsPerUser: number;
  /** Bearer secret for XenAI Tech's server-to-server billing API. Empty disables billing. */
  billingSecret: string;
  /** Base URL of that API (`…/api/xenwa/billing`). */
  billingUrl: string;
}

export function readXenwaConfig(env: NodeJS.ProcessEnv = process.env): XenwaConfig {
  const max = parseInt(env.XENWA_MAX_SESSIONS_PER_USER ?? '', 10);
  const config: XenwaConfig = {
    ssoSecret: (env.XENWA_SSO_SECRET ?? '').trim(),
    audience: (env.XENWA_SSO_AUDIENCE ?? '').trim() || 'wa.xenaitech.com',
    platformUrl: ((env.XENWA_PLATFORM_URL ?? '').trim() || 'https://xenaitech.com').replace(/\/+$/, ''),
    adminRoles: ((env.XENWA_SSO_ADMIN_ROLES ?? '').trim() || 'super_admin')
      .split(',')
      .map(r => r.trim())
      .filter(Boolean),
    maxSessionsPerUser: Number.isFinite(max) && max > 0 ? max : 3,
    billingSecret: (env.XENWA_BILLING_SECRET ?? '').trim(),
    billingUrl: '',
  };
  config.billingUrl = ((env.XENWA_BILLING_URL ?? '').trim() || `${config.platformUrl}/api/xenwa/billing`).replace(
    /\/+$/,
    '',
  );
  return config;
}

export function ssoEnabled(config: XenwaConfig): boolean {
  return config.ssoSecret.length >= 32;
}

export function billingEnabled(config: XenwaConfig): boolean {
  return config.billingSecret.length >= 32;
}

/**
 * The raw API key of a managed user is kept encrypted (AES-256-GCM, key derived from the SSO secret)
 * so a later SSO sign-in on another device can hand the same key back instead of rotating it, which
 * would sign the user out everywhere else and break their own integrations. Only the hash is used for
 * authentication; if the secret changes the ciphertext simply stops decrypting and a fresh key is
 * minted on the next sign-in.
 */
function cipherKey(secret: string): Buffer {
  return createHash('sha256').update(`xenwa-api-key-at-rest:${secret}`).digest();
}

export function encryptApiKey(rawKey: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(secret), iv);
  const body = Buffer.concat([cipher.update(rawKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${body.toString('base64')}`;
}

export function decryptApiKey(payload: string | null | undefined, secret: string): string | null {
  if (!payload) return null;
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', cipherKey(secret), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
