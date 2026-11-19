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
