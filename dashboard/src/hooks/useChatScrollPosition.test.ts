import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRestoreTarget } from './useChatScrollPosition.ts';

test('first render with no previous chat: no save, restore to bottom if loaded', () => {
  assert.deepEqual(
    decideRestoreTarget(null, 'A', false, true, undefined),
    { save: null, restore: 'bottom' },
  );
});

test('first render still loading: no save, no restore', () => {
  assert.deepEqual(
    decideRestoreTarget(null, 'A', false, false, undefined),
    { save: null, restore: null },
  );
});

test('first-visit cold open: enter A while loading, then loaded transition restores to bottom', () => {
  // First effect run: enter A, not yet loaded → no save (no prev), no restore.
  assert.deepEqual(
    decideRestoreTarget(null, 'A', false, false, undefined),
    { save: null, restore: null },
  );
  // Second effect run after data lands: same chat, becomes loaded → restore to bottom.
  assert.deepEqual(
    decideRestoreTarget('A', 'A', false, true, undefined),
    { save: null, restore: 'bottom' },
  );
});

test('switch from loaded chat A to loaded cached chat B: save A, restore B saved', () => {
  assert.deepEqual(
    decideRestoreTarget('A', 'B', true, true, 250),
    { save: 'previous', restore: 'saved' },
  );
});

test('switch from loaded A to uncached B (still loading): save A, no restore yet', () => {
  assert.deepEqual(
    decideRestoreTarget('A', 'B', true, false, undefined),
    { save: 'previous', restore: null },
  );
});

test('switch from loaded A to uncached B, then B finishes loading: do not double-save A', () => {
  // Step 1: switch A → B, B loading → save A, no restore.
  assert.deepEqual(
    decideRestoreTarget('A', 'B', true, false, undefined),
    { save: 'previous', restore: null },
  );
  // Step 2: same chat B, transitions to loaded → no save (prev === next), restore B to bottom (first visit).
  assert.deepEqual(
    decideRestoreTarget('B', 'B', false, true, undefined),
    { save: null, restore: 'bottom' },
  );
});

test('switch B → A where A was unloaded when last left: do not save B against a spinner-snapshot of A', () => {
  // prevLoaded=false signals B was on the spinner branch → do NOT save its zero scrollTop.
  assert.deepEqual(
    decideRestoreTarget('B', 'A', false, true, 320),
    { save: null, restore: 'saved' },
  );
});

test('deselect chat (next is null): no save (cant write null key), no restore', () => {
  assert.deepEqual(
    decideRestoreTarget('A', null, true, false, undefined),
    { save: null, restore: null },
  );
});
