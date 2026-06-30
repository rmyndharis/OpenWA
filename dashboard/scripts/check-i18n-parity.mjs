#!/usr/bin/env node
/**
 * i18n locale parity check.
 *
 * Loads the reference locale (en.json) and every other locale in src/i18n/locales, then asserts:
 *   1. KEY PARITY (hard fail): every nested key path in en.json exists in each locale.
 *   2. PLACEHOLDER PARITY (hard fail): a translated string carries the SAME `{{token}}` interpolation
 *      placeholders as the reference — a localized/renamed token (e.g. `{{nombre}}` instead of
 *      `{{name}}`) silently breaks interpolation, which a key-presence check can't see.
 *   3. UNTRANSLATED PROSE (warning): a long leaf value byte-identical to en.json is very likely still
 *      English — surfaced as a non-fatal drift signal (short coincidental matches are ignored).
 *
 * Wire into CI with: `npm run i18n:check`
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'src', 'i18n', 'locales');
const REFERENCE = 'en.json';
// A leaf value identical to the reference is only flagged when at least this long — short UI words
// (e.g. "Media", "OK") legitimately coincide across languages, full sentences almost never do.
const UNTRANSLATED_MIN_LEN = 20;

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

/** Flatten to a Map of leaf path -> leaf value (string leaves matter for the value checks). */
function flattenEntries(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenEntries(value, path, out);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

/** The set of `{{token}}` interpolation placeholders in a string. */
function placeholders(str) {
  const set = new Set();
  for (const m of str.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) set.add(m[1]);
  return set;
}

function setsEqual(a, b) {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function load(file) {
  return JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
}

const referenceKeys = flatten(load(REFERENCE));
const referenceEntries = flattenEntries(load(REFERENCE));
const localeFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && f !== REFERENCE)
  .sort();

let hasErrors = false;

for (const file of localeFiles) {
  const keys = flatten(load(file));
  const entries = flattenEntries(load(file));
  const missing = [...referenceKeys].filter((k) => !keys.has(k)).sort();
  const extra = [...keys].filter((k) => !referenceKeys.has(k)).sort();

  const placeholderMismatches = [];
  const untranslated = [];
  for (const [path, refVal] of referenceEntries) {
    if (typeof refVal !== 'string') continue;
    const val = entries.get(path);
    if (typeof val !== 'string') continue;
    if (!setsEqual(placeholders(refVal), placeholders(val))) placeholderMismatches.push(path);
    if (refVal === val && refVal.length >= UNTRANSLATED_MIN_LEN) untranslated.push(path);
  }

  if (missing.length > 0) {
    hasErrors = true;
    console.error(`\n[FAIL] ${file}: missing ${missing.length} key(s) present in ${REFERENCE}:`);
    for (const k of missing) console.error(`  - ${k}`);
  } else {
    console.log(`[OK]   ${file}: all ${referenceKeys.size} keys present`);
  }

  if (placeholderMismatches.length > 0) {
    hasErrors = true;
    console.error(`[FAIL] ${file}: ${placeholderMismatches.length} key(s) with mismatched {{placeholders}}:`);
    for (const k of placeholderMismatches) {
      console.error(`  ! ${k}: expected ${[...placeholders(referenceEntries.get(k))].join(', ') || '(none)'}`);
    }
  }

  if (extra.length > 0) {
    // Extra keys are a warning, not a hard failure: they do not break i18n parity
    // against the reference, but they signal drift worth cleaning up.
    console.warn(`[WARN] ${file}: ${extra.length} extra key(s) not in ${REFERENCE}:`);
    for (const k of extra) console.warn(`  ~ ${k}`);
  }

  if (untranslated.length > 0) {
    console.warn(`[WARN] ${file}: ${untranslated.length} long value(s) identical to ${REFERENCE} (likely untranslated):`);
    for (const k of untranslated) console.warn(`  ? ${k}`);
  }
}

if (hasErrors) {
  console.error('\ni18n parity check FAILED.');
  process.exit(1);
}

console.log('\ni18n parity check passed.');
