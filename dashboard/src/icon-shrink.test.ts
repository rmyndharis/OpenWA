import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from './test-helpers/css-rules.ts';

// An svg that is a flex item shrinks like any other when its row runs short of room. With a larger browser text size
// the sidebar entries lost their icons (Number Checker and Message Tester showed none at a 24px root size), and the
// Dashboard tile icons shrank to 7, 13, 0 and 14px; the Infrastructure card icons and the migrations check mark
// shrank the same way. Icons keep their size.
const rules = readRules(new URL('./index.css', import.meta.url));

test('an svg icon does not shrink as a flex item', () => {
  const icon = rules.filter(r => !r.media && r.selectors.includes('svg'));
  assert.equal(icon.length, 1, 'expected one global svg rule');
  assert.equal(decl(icon[0].body, 'flex-shrink'), '0');
});
