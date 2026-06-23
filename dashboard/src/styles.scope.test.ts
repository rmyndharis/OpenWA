import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guard against the route-CSS cascade-collision class of bug: every page stylesheet must keep all of
// its rules scoped under that page's root class (e.g. `.sessions-page …`). Two pages defining the same
// bare class (`.btn-action`) leak across each other depending on lazy-load/navigation order — the last
// route visited wins the cascade. Scoping every rule under the page root makes leakage impossible.
// This test fails the build if any page CSS rule is left unscoped, so the fix can never silently regress.

const PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'pages');

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Top-level (and @media-nested) selectors, excluding @keyframes/@font-face bodies.
function selectors(css: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    let j = i;
    while (j < n && css[j] !== '{' && css[j] !== '}') j++;
    if (j >= n) break;
    if (css[j] === '}') { i = j + 1; continue; }
    const header = css.slice(i, j).trim();
    let depth = 1, k = j + 1;
    while (k < n && depth) { if (css[k] === '{') depth++; else if (css[k] === '}') depth--; k++; }
    const body = css.slice(j + 1, k - 1);
    if (/^@keyframes|^@font-face|^@page/.test(header)) {
      /* keyframe/font selectors are not class-scoped — skip */
    } else if (/^@media|^@supports|^@container/.test(header)) {
      out.push(...selectors(body)); // recurse: inner rules must still be scoped
    } else if (header) {
      out.push(...header.split(',').map(s => s.trim()).filter(Boolean));
    }
    i = k;
  }
  return out;
}

const files = readdirSync(PAGES_DIR).filter(f => f.endsWith('.css'));

for (const file of files) {
  test(`${file}: every rule is scoped under its page root`, () => {
    const css = stripComments(readFileSync(join(PAGES_DIR, file), 'utf8'));
    const sels = selectors(css);
    assert.ok(sels.length > 0, `${file} produced no selectors (parse error?)`);
    // The page root is the first bare single-class selector (each page CSS opens with `.x-page { … }`).
    const root = sels.find(s => /^\.[a-zA-Z][\w-]*$/.test(s));
    assert.ok(root, `${file}: could not find a root class rule`);
    const unscoped = sels.filter(s => !s.includes(root!));
    assert.deepEqual(
      unscoped,
      [],
      `${file}: ${unscoped.length} selector(s) not scoped under "${root}" — move them under the page root ` +
        `(or into a global stylesheet) to avoid cross-page CSS collisions:\n  ${unscoped.join('\n  ')}`,
    );
  });
}
