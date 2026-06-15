#!/usr/bin/env node
/**
 * i18n locale parity check.
 *
 * Loads the reference locale (en.json) and every other locale in
 * src/i18n/locales, then asserts that every nested key path present in
 * en.json also exists in each locale. Prints the missing key paths per
 * locale and exits non-zero if any are missing.
 *
 * Wire into CI with: `npm run i18n:check`
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'src', 'i18n', 'locales');
const REFERENCE = 'en.json';

/** Flatten a nested object into a Set of dot-separated key paths (leaf keys only). */
function flatten(obj, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, path, out);
    } else {
      out.add(path);
    }
  }
  return out;
}

function load(file) {
  return JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
}

const reference = flatten(load(REFERENCE));
const localeFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && f !== REFERENCE)
  .sort();

let hasErrors = false;

for (const file of localeFiles) {
  const keys = flatten(load(file));
  const missing = [...reference].filter((k) => !keys.has(k)).sort();
  const extra = [...keys].filter((k) => !reference.has(k)).sort();

  if (missing.length > 0) {
    hasErrors = true;
    console.error(`\n[FAIL] ${file}: missing ${missing.length} key(s) present in ${REFERENCE}:`);
    for (const k of missing) console.error(`  - ${k}`);
  } else {
    console.log(`[OK]   ${file}: all ${reference.size} keys present`);
  }

  if (extra.length > 0) {
    // Extra keys are a warning, not a hard failure: they do not break i18n parity
    // against the reference, but they signal drift worth cleaning up.
    console.warn(`[WARN] ${file}: ${extra.length} extra key(s) not in ${REFERENCE}:`);
    for (const k of extra) console.warn(`  ~ ${k}`);
  }
}

if (hasErrors) {
  console.error('\ni18n parity check FAILED.');
  process.exit(1);
}

console.log('\ni18n parity check passed.');
