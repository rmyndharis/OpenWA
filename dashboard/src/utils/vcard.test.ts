import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactCards, contactSnippet, isVCardBody, parseVCard, parseVCards } from './vcard.ts';
import { isolateNumber } from './formatPhone.ts';

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
  const second = SAMPLE.replaceAll('Carlos', 'Ana').replace('5491161862313', '5491111111111');
  const cards = parseVCards(`${SAMPLE}\n${second}`);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].name, 'Carlos');
  assert.equal(cards[1].name, 'Ana');
});

test('contactSnippet prefers name · phone over raw vCard text', () => {
  assert.equal(contactSnippet(SAMPLE, 'Contact'), `Carlos · ${isolateNumber('+54 9 11 6186-2313')}`);
  assert.equal(contactSnippet('BEGIN:VCARD\nEND:VCARD', 'Contact'), 'Contact');
  assert.equal(isVCardBody(SAMPLE), true);
  assert.equal(isVCardBody('hello'), false);
});

test('parseVCard takes FN over N wherever N stands', () => {
  // WhatsApp writes N first, and N alone drops the prefix.
  const card =
    'BEGIN:VCARD\nVERSION:3.0\nN:Doe;John;;Dr.;\nFN:Dr. John Doe\nTEL;waid=15550009999:+1 555 000 9999\nEND:VCARD';
  assert.equal(parseVCard(card).name, 'Dr. John Doe');
  assert.equal(parseVCard(card.replace('FN:Dr. John Doe\n', '')).name, 'John Doe');
});

test('text that is not a vCard is never read as one', () => {
  assert.deepEqual(parseVCards('FN:Mallory\nTEL:+1 555 000 0000'), []);
  assert.equal(contactSnippet('Note: FN:Mallory', 'Contact'), 'Note: FN:Mallory');
});

test('contactCards names a contact the gateway sent by its stored body', () => {
  assert.deepEqual(contactCards('📇 Carol Jones'), [{ name: 'Carol Jones', phone: '', waid: '' }]);
  assert.deepEqual(contactCards(SAMPLE), [parseVCard(SAMPLE)]);
  assert.deepEqual(contactCards(''), []);
  assert.deepEqual(contactCards(undefined), []);
  assert.deepEqual(contactCards('📇 '), []);
  assert.deepEqual(contactCards('BEGIN:VCARD\nEND:VCARD'), []);
});
