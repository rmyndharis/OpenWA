import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// On a phone the key table becomes a stack of cards. The name keeps white-space: nowrap from the table layout,
// so a long name ran out of its card and out of the viewport.
const rules = readRules(new URL('./ApiKeys.css', import.meta.url));

test('a long key name wraps inside its card on a phone', () => {
  const card = rules.filter(
    r =>
      r.media === '@media (max-width: 768px)' &&
      r.selectors.includes('.api-keys-page .keys-table tbody tr.table-row td:first-child .name-cell'),
  );
  assert.equal(card.length, 1, 'no mobile rule for the name in the card');
  assert.equal(decl(card[0].body, 'white-space'), 'normal');
  assert.equal(decl(card[0].body, 'overflow-wrap'), 'anywhere');
});
