// The parity check warns about an English value only from 20 characters on, and the short-label check covers
// catalogues in another script. A catalogue in Latin script can hold a short label nobody translated as well:
// many coincide on purpose (Status, Admin, Plugins, Info), so this names the labels that every other catalogue
// translates and that the catalogue holding English translates itself in its other strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const read = (lang: string) => flatten(JSON.parse(readFileSync(`${dir}${lang}.json`, 'utf8')));

// Each key with the catalogue's own wording for the same thing elsewhere, which is why English there is a miss.
const TRANSLATED_ELSEWHERE: Record<string, Record<string, string>> = {
  id: {
    'apiKeys.roles.viewer': 'apiKeys.roleDescriptions.viewer', // "Akses hanya-baca"
    'infrastructure.storage.accessKey': 'login.apiKey', // "Kunci API"
    'infrastructure.storage.secretKey': 'login.apiKey',
  },
  it: {
    'infrastructure.storage.accessKey': 'login.apiKey', // "Chiave API"
    'infrastructure.storage.secretKey': 'login.apiKey',
  },
};

test('a Latin-script catalogue holds no English short label it translates in its other strings', () => {
  const en = read('en');
  const english: string[] = [];
  for (const [lang, keys] of Object.entries(TRANSLATED_ELSEWHERE)) {
    const catalogue = read(lang);
    for (const [key, sibling] of Object.entries(keys)) {
      assert.notEqual(catalogue.get(sibling), en.get(sibling), `${lang} ${sibling} is translated`);
      if (catalogue.get(key) === en.get(key)) english.push(`${lang} ${key} = ${String(en.get(key))}`);
    }
  }
  assert.deepEqual(english, []);
});
