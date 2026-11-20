// The suffix of a chat id (@g.us, @c.us, @lid) is typed left to right, but inside an Arabic or Hebrew sentence the @ is
// a neutral between two directions and takes the direction of the page, so the suffix is drawn g.us@ and a person who
// copies what the hint says types it wrong. A left-to-right mark before the @ ties it to the letters after it, as the
// catalogues already do before a phone number prefix. A string with no Arabic or Hebrew letter (an example input) has
// nothing to tie and is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./locales/', import.meta.url));
const RTL_LANGUAGES = ['ar', 'he'];
const LRM = String.fromCharCode(0x200e);
// Hebrew and Arabic letters are one block of the Basic Multilingual Plane.
const RTL_LETTER = new RegExp(`[${String.fromCharCode(0x590)}-${String.fromCharCode(0x6ff)}]`);
const ID_SUFFIX = /@(?:g\.us|c\.us|lid|s\.whatsapp\.net|newsletter|broadcast)(?![\w.])/g;

function* strings(node: unknown, path = ''): Generator<[string, string]> {
  if (typeof node === 'string') yield [path, node];
  else if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node)) yield* strings(value, path ? `${path}.${key}` : key);
}

for (const lang of RTL_LANGUAGES) {
  test(`${lang}: every id suffix inside a sentence follows a left-to-right mark`, () => {
    const catalogue: unknown = JSON.parse(readFileSync(`${dir}${lang}.json`, 'utf8'));
    let seen = 0;
    const bare: string[] = [];
    for (const [key, value] of strings(catalogue)) {
      if (!RTL_LETTER.test(value)) continue;
      for (const match of value.matchAll(ID_SUFFIX)) {
        seen++;
        if (value[match.index - 1] !== LRM) bare.push(`${key}: ${match[0]}`);
      }
    }

    assert.ok(seen >= 5, `the scan found ${seen} id suffixes in ${lang}, fewer than the ones the dashboard shows`);
    assert.deepEqual(bare, []);
  });
}

test('the scan tells a bare suffix from a marked one', () => {
  const marked = `${LRM}@lid`;
  assert.equal([...`x ${marked}`.matchAll(ID_SUFFIX)].map(m => `x ${marked}`[m.index - 1])[0], LRM);
  assert.notEqual([...'x @lid'.matchAll(ID_SUFFIX)].map(m => 'x @lid'[m.index - 1])[0], LRM);
  assert.equal([...'628123456789@c.us'.matchAll(ID_SUFFIX)].length, 1);
  assert.equal(RTL_LETTER.test('628123456789@c.us'), false);
});
