import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDurationMinutes } from './formatDuration.ts';

test('keeps route durations shorter than one hour in minutes', () => {
  assert.equal(formatDurationMinutes(42), '42 min');
});

test('formats longer route durations in hours and remaining minutes', () => {
  assert.equal(formatDurationMinutes(60), '1h');
  assert.equal(formatDurationMinutes(85), '1h 25min');
  assert.equal(formatDurationMinutes(120), '2h');
});

test('handles unavailable and invalid route durations', () => {
  assert.equal(formatDurationMinutes(null), '—');
  assert.equal(formatDurationMinutes(undefined), '—');
  assert.equal(formatDurationMinutes(Number.NaN), '—');
});
