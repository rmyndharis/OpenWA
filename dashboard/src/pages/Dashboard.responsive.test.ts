import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// The sessions table has fixed 140, 200, 140 and 180 px tracks, so with the 260 px sidebar open the last column
// ran out of the card and the page from 769px up to about 1135px, and the flexible one was squeezed to a sliver
// up to about 1240px. It turns into cards, as it does on a phone, wherever those tracks do not fit.
const rules = readRules(new URL('./Dashboard.css', import.meta.url));
const ROW = '.dashboard .sessions-table .table-row';

test('the sessions table turns into cards at 1200px and below', () => {
  const cards = rules.filter(r => r.selectors.includes(ROW) && decl(r.body, 'display') === 'flex');
  assert.equal(cards.length, 1, 'expected one rule that turns a table row into a card');
  assert.equal(cards[0].media, '@media (max-width: 1200px)');
});

test('the table header goes away together with the columns', () => {
  const hidden = rules.filter(
    r => r.selectors.includes('.dashboard .sessions-table .table-header') && decl(r.body, 'display') === 'none',
  );
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].media, '@media (max-width: 1200px)');
});
