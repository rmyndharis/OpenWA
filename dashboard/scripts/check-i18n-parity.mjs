#!/usr/bin/env node
/**
 * i18n locale parity check.
 *
 * Loads the reference locale (en.json) and every other locale in src/i18n/locales, then asserts:
 *   1. KEY PARITY (hard fail): every nested key path in en.json exists in each locale.
 *   2. PLACEHOLDER PARITY (hard fail): a translated string carries the SAME `{{token}}` interpolation
 *      placeholders as the reference — a localized/renamed token (e.g. `{{nombre}}` instead of
 *      `{{name}}`) silently breaks interpolation, which a key-presence check can't see. A plural form
 *      only the locale has (fr `_many`, ar `_few`) may use no token its base's `_other` lacks.
 *   3. UNTRANSLATED PROSE (warning): a long leaf value byte-identical to en.json is very likely still
 *      English — surfaced as a non-fatal drift signal (short coincidental matches are ignored).
 *   4. PLURAL FORMS (hard fail): for every plural key in en.json (one with an `_other` variant), a
 *      locale carries a form for each category `Intl.PluralRules` gives its language. i18next falls
 *      back to the bare (singular) key for a missing category, so French without `_many` renders
 *      "1000000 abonné". The bare key covers `one`.
 *
 * Wire into CI with: `npm run i18n:check`
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// An optional directory argument points the check at a copy of the catalogues (used by its own test).
const LOCALES_DIR = process.argv[2] ?? join(__dirname, '..', 'src', 'i18n', 'locales');
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

/**
 * Exempt a string from the "likely untranslated" warning if it has no translatable prose.
 * A value made up only of {{placeholder}} tokens plus short separator punctuation (spaces, ·, /, :, etc. — no actual alphabetic prose outside the tokens), or a value matching a URL shape (scheme://...) should not be flagged.
 */
function hasTranslatableProse(str) {
  if (/^[a-zA-Z]+:\/\//.test(str)) return false;
  const noTokens = str.replace(/\{\{.*?\}\}/g, '');
  return /\p{L}{2,}/u.test(noTokens);
}

function load(file) {
  return JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
}

const referenceKeys = flatten(load(REFERENCE));
const referenceEntries = flattenEntries(load(REFERENCE));
const pluralBases = [...referenceKeys].filter((k) => k.endsWith('_other')).map((k) => k.slice(0, -'_other'.length));
const pluralBaseSet = new Set(pluralBases);
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const localeFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && f !== REFERENCE)
  .sort();

let hasErrors = false;

for (const file of localeFiles) {
  const keys = flatten(load(file));
  const entries = flattenEntries(load(file));
  const missing = [...referenceKeys].filter((k) => !keys.has(k)).sort();
  const pluralCategories = new Intl.PluralRules(file.replace(/\.json$/, '')).resolvedOptions().pluralCategories;
  const pluralForms = new Set(pluralBases.flatMap((base) => pluralCategories.map((c) => `${base}_${c}`)));
  const missingPlurals = [...pluralForms]
    .filter((k) => !keys.has(k) && !(k.endsWith('_one') && keys.has(k.slice(0, -'_one'.length))))
    .sort();
  const extra = [...keys].filter((k) => !referenceKeys.has(k) && !pluralForms.has(k)).sort();

  const placeholderMismatches = new Map(); // path -> expected tokens
  const untranslated = [];
  for (const [path, refVal] of referenceEntries) {
    if (typeof refVal !== 'string') continue;
    const val = entries.get(path);
    if (typeof val !== 'string') continue;
    if (!setsEqual(placeholders(refVal), placeholders(val))) placeholderMismatches.set(path, placeholders(refVal));
    if (refVal === val && refVal.length >= UNTRANSLATED_MIN_LEN && hasTranslatableProse(refVal)) untranslated.push(path);
  }
  // A plural form en.json has no counterpart for (fr `_many`, ar `_few`, he `_two`) is held to the
  // tokens of the base's `_other`. A subset, not equality: a form for one exact number may spell the
  // number out ("two filters") and drop `{{count}}`, but a token the reference lacks renders literally.
  for (const [path, val] of entries) {
    if (referenceEntries.has(path) || typeof val !== 'string') continue;
    const base = path.replace(PLURAL_SUFFIX, '');
    if (base === path || !pluralBaseSet.has(base)) continue;
    const expected = placeholders(referenceEntries.get(`${base}_other`));
    if ([...placeholders(val)].some((t) => !expected.has(t))) placeholderMismatches.set(path, expected);
  }

  if (missing.length > 0) {
    hasErrors = true;
    console.error(`\n[FAIL] ${file}: missing ${missing.length} key(s) present in ${REFERENCE}:`);
    for (const k of missing) console.error(`  - ${k}`);
  } else {
    console.log(`[OK]   ${file}: all ${referenceKeys.size} keys present`);
  }

  if (placeholderMismatches.size > 0) {
    hasErrors = true;
    console.error(`[FAIL] ${file}: ${placeholderMismatches.size} key(s) with mismatched {{placeholders}}:`);
    for (const [k, expected] of placeholderMismatches) {
      console.error(`  ! ${k}: expected ${[...expected].join(', ') || '(none)'}`);
    }
  }

  if (missingPlurals.length > 0) {
    hasErrors = true;
    console.error(`[FAIL] ${file}: missing ${missingPlurals.length} plural form(s) its language needs:`);
    for (const k of missingPlurals) console.error(`  - ${k}`);
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
