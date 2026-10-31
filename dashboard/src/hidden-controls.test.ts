import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A radio or checkbox that is drawn as something else (a card, a switch) still has to take keyboard
// focus and show where it is. `display: none` removes the input from the tab order and from the
// accessibility tree; hiding it with zero opacity keeps it focusable, but then the visible stand-in
// has to carry the focus ring.

const SRC = dirname(fileURLToPath(import.meta.url));

interface Rule {
  selectors: string[];
  body: string;
}

// Flat style rules; a rule inside an @media block is listed like any other.
function rules(file: string): Rule[] {
  const css = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    selectors: m[1].split(',').map(s => s.trim()),
    body: m[2],
  }));
}

test('the Infrastructure radio inputs stay focusable and the card shows the focus ring', () => {
  const all = rules('pages/Infrastructure.css');
  const inputs = all.filter(r => r.selectors.some(s => /\.radio-option input$/.test(s)));
  assert.ok(inputs.length > 0, 'no rule styles the radio inputs');
  for (const r of inputs) assert.doesNotMatch(r.body, /display:\s*none/, `${r.selectors.join(', ')} removes the radio`);
  const ring = all.find(r => r.selectors.some(s => /\.radio-option:has\(input:focus-visible\)$/.test(s)));
  assert.ok(ring, 'no focus ring for the focused radio card');
  assert.match(ring.body, /outline:\s*2px solid var\(--focus-ring\)/);
});

// The plugin .zip drop zone and the Import data button are labels around a file input. The input is hidden from
// sight, not removed, so Tab reaches it; the label it sits in shows the focus.
test('the file inputs under the plugin drop zone and the Import data button stay focusable and ring their label', () => {
  for (const [file, input, ring] of [
    ['pages/Plugins.css', /\.install-drop input\[type='file'\]$/, /\.install-drop:has\(input:focus-visible\)$/],
    ['pages/Infrastructure.css', /\.hidden-file-input$/, /label:has\(> \.hidden-file-input:focus-visible\)$/],
  ] as const) {
    const all = rules(file);
    const inputs = all.filter(r => r.selectors.some(s => input.test(s)));
    assert.ok(inputs.length > 0, `${file}: no rule styles the file input`);
    for (const r of inputs) assert.doesNotMatch(r.body, /display:\s*none/, `${file}: ${r.selectors.join(', ')}`);
    const shown = all.find(r => r.selectors.some(s => ring.test(s)));
    assert.ok(shown, `${file}: no focus ring for the focused file input`);
    assert.match(shown.body, /outline:\s*2px solid var\(--focus-ring\)/);
  }
});

/** Every stylesheet under src/, as a path relative to src/. */
function cssFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full.slice(SRC.length + 1)] : [];
  });
}

test('every stylesheet that hides a toggle checkbox rings its slider on keyboard focus', () => {
  const hiding = cssFiles().filter(file =>
    rules(file).some(r => r.selectors.some(s => /\.toggle-switch input$/.test(s))),
  );
  // Vacuity floor: Sessions, Webhooks, Infrastructure and Plugins each carry their own copy.
  assert.ok(hiding.length >= 4, `only ${hiding.length} stylesheets hide a toggle checkbox`);
  const missing = hiding.filter(file => {
    const ring = rules(file).find(r =>
      r.selectors.some(s => /\.toggle-switch input:focus-visible \+ \.toggle-slider$/.test(s)),
    );
    return !ring || !/outline:\s*2px solid var\(--focus-ring\)/.test(ring.body);
  });
  assert.deepEqual(missing, []);
});
