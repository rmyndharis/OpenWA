import { registerDecorator, ValidationOptions } from 'class-validator';

const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const MAX_HEADERS = 50;
const MAX_VALUE_LENGTH = 1024;

/** Reject C0 control chars + DEL — notably CR/LF, the header-injection vector. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Validate operator-supplied webhook custom headers as a flat map of valid header names to string
 * values: rejects non-object shapes, invalid header names, non-string or control-character values
 * (CR/LF header injection), and over-large maps (≤50 entries, value ≤1024 chars). Reserved-name
 * stripping still happens at delivery time (sanitizeCustomHeaders); this is the input-side guard.
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
          if (value === undefined || value === null) return true; // @IsOptional handles absence
          if (typeof value !== 'object' || Array.isArray(value)) return false;
          const entries = Object.entries(value as Record<string, unknown>);
          if (entries.length > MAX_HEADERS) return false;
          return entries.every(
            ([k, v]) =>
              HEADER_NAME.test(k) && typeof v === 'string' && v.length <= MAX_VALUE_LENGTH && !hasControlChar(v),
          );
        },
        defaultMessage(): string {
          return 'headers must be a flat map of valid header names to string values (no control characters, max 50 entries, value max 1024 chars)';
        },
      },
    });
  };
}
