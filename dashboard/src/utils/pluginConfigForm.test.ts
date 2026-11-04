import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceFieldInput, emptyForField, fillClearedFields } from './pluginConfigForm.ts';
import type { PluginConfigField } from '../services/api';

const num: PluginConfigField = { type: 'number' };
const str: PluginConfigField = { type: 'string' };

test('coerceFieldInput: a cleared number field becomes undefined (never an empty string)', () => {
  assert.equal(coerceFieldInput(num, ''), undefined);
});

test('coerceFieldInput: a non-empty number is coerced to a Number', () => {
  assert.equal(coerceFieldInput(num, '42'), 42);
});

test('coerceFieldInput: a string field passes the raw value through unchanged', () => {
  assert.equal(coerceFieldInput(str, ''), '');
  assert.equal(coerceFieldInput(str, 'hi'), 'hi');
});

// The gateway restores a stored secret for the mask and for an empty string, so a cleared secret input
// must not travel as ''. It is omitted here and becomes null in the save, which removes the secret.
test('coerceFieldInput: a cleared secret becomes undefined, a typed one passes through', () => {
  const secret: PluginConfigField = { type: 'string', secret: true };
  assert.equal(coerceFieldInput(secret, ''), undefined);
  assert.equal(coerceFieldInput(secret, 'sk-live'), 'sk-live');
});

test('fillClearedFields: a cleared stored secret saves null, an unset one stays omitted', () => {
  const properties: Record<string, PluginConfigField> = {
    apiKey: { type: 'string', secret: true },
    webhookKey: { type: 'string', secret: true },
  };
  const values = { apiKey: undefined, webhookKey: undefined };
  const stored = { apiKey: '***' }; // the redacted read: the mask means a secret is stored

  assert.deepEqual(fillClearedFields(values, stored, properties), { apiKey: null, webhookKey: undefined });
});

test('emptyForField: a number field seeds to undefined, not an empty string', () => {
  assert.equal(emptyForField(num), undefined);
});

test('emptyForField: a string field seeds to an empty string', () => {
  assert.equal(emptyForField(str), '');
});

// The save merges over the stored config and JSON drops an undefined key, so simply omitting a
// cleared field would keep its old value.
test('fillClearedFields: a cleared field saves its default, or null when it had a value and has none', () => {
  const properties: Record<string, PluginConfigField> = {
    cooldownSec: { type: 'number', default: 60 },
    timeoutMs: { type: 'number' },
    retries: { type: 'number' },
    name: str,
  };
  const values = { cooldownSec: undefined, timeoutMs: undefined, retries: undefined, name: 'bot' };
  const stored = { cooldownSec: 30, timeoutMs: 5000, name: 'bot' };

  assert.deepEqual(fillClearedFields(values, stored, properties), {
    cooldownSec: 60,
    timeoutMs: null,
    retries: undefined, // never stored: nothing to clear, so nothing is written
    name: 'bot',
  });
});
