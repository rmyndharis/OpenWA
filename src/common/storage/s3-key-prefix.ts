import { isSafeStorageKey } from '../utils/path-safety';

/** The S3 key root when S3_KEY_PREFIX is unset or blank, and the layout every existing bucket uses. */
export const DEFAULT_S3_KEY_PREFIX = 'media/';

/**
 * Normalise S3_KEY_PREFIX into the key root every object lives under: trimmed, with exactly one
 * trailing '/', so `staging` never also matches `staging-old/...` in a prefix listing (the orphan
 * sweeps delete what they list). Unset or blank gives `media/`. Returns null for a value that is
 * absolute, contains control characters or an empty, `.` or `..` segment, or is only slashes (keys
 * at the bucket root); boot validation rejects those, as S3-compatible stores such as MinIO refuse
 * object keys with empty or `.` segments.
 */
export function normalizeS3KeyPrefix(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return DEFAULT_S3_KEY_PREFIX;
  const body = trimmed.replace(/\/+$/, '');
  if (!body || !isSafeStorageKey(body) || body.split('/').some(s => s === '' || s === '.')) return null;
  return `${body}/`;
}
