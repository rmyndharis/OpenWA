import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../../test-helpers/css-rules.ts';

// A hit's snippet is message text somebody else wrote, cut with an ellipsis. Under the page's direction the ellipsis
// eats the wrong end of text written the other way round: in an Arabic or Hebrew page a Latin snippet wider than the
// list loses its start, and the highlighted match with it. Every box that cuts text somebody else chose takes its
// direction from its own characters (see Chats.css.card-text-direction.test.ts).
const rules = readRules(new URL('./RoomSearch.css', import.meta.url));

test('the hit snippet is cut by its own direction, not the page', () => {
  const body = rules
    .filter(r => r.selectors.some(s => s.endsWith('.room-search-hit-snippet')))
    .map(r => r.body)
    .join(';');
  assert.equal(decl(body, 'text-overflow'), 'ellipsis', 'the premise of this test no longer holds');
  assert.equal(decl(body, 'unicode-bidi'), 'plaintext');
});

// A snippet is a window around the match, so what the operator looks for sits in the middle of it, and a one-line
// ellipsis cuts the middle first once the room pane is narrow (about 590px at a 1280px window). It takes two lines,
// as the snippet of the sidebar search does.
test('the hit snippet takes two lines, so a narrow pane does not cut the match first', () => {
  const body = rules
    .filter(r => r.selectors.some(s => s.endsWith('.room-search-hit-snippet')))
    .map(r => r.body)
    .join(';');
  assert.notEqual(decl(body, 'white-space'), 'nowrap');
  assert.equal(decl(body, 'display'), '-webkit-box');
  assert.equal(decl(body, '-webkit-line-clamp'), '2');
  assert.equal(decl(body, 'line-clamp'), '2');
  assert.equal(decl(body, 'overflow'), 'hidden');
});
