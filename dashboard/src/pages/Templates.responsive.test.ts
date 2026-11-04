import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// The workspace is clipped by its own rounded frame, so a column that does not fit lost its right edge. Its minimum
// tracks (280 + 380px, or 260 + 420 + 280px) plus the two border pixels and the 324px that the sidebar and the page
// padding take need 984px of viewport for two columns and 1286px for three.
const rules = readRules(new URL('./Templates.css', import.meta.url));
const WORKSPACE = '.templates-page .templates-workspace';
const widthOf = (media: string): number => Number(/max-width: (\d+)px/.exec(media)?.[1]);

test('the template columns stack before two of them overflow', () => {
  const stacked = rules.filter(r => r.selectors.includes(WORKSPACE) && decl(r.body, 'flex-direction') === 'column');
  assert.equal(stacked.length, 1, 'expected one rule that stacks the workspace');
  assert.ok(widthOf(stacked[0].media) >= 1000, `the workspace stacks at ${stacked[0].media || 'every width'}`);
});

test('the workspace keeps two columns until three of them fit', () => {
  const two = rules.filter(
    r => r.selectors.includes(WORKSPACE) && decl(r.body, 'grid-template-columns')?.startsWith('280px'),
  );
  assert.equal(two.length, 1, 'expected one rule for the two-column workspace');
  assert.ok(widthOf(two[0].media) >= 1286, `two columns apply at ${two[0].media || 'every width'}`);
});

// A native select is as wide as its longest option, and the header column it sits in is sized to that: a session with
// a long name made the column as wide as the name, the title column shrank to nothing and the select covered the
// title (between about 770 and 1100px). A percentage in `width` does not count towards the column, so the bound is
// max-width; the select then cuts a long name inside itself.
const SELECT = '.templates-page .templates-session-select';

test('the session select is capped so a long session name cannot take the header from the title', () => {
  const capped = rules.find(r => !r.media && r.selectors.includes(SELECT));
  assert.ok(capped, 'no base rule for the session select');
  assert.equal(decl(capped.body, 'max-width'), '20rem');
});

test('the cap is lifted where the header is one column and the select has no title beside it', () => {
  // PageHeader.css stacks the title, the subtitle and the actions below 769px.
  const lifted = rules.filter(r => r.selectors.includes(SELECT) && decl(r.body, 'max-width') === 'none');
  assert.deepEqual(
    lifted.map(r => r.media),
    ['@media (max-width: 768px)'],
  );
});
