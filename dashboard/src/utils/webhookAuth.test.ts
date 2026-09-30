import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeaderMap, generateSecret, secretError } from './webhookAuth.ts';

const err = (rows: { name: string; value: string }[]) => {
  const result = buildHeaderMap(rows);
  return result.ok ? null : result.error;
};

test('a valid map is built with values exactly as typed and blank rows skipped', () => {
  assert.deepEqual(
    buildHeaderMap([
      { name: 'Authorization', value: ' Bearer abc ' },
      { name: '', value: '' },
      { name: 'X-Empty', value: '' },
      { name: 'X-Latin', value: 'café' },
    ]),
    { ok: true, headers: { Authorization: ' Bearer abc ', 'X-Empty': '', 'X-Latin': 'café' } },
  );
  assert.deepEqual(buildHeaderMap([]), { ok: true, headers: {} });
});

test('names outside letters, digits and hyphens are refused', () => {
  for (const name of ['X Auth', 'a:b', 'X_Auth', '']) {
    assert.equal(err([{ name, value: 'v' }]), 'webhooks.auth.errors.headerName', JSON.stringify(name));
  }
});

test('values with control characters, DEL, non-Latin-1 characters or over 1024 characters are refused', () => {
  for (const value of ['a\tb', 'a\r\nb', 'a\u007fb', '€5', 'x'.repeat(1025)]) {
    assert.equal(err([{ name: 'X-A', value }]), 'webhooks.auth.errors.headerValue', JSON.stringify(value));
  }
  assert.equal(err([{ name: 'X-A', value: 'x'.repeat(1024) }]), null);
});

test('names the gateway drops at delivery are refused', () => {
  const names = [
    'Content-Type',
    'User-Agent',
    'user-agent',
    'X-OpenWA-Signature',
    'Transfer-Encoding',
    'connection',
    'TE',
  ];
  for (const name of names) {
    assert.equal(err([{ name, value: 'v' }]), 'webhooks.auth.errors.headerReserved', name);
  }
  assert.equal(err([{ name: 'Tenant', value: 'v' }]), null);
});

test('a name repeated in another case is refused', () => {
  assert.equal(
    err([
      { name: 'X-A', value: '1' },
      { name: 'x-a', value: '2' },
    ]),
    'webhooks.auth.errors.headerDuplicate',
  );
});

test('more than 50 headers are refused', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `X-H${i}`, value: 'v' }));
  assert.equal(err(rows(50)), null);
  assert.equal(err(rows(51)), 'webhooks.auth.errors.tooMany');
});

test('a secret is empty or 16 to 255 characters, and is not trimmed', () => {
  assert.equal(secretError(''), null);
  assert.equal(secretError('x'.repeat(15)), 'webhooks.auth.errors.secretLength');
  assert.equal(secretError('x'.repeat(16)), null);
  assert.equal(secretError('x'.repeat(255)), null);
  assert.equal(secretError('x'.repeat(256)), 'webhooks.auth.errors.secretLength');
  assert.equal(secretError(`  ${'x'.repeat(12)}  `), null);
  assert.equal(secretError(`  ${'x'.repeat(10)}  `), 'webhooks.auth.errors.secretLength');
});

test('a generated secret is 64 hex characters and passes the length check', () => {
  const secret = generateSecret();
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(secretError(secret), null);
  assert.notEqual(generateSecret(), secret);
});
