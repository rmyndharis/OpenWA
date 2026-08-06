import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configUiSafeConfig, sparseSessionOverride, missingRequiredConfig } from './pluginConfigRules.ts';
import type { Plugin } from '../services/api';

const plugin = (over: Partial<Plugin> = {}): Plugin =>
  ({
    id: 'p',
    config: {},
    configSchema: { type: 'object', properties: {} },
    ...over,
  }) as Plugin;

const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties }) as Plugin['configSchema'];

test('the config UI only ever sees SCHEMA-DECLARED keys', () => {
  // A plugin's stored config can hold keys its schema never declared. Sending the raw config would
  // hand those to an iframe the plugin itself controls.
  const p = plugin({
    configSchema: schema({ apiHost: { type: 'string' } }),
    config: { apiHost: 'https://x', leftoverFromOldVersion: 'secret-ish', hostWritten: 42 },
  });

  assert.deepEqual(configUiSafeConfig(p), { apiHost: 'https://x' });
});

test('no schema means nothing is safe to send', () => {
  const p = plugin({ configSchema: undefined, config: { anything: 'value' } });

  assert.deepEqual(configUiSafeConfig(p), {});
});

test('a declared key with no stored value is omitted rather than sent as undefined', () => {
  const p = plugin({ configSchema: schema({ a: { type: 'string' }, b: { type: 'string' } }), config: { a: '1' } });

  assert.deepEqual(configUiSafeConfig(p), { a: '1' });
});

test('a per-session editor sees the resolved slice: override where set, else base', () => {
  const p = plugin({
    configSchema: schema({ a: { type: 'string' }, b: { type: 'string' } }),
    config: { a: 'base-a', b: 'base-b' },
    sessionConfig: { s1: { a: 'override-a' } },
  } as Partial<Plugin>);

  assert.deepEqual(configUiSafeConfig(p, 's1'), { a: 'override-a', b: 'base-b' });
});

test('a sparse override keeps only what actually differs from Global', () => {
  const p = plugin({
    configSchema: schema({ changed: { type: 'string' }, same: { type: 'string' } }),
    config: { changed: 'old', same: 'unchanged' },
  });

  assert.deepEqual(sparseSessionOverride({ changed: 'new', same: 'unchanged' }, p), { changed: 'new' });
});

test('every top-level secret is always included, so the backend can restore or drop it', () => {
  const p = plugin({
    configSchema: schema({ token: { type: 'string', secret: true } }),
    config: { token: 'stored' },
  });

  // Identical to the base, and still sent: an untouched `***` is what the backend resolves.
  assert.deepEqual(sparseSessionOverride({ token: '***' }, p), { token: '***' });
});

test('an untouched optional field with no Global value does not pin a spurious override', () => {
  const p = plugin({ configSchema: schema({ note: { type: 'string' } }), config: {} });

  assert.deepEqual(sparseSessionOverride({ note: '' }, p), {});
});

test('a key the schema does not declare never reaches the override', () => {
  const p = plugin({ configSchema: schema({ a: { type: 'string' } }), config: {} });

  assert.deepEqual(sparseSessionOverride({ a: 'x', undeclared: 'y' }, p), { a: 'x' });
});

test('with no schema the input passes through unchanged', () => {
  const p = plugin({ configSchema: undefined });

  assert.deepEqual(sparseSessionOverride({ anything: 1 }, p), { anything: 1 });
});

test('missing required config lists the keys with no usable value', () => {
  const p = plugin({
    configSchema: schema({
      needed: { type: 'string', required: true },
      alsoNeeded: { type: 'string', required: true },
      blank: { type: 'string', required: true },
      optional: { type: 'string' },
    }),
    config: { needed: 'set', alsoNeeded: null, blank: '' },
  });

  // null and '' count as missing; a set value does not; optional is never reported.
  assert.deepEqual(missingRequiredConfig(p), ['alsoNeeded', 'blank']);
});
