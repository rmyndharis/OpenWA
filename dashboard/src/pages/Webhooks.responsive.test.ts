import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// FilterBadge keeps the popover 8px off each screen edge, so on a phone narrower than its 340px cap the popover has
// to be narrower than the screen by 16px, or it ends up touching both edges.
const rules = readRules(new URL('./Webhooks.css', import.meta.url));

test('the filter popover is never wider than the screen less its margins', () => {
  const popover = rules.find(r => !r.media && r.selectors.includes('.webhooks-page .filter-popover'));
  assert.ok(popover, 'no .filter-popover rule');
  assert.equal(decl(popover.body, 'max-width'), 'min(340px, calc(100vw - 16px))');
});
