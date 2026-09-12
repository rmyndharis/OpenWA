import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canScopeSessions,
  sameSessionScope,
  sessionPickerStartsExpanded,
  sessionScopeNames,
  sessionScopeRows,
} from './sessionScope.ts';

test('operator, companion_operator, and viewer keys can be session-scoped in the dashboard', () => {
  assert.equal(canScopeSessions('operator'), true);
  assert.equal(canScopeSessions('companion_operator'), true);
  assert.equal(canScopeSessions('viewer'), true);
  assert.equal(canScopeSessions('admin'), false);
  assert.equal(canScopeSessions(''), false);
});

test('an empty or missing allowlist means every session', () => {
  const sessions = [
    { id: 'a', name: 'Sales' },
    { id: 'b', name: 'Support' },
  ];
  assert.equal(sessionScopeNames(undefined, sessions), null);
  assert.equal(sessionScopeNames(null, sessions), null);
  assert.equal(sessionScopeNames([], sessions), null);
});

test('the session picker stays collapsed until sessions are already chosen', () => {
  assert.equal(sessionPickerStartsExpanded([]), false);
  assert.equal(sessionPickerStartsExpanded(['a']), true);
});

test('a selected allowlist resolves to session names, falling back to the id', () => {
  const sessions = [
    { id: 'a', name: 'Sales' },
    { id: 'b', name: 'Support' },
  ];
  assert.deepEqual(sessionScopeNames(['b', 'missing'], sessions), ['Support', 'missing']);
});

test('an unchanged selection is recognised so the save is skipped, and a reorder is not a change', () => {
  assert.equal(sameSessionScope([], []), true);
  assert.equal(sameSessionScope(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameSessionScope(['a'], []), false);
  assert.equal(sameSessionScope([], ['a']), false);
  assert.equal(sameSessionScope(['a', 'b'], ['a', 'c']), false);
});

test('the picker lists a selected id whose session is gone, so it can be unticked', () => {
  const sessions = [
    { id: 'a', name: 'Sales' },
    { id: 'b', name: 'Support' },
  ];
  assert.deepEqual(sessionScopeRows(sessions, []), [
    { id: 'a', session: sessions[0] },
    { id: 'b', session: sessions[1] },
  ]);
  assert.deepEqual(sessionScopeRows(sessions, ['b', 'deleted', 'deleted']), [
    { id: 'a', session: sessions[0] },
    { id: 'b', session: sessions[1] },
    { id: 'deleted' },
  ]);
  // Every session deleted but the allowlist still names one: the row survives, so the empty state
  // does not swallow the only control that can clear it.
  assert.deepEqual(sessionScopeRows([], ['deleted']), [{ id: 'deleted' }]);
});
