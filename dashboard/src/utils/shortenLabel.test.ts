import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolate, shortenLabel } from './shortenLabel.ts';

test('a label that fits is returned as it is', () => {
  assert.equal(shortenLabel('Anak Mama'), 'Anak Mama');
  assert.equal(shortenLabel('Yudhi Armyndhar'), 'Yudhi Armyndhar');
  assert.equal(shortenLabel('1234567890123456'), '1234567890123456');
  assert.equal(shortenLabel(''), '');
});

test('a long id keeps both ends and never exceeds the width', () => {
  const id = '120363251588904778';
  const out = shortenLabel(id);
  assert.equal(out, '12036325…8904778');
  assert.equal(Array.from(out).length, 16);
  assert.ok(out.startsWith(id.slice(0, 8)) && out.endsWith(id.slice(-7)));
});

test('a long name keeps its start', () => {
  const out = shortenLabel('Kopi Opsis Pemasaran Bersama');
  assert.equal(out, 'Kopi Opsis Pema…');
  assert.equal(Array.from(out).length, 16);
  assert.equal(shortenLabel('Yudhi Armyndharis'), 'Yudhi Armyndhar…');
});

test('a cut never splits an emoji', () => {
  // The 15th UTF-16 unit of this label is the first half of an emoji.
  const out = shortenLabel('Hustler Offer 🔥🔥🔥🔥🔥');
  assert.equal(out, 'Hustler Offer 🔥…');
  assert.equal(Array.from(out).length, 16);
});

test('the width can be set', () => {
  assert.equal(shortenLabel('abcdefghij', 5), 'abcd…');
  assert.equal(shortenLabel('1234567890', 5), '12…90');
});

test('a legacy group id, two runs of digits joined by a hyphen, keeps both ends', () => {
  // Every legacy group of one creator starts with the same creator number, so the start alone cannot tell them apart.
  assert.equal(shortenLabel('6281234567890-1612345678'), '62812345…2345678');
  assert.equal(shortenLabel('6281234567890-1612345678', 8), '6281…678');
  assert.equal(shortenLabel('62812345678-12'), '62812345678-12');
});

test('a cut never splits what the eye reads as one character', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const flag = '\u{1F1EE}\u{1F1E9}';
  assert.equal(shortenLabel(`Tim ${family}${family}${family}${family}`, 6), `Tim ${family}…`);
  assert.equal(shortenLabel(`Kantor ${flag}${flag}${flag}`, 9), `Kantor ${flag}…`);
  assert.equal(shortenLabel('a\u0301b\u0301c\u0301d\u0301e\u0301f\u0301', 4), 'a\u0301b\u0301c\u0301…');
});

test('a label is wrapped in a first-strong isolate so its ellipsis keeps its side', () => {
  assert.equal(isolate('abc'), '\u2068abc\u2069');
});
