// A copy button that fails must say so. Over plain HTTP on a LAN address neither clipboard path works, and a button that
// does nothing reads as broken. Every call of copyToClipboard is matched by a failure message in the same file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

test('every call of copyToClipboard has a failure message beside it', () => {
  const short: string[] = [];
  let calls = 0;
  for (const file of sources(SRC)) {
    if (file.endsWith(path.join('utils', 'clipboard.ts'))) continue;
    const text = fs.readFileSync(file, 'utf8');
    const used = text.match(/copyToClipboard\(/g)?.length ?? 0;
    const said = text.match(/t\('common\.copyFailed'\)/g)?.length ?? 0;
    calls += used;
    if (said < used) short.push(`${path.relative(SRC, file)}: ${used} copy call(s), ${said} failure message(s)`);
  }
  assert.ok(calls >= 7, 'the scan found fewer copy calls than the app has');
  assert.deepEqual(short, []);
});
