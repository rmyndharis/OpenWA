import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidInstanceId, isValidInstanceSecret, parseEditScope, parseInstanceConfig } from './instanceForm.ts';

test('isValidInstanceId accepts the backend charset, rejects the rest', () => {
  assert.equal(isValidInstanceId('acme-support_1'), true);
  assert.equal(isValidInstanceId(''), false);
  assert.equal(isValidInstanceId('has space'), false);
  assert.equal(isValidInstanceId('a'.repeat(65)), false);
  assert.equal(isValidInstanceId('bad:colon'), false);
});

test('isValidInstanceSecret: blank → auto-generate, short → rejected, >=16 → accepted', () => {
  assert.equal(isValidInstanceSecret(''), true);
  assert.equal(isValidInstanceSecret('   '), true); // whitespace-only = blank
  assert.equal(isValidInstanceSecret('too-short'), false);
  assert.equal(isValidInstanceSecret('x'.repeat(15)), false);
  assert.equal(isValidInstanceSecret('x'.repeat(16)), true);
  assert.equal(isValidInstanceSecret('  0123456789abcdef01234567  '), true); // padded value trims to a valid length
});

test('parseInstanceConfig: blank → undefined, object → parsed, invalid → not ok', () => {
  assert.deepEqual(parseInstanceConfig('   '), { ok: true, value: undefined });
  assert.deepEqual(parseInstanceConfig('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.equal(parseInstanceConfig('nope').ok, false);
  assert.equal(parseInstanceConfig('[1,2]').ok, false); // array is not a config object
});

test('parseEditScope: a blank field resets a bound scope to all sessions', () => {
  assert.equal(parseEditScope('sess-a', ' sess-b '), 'sess-b');
  assert.equal(parseEditScope('sess-a', 'sess-a'), 'sess-a');
  assert.equal(parseEditScope(null, 'sess-b'), 'sess-b');
  // Blank on an all-sessions instance: omit, nothing changes.
  assert.equal(parseEditScope(null, '  '), undefined);
  // Blank on a scoped instance: null, which PATCH reads as all sessions (an omitted field would keep it).
  assert.equal(parseEditScope('sess-a', ''), null);
  assert.equal(parseEditScope('*', ''), null);
});

for (const [label, secret, valid] of [
  ['blank', '', true],
  ['whitespace', '   ', true],
  ['ASCII below minimum', 'x'.repeat(15), false],
  ['ASCII minimum', 'x'.repeat(16), true],
  ['ASCII maximum', 'x'.repeat(512), true],
  ['ASCII over maximum', 'x'.repeat(513), false],
  ['eight astral characters', '\u{1F600}'.repeat(8), false],
  ['astral below minimum', '\u{1F600}'.repeat(15), false],
  ['astral minimum', '\u{1F600}'.repeat(16), true],
  ['astral maximum', '\u{1F600}'.repeat(512), true],
  ['astral over maximum', '\u{1F600}'.repeat(513), false],
  ['presentation below minimum', '\u2764\uFE0F'.repeat(15), false],
  ['presentation minimum', '\u2764\uFE0F'.repeat(16), true],
  ['presentation maximum', '\u2764\uFE0F'.repeat(512), true],
  ['presentation over maximum', '\u2764\uFE0F'.repeat(513), false],
  ['padded valid astral secret', `  ${'\u{1F600}'.repeat(16)}  `, true],
] as const) {
  test(`instance secret validation: ${label}`, () => {
    assert.equal(isValidInstanceSecret(secret), valid);
  });
}
