import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/react-query';
import { clearActorState, resolveStartupValidation } from './authLifecycle.ts';

test('logout cleanup wipes the React Query cache (no cross-actor residue)', () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['sessions'], [{ id: 's1' }]);
  queryClient.setQueryData(['apiKeys'], [{ id: 'k1' }]);
  queryClient.setQueryData(['logs', { page: 1 }], [{ id: 'a1' }]);

  clearActorState(queryClient);

  assert.equal(queryClient.getQueryData(['sessions']), undefined);
  assert.equal(queryClient.getQueryData(['apiKeys']), undefined);
  assert.equal(queryClient.getQueryCache().getAll().length, 0);
});

test('logout cleanup calls clear() on every provided cache', () => {
  const calls: string[] = [];
  const cache = (name: string) => ({ clear: () => calls.push(name) });
  clearActorState(cache('a'), cache('b'));
  assert.deepEqual(calls, ['a', 'b']);
});

test('startup validation: 401/403 (revoked/demoted/restricted key) → logout', () => {
  assert.deepEqual(resolveStartupValidation(401, null), { action: 'logout' });
  assert.deepEqual(resolveStartupValidation(401, { valid: true, role: 'admin' }), { action: 'logout' });
  assert.deepEqual(resolveStartupValidation(403, null), { action: 'logout' });
});

test('startup validation: 429/5xx keeps the cached role (transient failure, not a revoked key)', () => {
  for (const status of [429, 500, 502, 503]) {
    assert.deepEqual(resolveStartupValidation(status, null), { action: 'keep' }, `status ${status}`);
    // Even a stray valid-looking body cannot upgrade a non-ok answer to a role refresh.
    assert.deepEqual(resolveStartupValidation(status, { valid: true, role: 'admin' }), { action: 'keep' });
  }
});

test('startup validation: ok + role refreshes the cached role from the server', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'viewer' }), {
    action: 'role',
    role: 'viewer',
  });
});

test('startup validation: ok without a usable role keeps the cached role', () => {
  assert.deepEqual(resolveStartupValidation(200, { valid: false }), { action: 'keep' });
  assert.deepEqual(resolveStartupValidation(200, { valid: true, role: 'superuser' }), { action: 'keep' });
  assert.deepEqual(resolveStartupValidation(200, null), { action: 'keep' });
});
