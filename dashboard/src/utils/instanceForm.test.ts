import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidInstanceId, isValidInstanceSecret, parseInstanceConfig } from './instanceForm.ts';

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
  assert.equal(isValidInstanceSecret('  5t7oive8SuXwrnVgLEQs88gm  '), true); // padded real secret trims to valid
});

test('parseInstanceConfig: blank → undefined, object → parsed, invalid → not ok', () => {
  assert.deepEqual(parseInstanceConfig('   '), { ok: true, value: undefined });
  assert.deepEqual(parseInstanceConfig('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.equal(parseInstanceConfig('nope').ok, false);
  assert.equal(parseInstanceConfig('[1,2]').ok, false); // array is not a config object
});
