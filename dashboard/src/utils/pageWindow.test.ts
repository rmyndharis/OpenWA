import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageWindow } from './pageWindow.ts';

test('returns empty for no pages', () => {
  assert.deepEqual(pageWindow(1, 0), []);
});

test('small tables show every page (identity)', () => {
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(3, 5), [1, 2, 3, 4, 5]);
});

test('window stays anchored at the start near the first pages', () => {
  assert.deepEqual(pageWindow(1, 10), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageWindow(2, 10), [1, 2, 3, 4, 5]);
});

test('window centers on the current page in the middle', () => {
  assert.deepEqual(pageWindow(6, 10), [4, 5, 6, 7, 8]);
});

test('window stays anchored at the end near the last pages (pages 6+ reachable)', () => {
  assert.deepEqual(pageWindow(10, 10), [6, 7, 8, 9, 10]);
  assert.deepEqual(pageWindow(9, 10), [6, 7, 8, 9, 10]);
});

test('clamps an out-of-range current page', () => {
  assert.deepEqual(pageWindow(0, 10), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageWindow(99, 10), [6, 7, 8, 9, 10]);
});

test('honors a custom window size', () => {
  assert.deepEqual(pageWindow(5, 10, 3), [4, 5, 6]);
});
