import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideScroll, type ScrollGeometry } from './scrollDecision.ts';

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
