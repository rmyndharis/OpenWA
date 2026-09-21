import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fromLocalDateTimeValue,
  isPastCalendarDay,
  isPastHour,
  isPastMinute,
  toLocalDateTimeValue,
} from '../utils/workflowDateTime.ts';

test('keeps the selected wall-clock value instead of converting it to UTC', () => {
  const date = fromLocalDateTimeValue('2026-09-13T10:05');
  assert.ok(date);
  assert.equal(toLocalDateTimeValue(date), '2026-09-13T10:05');
});

test('blocks past days but keeps today available for a later time', () => {
  const now = new Date(2026, 8, 12, 14, 30);
  assert.equal(isPastCalendarDay(new Date(2026, 8, 11), now), true);
  assert.equal(isPastCalendarDay(new Date(2026, 8, 12), now), false);
  assert.equal(isPastCalendarDay(new Date(2026, 8, 13), now), false);
});

test('blocks only hours and minutes that can no longer produce a future appointment', () => {
  const now = new Date(2026, 8, 12, 14, 30, 30);
  const selectedDay = new Date(2026, 8, 12, 14, 0);
  assert.equal(isPastHour(13, selectedDay, now), true);
  assert.equal(isPastHour(14, selectedDay, now), false);
  assert.equal(isPastMinute(30, selectedDay, now), true);
  assert.equal(isPastMinute(31, selectedDay, now), false);
});
