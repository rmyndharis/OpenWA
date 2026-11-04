import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// A filter row never wrapped: the field and operator keep fixed bases, so in a phone-width dialog the value input
// was squeezed to 20 px (0 px at 360) and the remove button pushed out of the row. Below 600px the field and the
// operator share the first row, and the value and the remove button the second, in the order they have in the page.
const rules = readRules(new URL('./FilterBuilder.css', import.meta.url));
const narrow = rules.filter(r => r.media === '@media (max-width: 600px)');
const body = (selector: string): string => narrow.find(r => r.selectors.includes(selector))?.body ?? '';

test('a filter row wraps on a phone', () => {
  assert.equal(decl(body('.filter-row'), 'flex-wrap'), 'wrap');
});

test('the filter value shares a row with the remove button on a phone, without reordering', () => {
  assert.equal(decl(body('.filter-value'), 'flex'), '1 1 calc(100% - 3.5rem)');
  // order would move the value before the remove button on screen and leave the keyboard order behind.
  assert.equal(decl(body('.filter-value'), 'order'), undefined);
});

test('the field and the operator share the first row', () => {
  for (const selector of ['.filter-field', '.filter-operator']) {
    assert.equal(decl(body(selector), 'flex'), '1 1 6rem', selector);
  }
});
