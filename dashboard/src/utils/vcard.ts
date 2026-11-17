/**
 * Shared-contact messages carry the raw vCard in `body` (API contract since v0.23.2). The dashboard
 * must not paint that text as a bubble; these helpers turn it into a name + phone for the UI.
 */

export interface ParsedVCard {
  name: string;
  phone: string;
  waid: string;
}

/** Split a body that may hold several newline-joined vCards (contactsArrayMessage). */
export function splitVCards(body: string): string[] {
  const text = body.trim();
  if (!text) return [];
  const parts = text.split(/(?=BEGIN:VCARD)/i).map(p => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

export function isVCardBody(body: string | undefined | null): boolean {
  return Boolean(body && /^\s*BEGIN:VCARD/i.test(body));
}

/**
 * Read FN/N and the first TEL (preferring a waid) from one vCard. Unknown fields are ignored; a
 * crafted card cannot inject markup because callers render the strings as text nodes.
 */
export function parseVCard(vcard: string): ParsedVCard {
  const lines = vcard.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let name = '';
  let phone = '';
  let waid = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('BEGIN:') || line.startsWith('END:') || line.startsWith('VERSION:')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    const prop = left.split(';')[0].replace(/^item\d+\./i, '').toUpperCase();
    if (prop === 'FN' && !name) {
      name = unescapeVCard(value);
    } else if (prop === 'N' && !name) {
      // N:Last;First;Middle;Prefix;Suffix — WhatsApp often leaves Last empty and puts the given name in First.
      const parts = value.split(';').map(unescapeVCard);
      name = [parts[1], parts[0], parts[2]].filter(Boolean).join(' ').trim() || parts.filter(Boolean).join(' ');
    } else if (prop === 'TEL' && !phone) {
      phone = unescapeVCard(value);
      const waidMatch = left.match(/waid=([^;:]+)/i);
      if (waidMatch) waid = waidMatch[1].replace(/\D/g, '');
    }
  }
  if (!waid && phone) waid = phone.replace(/\D/g, '');
  return { name: name.trim(), phone: phone.trim(), waid };
}

export function parseVCards(body: string): ParsedVCard[] {
  return splitVCards(body)
    .map(parseVCard)
    .filter(c => c.name || c.phone || c.waid);
}

/**
 * One-line sidebar / quote preview. Prefers the contact name; falls back to the localised label
 * when the body is not a usable vCard.
 */
export function contactSnippet(body: string | undefined | null, fallbackLabel: string): string {
  if (!body) return fallbackLabel;
  const cards = parseVCards(body);
  if (cards.length === 0) return isVCardBody(body) ? fallbackLabel : body;
  if (cards.length === 1) {
    const c = cards[0];
    if (c.name && c.phone) return `${c.name} · ${c.phone}`;
    return c.name || c.phone || fallbackLabel;
  }
  const names = cards.map(c => c.name || c.phone).filter(Boolean);
  return names.length > 0 ? names.join(', ') : fallbackLabel;
}

function unescapeVCard(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
