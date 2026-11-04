import { captionLength } from './bulkMedia.ts';

export const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_PATTERN.test(id);
}

type ParseResult = { ok: true; value: Record<string, unknown> | undefined } | { ok: false };

/** Blank means auto-generate; otherwise use the server DTO character count and its 16 to 512 bounds. */
export function isValidInstanceSecret(raw: string): boolean {
  const secret = raw.trim();
  const length = captionLength(secret);
  return secret === '' || (length >= 16 && length <= 512);
}

/** Blank → no config (undefined). Otherwise must parse to a plain JSON object. */
export function parseInstanceConfig(raw: string): ParseResult {
  if (raw.trim() === '') return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/**
 * The edit form's session scope. Blank means all sessions: omitted when the instance already serves
 * all sessions, and null when it is scoped, because PATCH reads an omitted field as unchanged.
 */
export function parseEditScope(current: string | null, raw: string): string | null | undefined {
  const value = raw.trim();
  if (value) return value;
  return current ? null : undefined;
}
