import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

/** A bare phone number (MSISDN digits), accepted as a convenience in place of a `<phone>@c.us` id. */
const BARE_NUMBER = /^\d{5,}$/;
/** A group id's user-part: digits, with the legacy `<a>-<b>@g.us` hyphenated form allowed. */
const GROUP_USER_PART = /^\d+(?:-\d+)?$/;
const PLAIN_DIGITS = /^\d{5,}$/;

/**
 * Whether a string is a WhatsApp chat id fit for `allowedChats` and safe to store in the
 * `simple-array` column.
 *
 * Two storage rules are load-bearing and shared with {@link isSessionId}: an empty/whitespace entry
 * joins to `''` and reads back as `[]`, which every enforcement site treats as "unrestricted" (fail
 * OPEN), and an entry containing a comma is split into two on read. Both are rejected here.
 *
 * Beyond that the entry must be a well-formed chat id: a group (`<id>@g.us`), an individual
 * (`<phone>@c.us` or `<lid>@lid`), or a bare phone number. A non-matching entry fails CLOSED (it
 * matches no chat), so the id shape is checked to catch typos rather than to gate the storage.
 */
export function isChatId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed !== value || trimmed.includes(',')) return false;
  if (BARE_NUMBER.test(trimmed)) return true;
  const at = trimmed.lastIndexOf('@');
  if (at === -1 || trimmed.indexOf('@') !== at) return false;
  const user = trimmed.slice(0, at).split(':')[0];
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (domain === 'g.us') return GROUP_USER_PART.test(user);
  if (domain === 'c.us' || domain === 's.whatsapp.net' || domain === 'lid') return PLAIN_DIGITS.test(user);
  return false;
}

@ValidatorConstraint({ name: 'isChatId', async: false })
export class IsChatIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isChatId(value);
  }
  defaultMessage(): string {
    return 'each allowedChats entry must be a chat id (a group "<id>@g.us", a contact "<phone>@c.us" / "<lid>@lid", or a bare phone number) with no surrounding whitespace and no comma';
  }
}
