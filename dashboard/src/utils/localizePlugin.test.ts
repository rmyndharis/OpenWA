import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizePlugin } from './localizePlugin.ts';

const base = {
  id: 'p',
  name: 'Chat Flow',
  description: 'English desc',
  configSchema: {
    type: 'object' as const,
    properties: {
      greeting: { type: 'textarea' as const, title: 'Greeting', description: 'EN g', secret: false },
      trigger: { type: 'string' as const, title: 'Trigger' },
    },
  },
  i18n: {
    es: { name: 'Flujo de Chat', config: { greeting: { title: 'Saludo' } } },
  },
};

test('identity when no i18n at all', () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { i18n, ...p } = base;
  const out = localizePlugin(p as typeof base, 'es');
  assert.equal(out, p); // same reference — no override
});

test('identity when the locale is not present', () => {
  const out = localizePlugin(base, 'fr');
  assert.equal(out, base);
});

test('exact match localizes name + overridden field titles, English elsewhere', () => {
  const out = localizePlugin(base, 'es');
  assert.equal(out.name, 'Flujo de Chat');
  assert.equal(out.description, 'English desc'); // not overridden → English
  assert.equal(out.configSchema!.properties.greeting.title, 'Saludo');
  assert.equal(out.configSchema!.properties.greeting.description, 'EN g'); // not overridden → English
  assert.equal(out.configSchema!.properties.trigger.title, 'Trigger'); // no es override → English
});

test('non-text field props are preserved (type, secret)', () => {
  const out = localizePlugin(base, 'es');
  assert.equal(out.configSchema!.properties.greeting.type, 'textarea');
  assert.equal(out.configSchema!.properties.greeting.secret, false);
});

test('a stray i18n.config key not in the schema is ignored (no throw)', () => {
  const p = { ...base, i18n: { es: { config: { nonexistent: { title: 'x' } } } } };
  const out = localizePlugin(p, 'es');
  assert.deepEqual(Object.keys(out.configSchema!.properties), ['greeting', 'trigger']);
});

test('malformed i18n does not throw', () => {
  const p = { ...base, i18n: 'oops' as unknown as typeof base.i18n };
  assert.doesNotThrow(() => localizePlugin(p, 'es'));
});
