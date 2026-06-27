import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRestoreTarget } from './useChatScrollPosition.ts';

test('no chat selected → no restore', () => {
  assert.equal(decideRestoreTarget(null, true, undefined), null);
});

test('chat selected but content not loaded yet → no restore', () => {
  assert.equal(decideRestoreTarget('A', false, undefined), null);
});

test('first visit (loaded, no remembered position) → jump to bottom', () => {
  assert.equal(decideRestoreTarget('A', true, undefined), 'bottom');
});

test('return visit (loaded, remembered position exists) → restore saved', () => {
  assert.equal(decideRestoreTarget('A', true, 250), 'saved');
});

test('a remembered position of 0 is real (user was at the top) → restore saved, not bottom', () => {
  assert.equal(decideRestoreTarget('A', true, 0), 'saved');
});

test('cold open: loading first (null), then loaded transition restores to bottom on first visit', () => {
  assert.equal(decideRestoreTarget('A', false, undefined), null);
  assert.equal(decideRestoreTarget('A', true, undefined), 'bottom');
});
