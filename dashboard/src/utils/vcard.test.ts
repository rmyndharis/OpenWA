import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactSnippet, isVCardBody, parseVCard, parseVCards } from './vcard.ts';

const SAMPLE = `BEGIN:VCARD
VERSION:3.0
N:;Carlos;;;
FN:Carlos
item1.TEL;waid=5491161862313:+54 9 11 6186-2313
item1.X-ABLabel:Casa
END:VCARD`;

test('parseVCard reads FN, TEL and waid from a WhatsApp share', () => {
  assert.deepEqual(parseVCard(SAMPLE), {
    name: 'Carlos',
    phone: '+54 9 11 6186-2313',
    waid: '5491161862313',
  });
});

test('parseVCards joins a multi-contact body', () => {
  const second = SAMPLE.replace('Carlos', 'Ana').replace('5491161862313', '5491111111111');
  const cards = parseVCards(`${SAMPLE}\n${second}`);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'Carlos');
  assert.equal(cards[1].name, 'Ana');
});

test('contactSnippet prefers name · phone over raw vCard text', () => {
  assert.equal(contactSnippet(SAMPLE, 'Contact'), 'Carlos · +54 9 11 6186-2313');
  assert.equal(contactSnippet('BEGIN:VCARD\nEND:VCARD', 'Contact'), 'Contact');
  assert.equal(isVCardBody(SAMPLE), true);
  assert.equal(isVCardBody('hello'), false);
});
