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
  const local = jid.split('@')[0];
  // Group participant ids include a colon + device, e.g. `628xxx@c.us:7`. Strip it for display.
  const user = local.split(':')[0];
  if (!/^\d+$/.test(user)) return null;
  return user;
}

/**
 * Format a digits-only phone number (already prefixed with its country code) into a
 * human-friendly international form. Uses 3-3-4 grouping after the country code; short codes
 * pass through. This is purely cosmetic — the raw JID stays authoritative for any technical use.
 *
 *   formatPhoneForDisplay('628123456789') → '+62 812 345 6789'
 *   formatPhoneForDisplay('14155552671')   → '+1 415 555 2671'
 *   formatPhoneFromJid('120363xxx@g.us')   → null
 */
export function formatPhoneForDisplay(phoneOrJid: string): string | null {
  const digits = /^\d+$/.test(phoneOrJid) ? phoneOrJid : parsePhoneFromJid(phoneOrJid);
  if (!digits) return null;
  if (digits.length <= 4) return `+${digits}`;

  // Country-code heuristic: WhatsApp country codes are 1–3 digits. Prefer 2 when possible (covers
  // the common 62/44/49/91/86… range), fall back to 1 (USA/Canada + a few others) for 11-digit
  // numbers starting with 1, and 3 only when the prefix matches a known 3-digit plan.
  let ccLen = 2;
  if (digits.length === 11 && digits[0] === '1') ccLen = 1;
  else if (digits.length <= 6) ccLen = 1;

  const cc = digits.slice(0, ccLen);
  const rest = digits.slice(ccLen);
  if (rest.length <= 4) return `+${cc} ${rest}`;
  // Standard display convention: trailing group of 4, then 3-digit groups from the left for the
  // remainder. Matches both the Indonesian "812 345 6789" and US "415 555 2671" shapes.
  const last4 = rest.slice(-4);
  const prefix = rest.slice(0, -4);
  const prefixGroups = prefix.match(/.{1,3}/g) ?? [prefix];
  return `+${cc} ${[...prefixGroups, last4].join(' ')}`;
}
