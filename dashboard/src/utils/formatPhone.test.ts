import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhoneFromJid, formatPhoneForDisplay, isolateNumber, chatTitle } from './formatPhone.ts';

test('parsePhoneFromJid extracts digits from a personal @c.us JID', () => {
  assert.equal(parsePhoneFromJid('628123456789@c.us'), '628123456789');
});

test('parsePhoneFromJid strips the :device suffix on group-participant ids', () => {
  assert.equal(parsePhoneFromJid('628123456789@c.us:7'), '628123456789');
});

test('parsePhoneFromJid returns null for group JIDs', () => {
  assert.equal(parsePhoneFromJid('120363abc@g.us'), null);
});

test('parsePhoneFromJid returns null for LID privacy ids', () => {
  assert.equal(parsePhoneFromJid('abcdef@lid'), null);
});

test('parsePhoneFromJid returns null for a DIGITS-ONLY LID (privacy ids are not phones)', () => {
  // The actual bug: a LID user part is all digits, so the digits check alone formatted it as a
  // fake phone number ("+26 281 346 125 0071"). The domain guard rejects it first.
  assert.equal(parsePhoneFromJid('262813461250071@lid'), null);
});

test('parsePhoneFromJid returns null for a digits-only GROUP id (not a phone either)', () => {
  assert.equal(parsePhoneFromJid('120363404149049457@g.us'), null);
});

test('parsePhoneFromJid returns null for broadcast/newsletter/status JIDs', () => {
  assert.equal(parsePhoneFromJid('status@broadcast'), null);
  assert.equal(parsePhoneFromJid('abc@newsletter'), null);
});

test('formatPhoneForDisplay formats a typical Indonesian number with 2-digit country code', () => {
  assert.equal(formatPhoneForDisplay('628123456789'), '+62 812 345 6789');
});

test('formatPhoneForDisplay formats a US-style 11-digit number with 1-digit country code', () => {
  assert.equal(formatPhoneForDisplay('14155552671'), '+1 415 555 2671');
});

test('formatPhoneForDisplay returns null for non-phone JIDs (group/lid)', () => {
  assert.equal(formatPhoneForDisplay('120363abc@g.us'), null);
  assert.equal(formatPhoneForDisplay('xyz@lid'), null);
});

test('formatPhoneForDisplay returns null for a digits-only LID instead of inventing a phone', () => {
  assert.equal(formatPhoneForDisplay('262813461250071@lid'), null);
});

test('formatPhoneForDisplay passes short codes through unchanged with a + prefix', () => {
  assert.equal(formatPhoneForDisplay('911'), '+911');
});

test('formatPhoneForDisplay accepts a raw JID as input (delegates to parsePhoneFromJid)', () => {
  assert.equal(formatPhoneForDisplay('628123456789@c.us'), '+62 812 345 6789');
});

test('formatPhoneForDisplay picks the country code by its ITU prefix: 3 digits, and 1 for +7', () => {
  assert.equal(formatPhoneForDisplay('971501234567'), '+971 501 234 567');
  assert.equal(formatPhoneForDisplay('2348012345678'), '+234 801 234 5678');
  assert.equal(formatPhoneForDisplay('8801712345678'), '+880 171 234 5678');
  assert.equal(formatPhoneForDisplay('79161234567'), '+7 916 123 4567');
  assert.equal(formatPhoneForDisplay('447911123456'), '+44 791 112 3456');
});

test('formatPhoneForDisplay never leaves a group shorter than three digits (#1940)', () => {
  assert.equal(formatPhoneForDisplay('4915733344455'), '+49 157 3334 4455');
  assert.equal(formatPhoneForDisplay('6281770008896'), '+62 817 7000 8896');
  assert.equal(formatPhoneForDisplay('5511987654321'), '+55 119 8765 4321');
  assert.equal(formatPhoneForDisplay('6591234567'), '+65 9123 4567');
  assert.equal(formatPhoneForDisplay('85291234567'), '+852 9123 4567');
  assert.equal(formatPhoneForDisplay('62812345678'), '+62 812 345 678');
  // Five digits after the code cannot be split into threes and fours, so they stay one group.
  assert.equal(formatPhoneForDisplay('29012345'), '+290 12345');
  for (let length = 6; length <= 15; length++) {
    const groups = formatPhoneForDisplay(`62${'8'.repeat(length)}`)!
      .split(' ')
      .slice(1);
    assert.equal(groups.join('').length, length);
    assert.ok(
      groups.every(group => group.length === 3 || group.length === 4),
      `${length} digits: ${groups.join(' ')}`,
    );
  }
});

test('isolateNumber keeps a number one left-to-right run inside a right-to-left sentence', () => {
  const lri = String.fromCodePoint(0x2066);
  const pdi = String.fromCodePoint(0x2069);
  assert.equal(isolateNumber('+49 170 123 4 5678'), `${lri}+49 170 123 4 5678${pdi}`);
});

test('chatTitle is the name, else the isolated number of a phone id, else the digits of any other id', () => {
  assert.equal(chatTitle({ id: '15550001111@c.us', name: 'Alice' }), 'Alice');
  assert.equal(chatTitle({ id: '15550001111@c.us', name: '' }), isolateNumber('+1 555 000 1111'));
  assert.equal(chatTitle({ id: '628123456789@s.whatsapp.net' }), isolateNumber('+62 812 345 6789'));
  // A privacy id and a group id are digits too, and no phone number.
  assert.equal(chatTitle({ id: '262813461250071@lid', name: '' }), '262813461250071');
  assert.equal(chatTitle({ id: '120363000000000001@g.us', name: '' }), '120363000000000001');
});
