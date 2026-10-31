// Heuristic phone-number formatting for chat display. We deliberately avoid a full
// libphonenumber-js dependency: WhatsApp hands us digits-only user parts (`628123456789`)
// already canonicalised (with the country code prefix in place), so a group-based formatter is
// enough for human-readable display. The raw JID is preserved separately in the UI for the
// technical case where the exact id is needed.

/**
 * Extract the local digits from a WhatsApp JID's user part. Returns null for anything that is
 * not a digits-only user JID (groups, LID privacy ids, status/broadcast/newsletter).
 *
 *   parsePhoneFromJid('628123456789@c.us')   → '628123456789'
 *   parsePhoneFromJid('120363xxx@g.us')      → null  (group)
 *   parsePhoneFromJid('xyz@lid')             → null  (privacy id, not a phone)
 */
export function parsePhoneFromJid(jid: string): string | null {
  if (!jid) return null;
  const [local, domain] = jid.split('@');
  // Only personal-account domains carry a real phone number. LID privacy ids, groups, and
  // status/broadcast/newsletter ids are digit-heavy too but are NOT phones — treating them as one
  // formats a privacy/group id as a fake number (a LID like 262813461250071@lid displayed as
  // "+26 281 346 125 0071").
  if (domain && !domain.startsWith('c.us') && domain !== 's.whatsapp.net') return null;
  // Group participant ids include a colon + device, e.g. `628xxx@c.us:7`. Strip it for display.
  const user = local.split(':')[0];
  if (!/^\d+$/.test(user)) return null;
  return user;
}

// ITU-T E.164 country codes are prefix-free, so the leading digits alone fix the code's length:
// 1 (NANP) and 7 (Russia, Kazakhstan) are the only 1-digit codes; 20, 27, 30-34, 36, 39, 40, 41,
// 43-49, 51-58, 60-66, 81, 82, 84, 86, 90-95 and 98 are the 2-digit ones; every other prefix starts
// a 3-digit code.
const TWO_DIGIT_COUNTRY_CODE = /^(?:2[07]|3[0-469]|4[013-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/;

/**
 * Format a digits-only phone number (already prefixed with its country code) into a
 * human-friendly international form: groups of three after the country code, the last one or two
 * of four when the length calls for it (see below); short codes pass through. This is purely
 * cosmetic — the raw JID stays authoritative for any technical use.
 *
 *   formatPhoneForDisplay('628123456789') → '+62 812 345 6789'
 *   formatPhoneForDisplay('14155552671')   → '+1 415 555 2671'
 *   formatPhoneFromJid('120363xxx@g.us')   → null
 */
export function formatPhoneForDisplay(phoneOrJid: string): string | null {
  const digits = /^\d+$/.test(phoneOrJid) ? phoneOrJid : parsePhoneFromJid(phoneOrJid);
  if (!digits) return null;
  if (digits.length <= 4) return `+${digits}`;

  // Country code by prefix (see TWO_DIGIT_COUNTRY_CODE); a short code keeps a 1-digit split.
  let ccLen = 3;
  if (digits.length <= 6 || digits[0] === '1' || digits[0] === '7') ccLen = 1;
  else if (TWO_DIGIT_COUNTRY_CODE.test(digits)) ccLen = 2;

  const cc = digits.slice(0, ccLen);
  const rest = digits.slice(ccLen);
  if (rest.length <= 4) return `+${cc} ${rest}`;
  // Groups of three from the left; a length that is not a multiple of three makes the last one or
  // two groups four digits, so no group is shorter than three ("812 345 6789", "817 7000 8896",
  // "9123 4567", "812 345 678"). Five digits cannot be split that way and stay whole.
  const fours = rest.length % 3;
  const cut = rest.length - 4 * fours;
  if (cut < 0) return `+${cc} ${rest}`;
  const groups = [...(rest.slice(0, cut).match(/.{3}/g) ?? []), ...(rest.slice(cut).match(/.{4}/g) ?? [])];
  return `+${cc} ${groups.join(' ')}`;
}

/**
 * A phone number to place inside a sentence. Its plus sign and the spaces between its digit groups are neutral to
 * the bidi algorithm, so inside a right-to-left sentence the groups are shown in reverse order; a left-to-right
 * isolate keeps the number one run, whatever the sentence around it does.
 */
export function isolateNumber(number: string): string {
  return `${String.fromCodePoint(0x2066)}${number}${String.fromCodePoint(0x2069)}`;
}

/**
 * What a chat is called on its row, in its menu and in a sentence: its name, else the formatted number of a phone id,
 * isolated left to right, else the digits of its id. A privacy id (@lid) is no phone number, so its digits are never
 * formatted as one.
 */
export function chatTitle(chat: { id: string; name?: string }): string {
  if (chat.name) return chat.name;
  const phone = formatPhoneForDisplay(chat.id);
  return phone ? isolateNumber(phone) : chat.id.split('@')[0];
}
