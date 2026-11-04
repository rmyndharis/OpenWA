import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// A 1fr track is minmax(auto, 1fr): it never shrinks below the min-content of the card in it. The error and
// restriction lines of a card do not wrap, so one long value widened its track past the page and pushed the
// other columns (every card on a phone) out of the viewport.
const rules = readRules(new URL('./Sessions.css', import.meta.url));

test('every sessions grid track can shrink below the width of its content', () => {
  const grids = rules.filter(r => r.selectors.includes('.sessions-page .sessions-grid'));
  assert.ok(grids.length > 0, 'no .sessions-grid rule found');
  for (const grid of grids) {
    const columns = decl(grid.body, 'grid-template-columns') ?? '';
    assert.match(columns, /minmax\(0, 1fr\)/, `${grid.media || 'default'}: grid-template-columns: ${columns}`);
  }
});
