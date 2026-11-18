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

// Every cell keeps its text on one line, so the table needs from about 1180px of window beside the 260px sidebar (two
// plain keys, in Arabic) to about 1450px (a key with IP, chat and expiry limits, in German), and the cards start only
// at 768px. Over that range the row actions (edit, revoke, delete) were the cell that ran out of the scroll container,
// and nothing at rest says an overlay scrollbar has more to show. Hiding columns or starting the cards later does not
// fit: the width the table needs depends on the keys and the language, and the limits are what an admin checks before
// a revoke. So the last cell is pinned to the inline end of the container: the actions stay in reach at any width and
// in either direction.
const TABLE = '.api-keys-page .keys-table';
const HEADER_CELL = `${TABLE} thead tr.table-row.header th:last-child`;
const ROW_CELL = `${TABLE} tbody tr.table-row td:last-child`;
// Starts where (max-width: 768px), the cards, ends: 768.02px is the first width that query no longer matches.
const TABLE_LAYOUT = '@media (min-width: 768.02px)';

test('the row actions stay in reach at the inline end of a table wider than its container', () => {
  const pinned = rules.filter(
    r => r.selectors.includes(HEADER_CELL) && r.selectors.includes(ROW_CELL) && decl(r.body, 'position') === 'sticky',
  );
  assert.equal(pinned.length, 1, 'expected one rule that pins the actions cell');
  assert.equal(pinned[0].media, TABLE_LAYOUT, 'the actions cell is pinned outside the table layout');
  assert.equal(decl(pinned[0].body, 'inset-inline-end'), '0');
});

// What the pin covers at rest is as wide as the table is over its container, and every column's cell padding is part of
// that width: at 1.5rem the table needed 128px more of window than at 1rem, and the pin covered the Last
// used column on a 1440px window. The phone cards set their own padding.
test('the table cells take 1rem of inline padding, so the pin has little to cover on a laptop window', () => {
  for (const selector of [`${TABLE} thead tr.table-row.header th`, `${TABLE} tbody tr.table-row td`]) {
    const own = rules.filter(r => r.media === '' && r.selectors.includes(selector));
    assert.equal(own.length, 1, `expected one rule for ${selector}`);
    assert.equal(decl(own[0].body, 'padding'), '1.125rem 1rem');
  }
});

test('the phone cards leave their action row where it is', () => {
  const phone = rules.filter(
    r => r.media === '@media (max-width: 768px)' && r.selectors.some(s => s === HEADER_CELL || s === ROW_CELL),
  );
  assert.ok(phone.length > 0, 'expected the card rules for the last cell');
  for (const r of phone) assert.equal(decl(r.body, 'position'), undefined, `${r.selectors.join(', ')} pins the cell`);
});

// The pinned cell hides what slides under it, so it cannot be as translucent as its row: it paints the tint of the
// row it is in over white, in each state of the row (rest, even, hover), and the header cell keeps its own opaque fill.
test('the pinned cell is opaque and keeps the tint of its row', () => {
  const background = (media: string, selector: string): string => {
    const own = rules.find(r => r.media === media && r.selectors.includes(selector) && decl(r.body, 'background'));
    assert.ok(own, `no rule for ${selector}`);
    return decl(own.body, 'background')!.replace(/\s+/g, ' ');
  };
  const over = (tint: string): string => `linear-gradient(${tint}, ${tint}), var(--bg-white)`;
  assert.equal(background('', `${TABLE} thead tr.table-row.header th`), 'var(--bg-light)');
  assert.equal(background(TABLE_LAYOUT, ROW_CELL), 'var(--bg-white)');
  for (const state of [':nth-child(even)', ':hover']) {
    assert.equal(
      background(TABLE_LAYOUT, `${TABLE} tbody tr.table-row${state} td:last-child`),
      over(background('', `${TABLE} tbody tr.table-row${state}`)),
      `the pinned cell of a ${state} row is not its tint over white`,
    );
  }
});
