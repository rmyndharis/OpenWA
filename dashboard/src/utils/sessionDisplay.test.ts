import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TFunction } from 'i18next';
import { formatLastActive, formatSessionStatus } from './sessionDisplay.ts';

// A stand-in that shows which key and values the phrase was asked for.
const t = ((key: string, options?: { count?: number; defaultValue?: string }) =>
  options?.count !== undefined ? `${key}:${options.count}` : (options?.defaultValue ?? key)) as unknown as TFunction;

const NOW = Date.parse('2026-10-20T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

test('formatLastActive: a missing date reads as never', () => {
  assert.equal(formatLastActive(t, null, NOW), 'common.never');
  assert.equal(formatLastActive(t, undefined, NOW), 'common.never');
});

test('formatLastActive: phrases up to a day, in minutes then hours', () => {
  assert.equal(formatLastActive(t, ago(30_000), NOW), 'common.justNow');
  assert.equal(formatLastActive(t, ago(5 * 60_000), NOW), 'common.minAgo:5');
  assert.equal(formatLastActive(t, ago(59 * 60_000), NOW), 'common.minAgo:59');
  // The Sessions page used to skip this step and show a date for a session active five hours ago.
  assert.equal(formatLastActive(t, ago(5 * 3_600_000), NOW), 'common.hoursAgo:5');
});

test('formatLastActive: a day or more ago is the date', () => {
  assert.equal(formatLastActive(t, ago(25 * 3_600_000), NOW), new Date(NOW - 25 * 3_600_000).toLocaleDateString());
});

test('formatSessionStatus: an unknown status shows as it is', () => {
  assert.equal(formatSessionStatus(t, 'brand_new'), 'brand_new');
});
