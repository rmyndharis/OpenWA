// The one-line preview of a shared contact (chat list row, quote, search hit) puts the phone in running text, which the
// row draws by the direction of its first strong character: after an Arabic or Hebrew name the number is drawn with
// its plus sign at the wrong end and its groups in reverse order. A phone inside a sentence goes in a left-to-right
// isolate (isolateNumber in formatPhone.ts), as every other number the chat page puts into text does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactSnippet } from './vcard.ts';
import { isolateNumber } from './formatPhone.ts';

const PHONE = '+971 50 123 4567';
const OTHER = '+971 55 987 6543';
const card = (name: string, phone: string): string =>
  [
    'BEGIN:VCARD',
    'VERSION:3.0',
    name ? `FN:${name}` : '',
    `item1.TEL;waid=${phone.replace(/\D/g, '')}:${phone}`,
    'END:VCARD',
  ]
    .filter(Boolean)
    .join('\n');

test('the phone in a contact preview is inside a left-to-right isolate, after any name', () => {
  for (const name of ['Ali', 'علي أحمد', 'דני כהן']) {
    assert.equal(contactSnippet(card(name, PHONE), 'Contact'), `${name} · ${isolateNumber(PHONE)}`);
  }
});

test('a card with no name previews as its isolated phone', () => {
  assert.equal(contactSnippet(card('', PHONE), 'Contact'), isolateNumber(PHONE));
});

test('every phone in the preview of several cards is isolated, whatever name comes before it', () => {
  const body = [card('علي أحمد', PHONE), card('', OTHER), card('Dan', '+972 50-123-4567')].join('\n');
  assert.equal(contactSnippet(body, 'Contact'), `علي أحمد, ${isolateNumber(OTHER)}, Dan`);
});
