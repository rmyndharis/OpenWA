import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// A plain 1fr track never shrinks below the widest content in it. The actions are a nowrap row of buttons, and in
// German on a phone the two buttons of the Plugins header widened the single track to 348px: the Install button ran
// past the right edge of a 320px window (44px of page overflow, 4px at 360px). The track may shrink, and actions that
// do not fit side by side wrap onto a second line.
const rules = readRules(new URL('./PageHeader.css', import.meta.url));
const PHONE = '@media (max-width: 768px)';
const ACTIONS = '.page-header__actions';

test('the phone header track can shrink below its widest content', () => {
  const header = rules.filter(r => r.media === PHONE && r.selectors.includes('.page-header'));
  assert.equal(header.length, 1, 'expected one phone rule for the header');
  assert.equal(decl(header[0].body, 'grid-template-columns'), 'minmax(0, 1fr)');
});

test('header actions wrap when they do not fit on one line', () => {
  const wrap = rules.filter(r => r.media === PHONE && r.selectors.includes(ACTIONS) && decl(r.body, 'flex-wrap'));
  assert.equal(wrap.length, 1, 'expected one phone rule that lets the actions wrap');
  assert.equal(decl(wrap[0].body, 'flex-wrap'), 'wrap');
});

// Below 480px each button fills its line. A width of 100% would stack two buttons that fit side by side, as a wrap
// would put each on a line of its own; a zero flex basis shares the line equally and wraps only when the buttons
// cannot fit at their own content width.
test('the full-width buttons share a line and wrap only when they cannot fit', () => {
  const buttons = rules.filter(
    r => r.media === '@media (max-width: 480px)' && r.selectors.includes(`${ACTIONS} > button`),
  );
  assert.equal(buttons.length, 1, 'no rule for the phone buttons');
  assert.equal(decl(buttons[0].body, 'width'), undefined);
  assert.equal(decl(buttons[0].body, 'flex'), '1 1 0');
});
