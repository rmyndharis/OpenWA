import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// locales-short-english.test.ts records that Hebrew writes the term Session in Latin script, in its sentences as in its
// labels. A value that spells it in Hebrew script, singular or plural and with or without a prefix letter, puts two
// spellings on one screen: the page is titled Sessions and the dialog it opens says the Hebrew word.

const dir = fileURLToPath(new URL('./locales/', import.meta.url));

function flatten(node: Record<string, unknown>, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value))
      flatten(value as Record<string, unknown>, path, out);
    else out.set(path, value);
  }
  return out;
}

test('the Hebrew catalogue spells the term Session one way: in Latin script', () => {
  const he = flatten(JSON.parse(readFileSync(`${dir}he.json`, 'utf8')));
  const latin = [...he].filter(([, value]) => typeof value === 'string' && /\bSessions?\b/.test(value));
  assert.ok(latin.length > 40, 'the catalogue no longer writes Session in Latin script: drop this check');
  // The singular ends in a final nun and the plural has a medial one before its ending, so one pattern covers both.
  const hebrewWord = [...he]
    .filter(([, value]) => typeof value === 'string' && /סש[ןנ]/.test(value))
    .map(([key]) => key);
  assert.deepEqual(hebrewWord, []);
});

// The noun session can also be written הפעלה, which is otherwise the start, the restart, the enabling or the activation
// of something, so the word alone proves nothing. A value whose English source names a session and that has the word
// still writes the term in Latin script when the word is a start ("הפעלת Session", "בהפעלה הבאה של ה-Session"); with no
// Latin Session in it, the word is the noun, spelled in Hebrew script.
test('a Hebrew value for a session does not spell the noun session as הפעלה', () => {
  const en = flatten(JSON.parse(readFileSync(`${dir}en.json`, 'utf8')));
  const he = flatten(JSON.parse(readFileSync(`${dir}he.json`, 'utf8')));
  const mentionsSession = (key: string): boolean => /\bsessions?\b/i.test(String(en.get(key) ?? ''));
  const withWord = [...he].filter(
    ([key, value]) => typeof value === 'string' && /הפעל[הת]|הפעלות/.test(value) && mentionsSession(key),
  );
  const starts = withWord.filter(([, value]) => /\bSessions?\b/.test(String(value)));
  assert.ok(starts.length >= 4, 'no value starts a Latin Session any more: drop this check');
  assert.deepEqual(
    withWord.filter(([, value]) => !/\bSessions?\b/.test(String(value))).map(([key]) => key),
    [],
  );
});
