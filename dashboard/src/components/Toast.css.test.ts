import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Toast.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
const body = (selector: string): string => {
  const rule = new RegExp(`(?:^|})\\s*${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(rule, `Toast.css has no ${selector} rule`);
  return rule[1];
};

test('the toast close button resets the global button padding', () => {
  // The global button rule pads 0.6em 1.2em; on a 24px box that leaves the 16px icon no width and it collapses.
  assert.match(body('.toast-close'), /(?:^|;)\s*padding:\s*0\s*;/);
});

// The lightbox portal comes after the toast container in the document, so at the same z-index it covers the
// toast: an error raised while a picture is open (a send that fails behind it) is dimmed under the backdrop
// and gone after its timer. The toast has to stack above the portal.
test('the toast container stacks above the media lightbox', () => {
  const zIndex = Number(/(?:^|;)\s*z-index:\s*(\d+)/.exec(body('.toast-container'))?.[1]);
  const lightbox = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/yet-another-react-lightbox/dist/styles.css'),
    'utf8',
  );
  const portal = Number(/\.yarl__portal\{[^}]*z-index:var\(--yarl__portal_zindex,(\d+)\)/.exec(lightbox)?.[1]);
  assert.ok(zIndex > 0 && portal > 0, `unreadable z-index values: toast ${zIndex}, lightbox ${portal}`);
  assert.ok(zIndex > portal, `toast z-index ${zIndex} does not exceed the lightbox portal's ${portal}`);
});
