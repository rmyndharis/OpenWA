import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactCards, contactSnippet, parseVCard } from './vcard.ts';
import { isolateNumber } from './formatPhone.ts';

// A vCard value is read the way RFC 6350 writes it: a line folded with a line break and one white-space character is
// one line (section 3.2), and in the text of a value a backslash escapes one character, read in a single pass
// (section 3.4), so backslash, backslash, n is a backslash and the letter n.
const BACKSLASH = String.fromCharCode(92);
const NAME = `AC${BACKSLASH}nDC`;
const WIRE_NAME = `AC${BACKSLASH}${BACKSLASH}nDC`;
const card = `BEGIN:VCARD\nVERSION:3.0\nFN:${WIRE_NAME}\nTEL;waid=15550001111:+1 555 000 1111\nEND:VCARD`;

test('an escaped backslash before the letter n is read back as those two characters', () => {
  assert.equal(parseVCard(card).name, NAME);
});

test('the contact card and the preview show the name as it was written', () => {
  assert.equal(contactCards(card)[0].name, NAME);
  assert.equal(contactSnippet(card, 'Contact'), `${NAME} · ${isolateNumber('+1 555 000 1111')}`);
});

test('an escaped line break, comma, semicolon and backslash still decode', () => {
  const wire = `BEGIN:VCARD\nFN:a${BACKSLASH}nb${BACKSLASH},c${BACKSLASH};d${BACKSLASH}${BACKSLASH}e\nEND:VCARD`;
  assert.equal(parseVCard(wire).name, `a\nb,c;d${BACKSLASH}e`);
});

const LONG_NAME = 'Alexandria Montgomery-Wellington the Third of Westminster';

test('a name folded onto a continuation line is one name', () => {
  const folded = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alexandria Montgomery-Wellington the\r\n  Third of Westminster\r\nTEL;waid=15550001111:+1 555 000 1111\r\nEND:VCARD`;
  const parsed = parseVCard(folded);
  assert.equal(parsed.name, LONG_NAME);
  assert.equal(parsed.phone, '+1 555 000 1111');
});

test('a continuation line that starts with a tab, in a body of plain line feeds, is folded too', () => {
  const folded = 'BEGIN:VCARD\nFN:Alexandria Montgomery-Wellington the\n\t Third of Westminster\nTEL:+1 555\nEND:VCARD';
  assert.equal(parseVCard(folded).name, LONG_NAME);
});

test('a phone folded onto a continuation line is one phone', () => {
  assert.equal(parseVCard('BEGIN:VCARD\nFN:Ana\nTEL:+1 555 000\n  1111\nEND:VCARD').phone, '+1 555 000 1111');
});

test('a card whose property lines are all indented is not read as one folded line', () => {
  // The per-line trim has always read these; a fold only continues a value, it never starts a property.
  for (const indent of [' ', '  ', '\t']) {
    const indented = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Alice', 'TEL;waid=15550001111:+1 555 000 1111', 'END:VCARD']
      .map((line, index) => (index === 0 ? line : indent + line))
      .join('\n');
    assert.deepEqual(
      parseVCard(indented),
      { name: 'Alice', phone: '+1 555 000 1111', waid: '15550001111' },
      `a card indented by ${JSON.stringify(indent)} lost its fields`,
    );
  }
});
