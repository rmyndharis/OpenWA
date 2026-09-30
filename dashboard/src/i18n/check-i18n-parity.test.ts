import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Runs the real parity script against a copy of the catalogues with values broken, so the check is
// proven to catch the mistake rather than only to pass on the shipped files.
const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(HERE, 'locales');
const SCRIPT = join(HERE, '..', '..', 'scripts', 'check-i18n-parity.mjs');

/** Apply each file's edit to a copy of the catalogues, then run the script against the copy. */
function runWith<T = { chats: { channels: Record<string, string> } }>(edits: Record<string, (catalogue: T) => void>) {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-parity-'));
  try {
    cpSync(LOCALES_DIR, dir, { recursive: true });
    for (const [file, edit] of Object.entries(edits)) {
      const catalogue = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      edit(catalogue);
      writeFileSync(join(dir, file), JSON.stringify(catalogue, null, 2));
    }
    return spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the shipped catalogues pass the parity check', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  // A key no plural rule can select is dead weight, and its warning on every run buries real ones.
  assert.doesNotMatch(result.stderr, /extra key/);
});

test('a renamed token in a plural form en.json does not have fails the check', () => {
  const result = runWith({
    'fr.json': c => {
      c.chats.channels.subscribers_many = '{{cnt}} abonnés';
    },
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /chats\.channels\.subscribers_many: expected count/);
});

test('placeholder-only and whole-URL values are not reported as untranslated', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /\? login\.version$/m);
  assert.doesNotMatch(result.stderr, /\? sessions\.proxy\.urlPlaceholder$/m);
});

test('an English sentence left in a locale is still reported, even when it contains a URL', () => {
  const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
  const result = runWith<{ messageTester: Record<string, string> }>({
    'de.json': c => {
      c.messageTester.bulkMediaUrlInvalid = en.messageTester.bulkMediaUrlInvalid;
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\? messageTester\.bulkMediaUrlInvalid$/m);
});

test('a value that starts with a URL and continues in prose is still reported as untranslated', () => {
  // Only the whole value may be a URL: the check compares against en.json, so both files carry it.
  const value = 'https://example.com is not reachable, check the address';
  const edit = (c: { messageTester: Record<string, string> }) => {
    c.messageTester.bulkMediaUrlInvalid = value;
  };
  const result = runWith({ 'en.json': edit, 'de.json': edit });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\? messageTester\.bulkMediaUrlInvalid$/m);
});
