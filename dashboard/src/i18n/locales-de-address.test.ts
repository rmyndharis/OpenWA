// The German catalogue addresses the reader as du ("Gib eine Nummer ein", "prüfe dein Haupttelefon"). A string that
// switches to the formal Sie reads as if another product wrote it. The formal pronouns also spell the third-person
// plural and the possessive "ihr", so the strings using them that way are named here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('./locales/de.json', import.meta.url));

function flatten(node: Record<string, unknown>, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value))
      flatten(value as Record<string, unknown>, path, out);
    else out.set(path, value);
  }
  return out;
}

// "Sie gelten ab dem nächsten Sitzungsstart" (the settings), "Sie wurden als Platzhalter gespeichert" (the
// attachments), "Ihre Ingress-URL" (the instance's).
const THIRD_PERSON = new Set([
  'sessions.proxy.saveSuccess',
  'infrastructure.migration.exportPartial',
  'plugins.instances.delete.confirm',
]);

test('the German catalogue addresses the reader as du', () => {
  const catalogue = flatten(JSON.parse(readFileSync(file, 'utf8')));
  const formal: string[] = [];
  for (const [key, value] of catalogue) {
    if (typeof value !== 'string' || THIRD_PERSON.has(key)) continue;
    if (/\b(?:Sie|Ihnen|Ihre?[mnrs]?)\b/.test(value)) formal.push(`${key} = ${value}`);
  }
  assert.deepEqual(formal, []);
  // A named string that stops using the pronoun comes off the list.
  for (const key of THIRD_PERSON) assert.match(String(catalogue.get(key)), /\b(?:Sie|Ihre?)\b/, key);
});
