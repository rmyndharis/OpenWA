import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules, type Rule } from '../../test-helpers/css-rules.ts';

// The search bar takes the place of the room header, so its close control is the only pointer way back to the
// header, and its date field the only way to pick a day. Both have to be drawn at every width: the two-pane desktop
// layout and the two single-pane blocks of Chats.css alike. The room's own Back button is not: Chats.css hides it
// outside the single-pane layouts, which is why the bar's close control must not share its class.
const rules = [
  ...readRules(new URL('./RoomSearch.css', import.meta.url)),
  ...readRules(new URL('../../pages/Chats.css', import.meta.url)),
];

/** The rules whose subject (the last compound of a selector) carries `className`, under any media condition. */
function rulesFor(className: string): Rule[] {
  const subject = new RegExp(`\\.${className}(?![\\w-])[^\\s>+~]*$`);
  return rules.filter(r => r.selectors.some(s => subject.test(s)));
}

const where = (r: Rule) => `${r.media || 'base'}: ${r.selectors.join(', ')}`;

// The classes RoomSearch.test.ts finds on the close control.
for (const className of ['room-search-close', 'icon-btn']) {
  test(`no rule hides .${className}, which the close control of the in-chat search carries, at any width`, () => {
    const own = rulesFor(className);
    assert.ok(
      own.some(r => !r.media),
      `expected a base rule for .${className}`,
    );
    assert.deepEqual(own.filter(r => decl(r.body, 'display') === 'none').map(where), []);
  });
}

test('the room Back button class, hidden in the two-pane layout, is still not one the search bar could borrow', () => {
  const base = rulesFor('room-back').filter(r => !r.media && decl(r.body, 'display') === 'none');
  assert.equal(base.length, 1, 'the premise of the close control having its own class no longer holds');
});

test('the search bar draws every control it has: none sits in an invisible or unclickable box', () => {
  const bar = readRules(new URL('./RoomSearch.css', import.meta.url));
  const unseen = bar.filter(
    r =>
      decl(r.body, 'display') === 'none' ||
      decl(r.body, 'visibility') === 'hidden' ||
      decl(r.body, 'opacity') === '0' ||
      decl(r.body, 'pointer-events') === 'none',
  );
  assert.deepEqual(unseen.map(where), []);
});
