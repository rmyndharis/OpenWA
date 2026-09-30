import { registerDecorator, ValidationOptions } from 'class-validator';

const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const MAX_HEADERS = 50;
const MAX_VALUE_LENGTH = 1024;

/**
 * Reject C0 control chars and DEL (notably CR/LF, the header-injection vector) and anything above
 * U+00FF: the HTTP client sends header values as Latin-1 bytes and throws on any wider code unit,
 * which would fail every delivery of the webhook.
 */
function hasInvalidValueChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c > 0xff) return true;
  }
  return false;
}

/**
 * Validate operator-supplied webhook custom headers as a flat map of valid header names to string
 * values: rejects non-object shapes, invalid header names, non-string or control-character values
 * (CR/LF header injection), values outside Latin-1, over-large maps (≤50 entries, value ≤1024
 * chars), and two names that differ only in case: the HTTP client joins those into one
 * comma-separated value instead of sending either as written. Reserved-name stripping still happens
 * at delivery time (sanitizeCustomHeaders); this is the input-side guard.
 */
export function IsHeaderMap(options?: ValidationOptions) {
  return function (target: object, propertyName: string): void {
    registerDecorator({
      name: 'isHeaderMap',
      target: target.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined) return true; // absence is the optional decorator's call
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
          const entries = Object.entries(value as Record<string, unknown>);
          if (entries.length > MAX_HEADERS) return false;
          if (new Set(entries.map(([k]) => k.toLowerCase())).size !== entries.length) return false;
          return entries.every(
            ([k, v]) =>
              HEADER_NAME.test(k) && typeof v === 'string' && v.length <= MAX_VALUE_LENGTH && !hasInvalidValueChar(v),
          );
        },
        defaultMessage(): string {
          return 'headers must be a flat map of valid header names to string values (names unique ignoring case, no control characters or characters outside Latin-1, max 50 entries, value max 1024 chars)';
        },
      },
    });
  };
}
