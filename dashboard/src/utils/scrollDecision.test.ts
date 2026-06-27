import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideScroll,
  isAwayFromBottom,
  isNearTop,
  anchorScrollTopAfterPrepend,
  type ScrollGeometry,
} from './scrollDecision.ts';

const at = (scrollTop: number, scrollHeight = 1000, clientHeight = 500): ScrollGeometry => ({
  scrollTop, scrollHeight, clientHeight,
});

test('outgoing message always scrolls to bottom', () => {
  // User scrolled way up (0).
  assert.equal(decideScroll('outgoing', at(0)), 'bottom');
});

test('incoming message scrolls to bottom when user is near bottom (default 100px)', () => {
  // gap = scrollHeight - scrollTop - clientHeight = 1000 - 450 - 500 = 50 < 100
  assert.equal(decideScroll('incoming', at(450)), 'bottom');
});

test('incoming message preserves position when user is far from bottom', () => {
  // gap = 1000 - 100 - 500 = 400 > 100
  assert.equal(decideScroll('incoming', at(100)), 'preserve');
});

test('incoming message at exact bottom scrolls (gap = 0)', () => {
  // gap = 1000 - 500 - 500 = 0 < 100
  assert.equal(decideScroll('incoming', at(500)), 'bottom');
});

test('incoming message exactly at threshold preserves (gap = 100 is NOT < 100)', () => {
  // gap = 1000 - 400 - 500 = 100, strictly < 100 is false
  assert.equal(decideScroll('incoming', at(400)), 'preserve');
});

test('custom threshold overrides default', () => {
  // gap = 200, threshold 300 → bottom
  assert.equal(decideScroll('incoming', at(300), 300), 'bottom');
});

// isAwayFromBottom drives the "jump to bottom" button visibility.
test('isAwayFromBottom: false when pinned to the bottom (gap = 0)', () => {
  assert.equal(isAwayFromBottom(at(500)), false);
});

test('isAwayFromBottom: true when scrolled up past the default threshold', () => {
  // gap = 1000 - 100 - 500 = 400 > 240
  assert.equal(isAwayFromBottom(at(100)), true);
});

test('isAwayFromBottom: false within the threshold band (gap just under 240)', () => {
  // gap = 1000 - 270 - 500 = 230, not > 240
  assert.equal(isAwayFromBottom(at(270)), false);
});

test('isAwayFromBottom: custom threshold is honored', () => {
  // gap = 1000 - 400 - 500 = 100; with threshold 50 → away
  assert.equal(isAwayFromBottom(at(400), 50), true);
});

// isNearTop triggers loading older messages when the user scrolls up to the top of the thread.
test('isNearTop: true at the very top (scrollTop 0)', () => {
  assert.equal(isNearTop(0), true);
});

test('isNearTop: true within the default threshold (120)', () => {
  assert.equal(isNearTop(80), true);
});

test('isNearTop: false once scrolled down past the threshold', () => {
  assert.equal(isNearTop(200), false);
});

test('isNearTop: honors a custom threshold', () => {
  assert.equal(isNearTop(40, 30), false);
});

// anchorScrollTopAfterPrepend keeps the same messages in view after older ones are prepended:
// the content above grew by (newHeight - prevHeight), so scrollTop must grow by the same delta.
test('anchorScrollTopAfterPrepend: shifts scrollTop by the height added on top', () => {
  // was at 300, content grew 1000 -> 1600 (added 600 above) → 300 + 600 = 900
  assert.equal(anchorScrollTopAfterPrepend(300, 1000, 1600), 900);
});

test('anchorScrollTopAfterPrepend: no growth leaves scrollTop unchanged', () => {
  assert.equal(anchorScrollTopAfterPrepend(300, 1000, 1000), 300);
});
