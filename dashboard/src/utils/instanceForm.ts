export const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function isValidInstanceId(id: string): boolean {
  return INSTANCE_ID_PATTERN.test(id);
}

type ParseResult = { ok: true; value: Record<string, unknown> | undefined } | { ok: false };

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
