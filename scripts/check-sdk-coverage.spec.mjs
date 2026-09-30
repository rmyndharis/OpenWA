import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPythonLiterals, undeclaredVerbPairs } from './check-sdk-coverage.mjs';

const specByPath = new Map([
  ['/api/sessions/*/groups/*', { get: {} }],
  ['/api/sessions/*/webhooks/*', { put: {}, delete: {} }],
]);

test('undeclaredVerbPairs flags a verb the contract does not declare on a single-verb path', () => {
  assert.deepEqual(undeclaredVerbPairs('python', new Set(['POST /api/sessions/*/groups/*']), specByPath), [
    'POST /api/sessions/*/groups/*: built by python, not declared by the contract',
  ]);
  assert.deepEqual(undeclaredVerbPairs('python', new Set(['GET /api/sessions/*/groups/*']), specByPath), []);
});

test('undeclaredVerbPairs flags a wrong verb on a multi-verb path', () => {
  const pairs = new Set(['PUT /api/sessions/*/webhooks/*', 'PATCH /api/sessions/*/webhooks/*']);
  assert.deepEqual(undeclaredVerbPairs('go', pairs, specByPath), [
    'PATCH /api/sessions/*/webhooks/*: built by go, not declared by the contract',
  ]);
});

test('undeclaredVerbPairs ignores a pair that is not a contract path', () => {
  assert.deepEqual(undeclaredVerbPairs('javascript', new Set(['POST /api/sessions/*/messages/*']), specByPath), []);
});

test('joinPythonLiterals joins a path split across adjacent literals', () => {
  const expr = 'f"/api/sessions/{a}/groups/{b}"\n            "/membership-requests/approve"';
  assert.equal(joinPythonLiterals(expr), '/api/sessions/{a}/groups/{b}/membership-requests/approve');
});
