import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRestoreTarget, isNearBottom } from './useChatScrollPosition.ts';

test('isNearBottom: exactly at the bottom counts as near', () => {
  assert.equal(isNearBottom(1000, 2000, 1000), true); // 2000-1000-1000 = 0
});

test('isNearBottom: within the 24px tolerance counts as near', () => {
  assert.equal(isNearBottom(980, 2000, 1000), true); // 20px above bottom
});

test('isNearBottom: beyond the tolerance does not count', () => {
  assert.equal(isNearBottom(500, 2000, 1000), false); // 500px above bottom
});

test('isNearBottom: a scrolled-to-top container is not near the bottom', () => {
  assert.equal(isNearBottom(0, 20000, 800), false);
});

test('first render with no saved position: restore to bottom when loaded', () => {
  assert.deepEqual(decideRestoreTarget('A', true, undefined), { restore: 'bottom' });
});

test('first render still loading: no restore', () => {
  assert.deepEqual(decideRestoreTarget('A', false, undefined), { restore: null });
});

test('cold open: loading transition then loaded → restore to bottom', () => {
  assert.deepEqual(decideRestoreTarget('A', false, undefined), { restore: null });
  assert.deepEqual(decideRestoreTarget('A', true, undefined), { restore: 'bottom' });
});

test('returning to a chat with a saved position restores it (never bottom-jumps)', () => {
  // The scroll listener saves the live scrollTop continuously, so a round trip A → B → A finds A's
  // real last position in the map and restores it exactly.
  assert.deepEqual(decideRestoreTarget('A', true, 250), { restore: 'saved' });
});

test('a saved position of 0 is still a saved position (top of thread is a real place)', () => {
  assert.deepEqual(decideRestoreTarget('A', true, 0), { restore: 'saved' });
});

test('deselect chat (next is null): no restore', () => {
  assert.deepEqual(decideRestoreTarget(null, false, undefined), { restore: null });
});
