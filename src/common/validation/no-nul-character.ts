import { NotContains } from 'class-validator';

/** PostgreSQL text and varchar columns cannot store U+0000, so the write would fail as a 500. */
export const NoNulCharacter = (): PropertyDecorator =>
  NotContains('\u0000', { message: '$property must not contain a NUL character' });

/** Whether a string anywhere in a parsed request value holds U+0000, which PostgreSQL rejects as a parameter. */
export const containsNul = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.includes('\u0000')
    : typeof value === 'object' && value !== null && Object.values(value).some(containsNul);
