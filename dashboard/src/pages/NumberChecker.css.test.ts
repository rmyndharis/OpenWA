import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The page sits in a container that clips what sticks out sideways, so on a phone a card or table wider than
// the screen is cut off instead of scrolling. jsdom has no layout; these rules are what keeps it narrow-safe.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'NumberChecker.css'), 'utf8');

test('the grid tracks can shrink below their content', () => {
  const tracks = [...css.matchAll(/\.nc-grid\s*\{[^}]*grid-template-columns:\s*([^;]+);/g)].map(match => match[1]);
  assert.deepEqual(tracks, ['repeat(2, minmax(0, 1fr))', 'minmax(0, 1fr)']);
});

test('the table container scrolls sideways', () => {
  const rule = /\.number-checker \.nc-table-wrap\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'no rule for the table container');
  assert.match(rule[1], /overflow-x:\s*auto/);
});

// Long labels in the other languages ("Massenpruefung", a Telugu export button) do not fit one row at 320 to 390 px.
for (const [what, selector] of [
  ['the mode tab strip', '\\.nc-tabs'],
  ['the page header title row, so its badge drops below the title', '\\.page-header__title-group'],
  ['the format preview pill', '\\.nc-format-pill'],
] as const) {
  test(`${what} wraps instead of running past the screen`, () => {
    const rules = [...css.matchAll(new RegExp(`\\.number-checker[^{]*${selector}\\s*\\{([^}]*)\\}`, 'g'))].map(
      m => m[1],
    );
    assert.ok(rules.length > 0, `no rule for ${what}`);
    assert.ok(
      rules.some(rule => /flex-wrap:\s*wrap/.test(rule)),
      `${what} does not wrap`,
    );
  });
}
