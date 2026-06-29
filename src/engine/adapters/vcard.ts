import { ContactCard } from '../interfaces/whatsapp-engine.interface';

/**
 * Build a VERSION:3.0 vCard for a contact-card send, shared by both engine adapters.
 *
 * CR/LF are stripped from the name and number so a crafted value (e.g. `name = "Alice\r\nEMAIL:..."`)
 * cannot inject extra vCard lines/fields, and the `waid` is reduced to digits. The number is used once
 * in the TEL value as-is (after the CR/LF strip) rather than being unconditionally `+`-prefixed.
 */
export function buildVCard(contact: ContactCard): string {
  const clean = (s: string): string => s.replace(/[\r\n]+/g, ' ');
  const name = clean(contact.name);
  const number = clean(contact.number);
  const waid = number.replace(/\D/g, '');
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `TEL;type=CELL;type=VOICE;waid=${waid}:${number}`,
    'END:VCARD',
  ].join('\n');
}
