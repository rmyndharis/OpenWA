import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --error is the fill and border red. As a text colour it measures 3.76:1 on white and 3.08:1 on the 12 percent
// error tint of a banner, under the 4.5:1 AA needs; --error-text is the same hue darkened (lightened in the
// dark theme). In the light theme it clears 4.5:1 on white and on the tints over white up to the 15 percent of the
// Failed pill (5.17:1 at 10 percent, 4.84:1 at 15 percent); in the dark theme it clears 4.5:1 on every tint.
// Foreground colours use --error-text.

const SRC = dirname(fileURLToPath(import.meta.url));

function filesUnder(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extensions);
    return extensions.some(ext => entry.name.endsWith(ext)) && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

test('no stylesheet or inline style colours text or an icon with the raw --error token', () => {
  const offenders = filesUnder(SRC, ['.css', '.tsx']).flatMap(full => {
    const source = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ''));
    // The property must be `color` itself: border-color, background and stroke keep the fill red on purpose.
    return source
      .split('\n')
      .map((line, i) => ({ line, at: `${full.slice(SRC.length + 1)}:${i + 1}` }))
      .filter(({ line }) => /(?<![\w-])color:\s*['"]?var\(--error\)/.test(line))
      .map(({ line, at }) => `${at}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, []);
});
