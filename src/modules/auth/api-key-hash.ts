import { createHash, createHmac } from 'crypto';

/**
 * Hash an API key for storage/lookup. With a server-side pepper (`API_KEY_PEPPER`) set, uses HMAC so
 * a database leak alone can't precompute candidate hashes against a guessed/user-chosen key. Without
 * a pepper it falls back to plain SHA-256 — unchanged behaviour, so existing stored hashes still
 * validate. NOTE: enabling (or changing) the pepper invalidates keys hashed before it was set, so it
 * is a deploy-time choice; rotate/re-issue keys when turning it on.
 */
export function hashApiKey(rawKey: string, pepper?: string): string {
  return pepper
    ? createHmac('sha256', pepper).update(rawKey).digest('hex')
    : createHash('sha256').update(rawKey).digest('hex');
}
