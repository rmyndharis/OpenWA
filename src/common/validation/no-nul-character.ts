import { NotContains } from 'class-validator';

/** PostgreSQL text and varchar columns cannot store U+0000, so the write would fail as a 500. */
export const NoNulCharacter = (): PropertyDecorator =>
  NotContains('\u0000', { message: '$property must not contain a NUL character' });

/** Whether a string or object key anywhere in a parsed request value holds U+0000, which PostgreSQL rejects. */
export const containsNul = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes('\u0000');
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return value.some(containsNul);
  return Object.keys(value).some(key => key.includes('\u0000')) || Object.values(value).some(containsNul);
};
