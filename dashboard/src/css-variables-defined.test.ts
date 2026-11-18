import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A custom property that a style reads with no fallback must be defined somewhere. When it is not, the whole
// declaration is invalid at computed-value time: `background: var(--nothing)` does not fall back to the rule below it
// in the cascade, it computes to the initial value (transparent), so the element loses the fill it was given.

const SRC = dirname(fileURLToPath(import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-helpers' ? [] : filesUnder(full);
    const source = /\.(css|tsx?)$/.test(entry.name) && !entry.name.endsWith('.test.ts');
    return source ? [full] : [];
  });
}

test('every custom property read without a fallback is defined by a stylesheet, a style object or setProperty', () => {
  const files = filesUnder(SRC);
  assert.ok(files.length > 100, 'the dashboard sources moved');
  const defined = new Set<string>();
  const reads: Array<{ name: string; at: string }> = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const at = (index: number) => `${file.slice(SRC.length + 1)}:${text.slice(0, index).split('\n').length}`;
    // A declaration in a stylesheet, a quoted key in a style object, or the first argument of setProperty.
    for (const m of text.matchAll(/(?:^|[;{\s'"])(--[A-Za-z0-9_-]+)['"]?\s*:/g)) defined.add(m[1]);
    for (const m of text.matchAll(/setProperty\(\s*['"](--[A-Za-z0-9_-]+)['"]/g)) defined.add(m[1]);
    // `var(--name)` with no comma before the closing parenthesis; a name built from a template (`--x-${n}`) is skipped.
    for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
      if (
        text.slice(m.index + m[0].indexOf('--') + m[1].length, m.index + m[0].indexOf('--') + m[1].length + 2) === '${'
      )
        continue;
      reads.push({ name: m[1], at: at(m.index) });
    }
  }
  // The collector finds a stylesheet definition and a setProperty one, so an empty result below means something.
  assert.ok(defined.has('--bg-white') && defined.has('--toast-stack-height'), 'the definitions were not collected');
  assert.ok(reads.length > 50, 'the reads were not collected');
  const undefinedReads = reads.filter(read => !defined.has(read.name));
  assert.deepEqual(
    undefinedReads,
    [],
    `custom properties read without a fallback and defined nowhere: ${undefinedReads.map(r => `${r.name} at ${r.at}`).join(', ')}`,
  );
});
