import type { ApiKey } from './entities/api-key.entity';

/**
 * Collapse an `allowedSessions` list to the two shapes the enforcement sites actually distinguish.
 *
 * The column is `simple-array`: TypeORM joins on write and splits on read, so `['']` is stored as
 * `''` and read back as `[]`. Every site treats a zero-length list as "every session", so a write
 * that looked like a scoping landed as a widening. The DTO validator now refuses such an entry at
 * the boundary, and this is the second half: whatever reaches storage is either a non-empty list of
 * real ids, or NULL.
 *
 * NULL rather than `[]` on purpose. Both already exist in the table for the same intent, and the
 * published contract says an unscoped key omits the field, which only NULL produces.
 */
export function normalizeScopeList(list: string[] | null | undefined): string[] | null {
  if (list == null) return null;
  const cleaned = list.map(entry => entry.trim()).filter(entry => entry.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

/** An `expiresAt` in milliseconds, or null when it is unset or unparseable (a Date from the driver, a string from a snapshot). */
export function apiKeyExpiryTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** The columns that decide what a key may do. Everything else on the row is descriptive or advisory. */
export type ApiKeyAuthorization = Pick<ApiKey, 'role' | 'allowedIps' | 'allowedSessions' | 'expiresAt'>;

/**
 * A stable string for what a key is AUTHORIZED to do: role, IP allowlist, session scope, expiry.
 * Two rows sharing a fingerprint authorize identically, so any other column moving must leave it
 * untouched, in particular `lastUsedAt`/`usageCount`/`updatedAt`, which the usage tracker rewrites
 * for every key in active use. A fingerprint that moved with them would disconnect every live
 * WebSocket client on the next windowed statistics write.
 *
 * Membership, not order: both allowlists are enforced with `.includes()`, so a reorder authorizes
 * exactly the same and is sorted away here. `''`, `[]` and NULL all mean "unscoped" at every
 * enforcement site and normalize to the same value, so a legacy row does not read as a change.
 */
export function apiKeyAuthorizationFingerprint(key: ApiKeyAuthorization): string {
  const scope = (list: string[] | null | undefined): string[] | null => {
    const normalized = normalizeScopeList(list);
    return normalized ? [...normalized].sort() : null;
  };
  return JSON.stringify([key.role, scope(key.allowedIps), scope(key.allowedSessions), apiKeyExpiryTime(key.expiresAt)]);
}
