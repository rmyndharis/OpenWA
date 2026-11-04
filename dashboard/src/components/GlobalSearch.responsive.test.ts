import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// The search box keeps a 12rem minimum and the scope checkbox beside it is a nowrap label. In the page header of a
// 320px window the two did not fit in Italian ("Solo sessione corrente" pushed the label 8px past the page edge) and
// came out of the header's box in German, French and Traditional Chinese. The label wraps under the box when it does
// not fit beside it.
const rules = readRules(new URL('./GlobalSearch.css', import.meta.url));

test('the scope checkbox wraps under the search box when they do not fit on one line', () => {
  const row = rules.filter(r => !r.media && r.selectors.includes('.global-search'));
  assert.equal(row.length, 1, 'expected one base rule for the search row');
  assert.equal(decl(row[0].body, 'flex-wrap'), 'wrap');
});
