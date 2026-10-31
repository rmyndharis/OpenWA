import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The Status toggle in the webhook modal hides its checkbox (opacity 0, no size), so the checkbox's own
// focus ring never shows; the visible slider has to carry keyboard focus instead.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Webhooks.css'), 'utf8');

test('the hidden toggle checkbox shows keyboard focus on its slider', () => {
  const rule = /\.webhooks-page \.toggle-switch input:focus-visible \+ \.toggle-slider\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'no focus-visible style for the toggle slider');
  assert.match(rule[1], /outline:\s*2px solid var\(--focus-ring\)/);
});
