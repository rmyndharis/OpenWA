import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceFieldInput, emptyForField } from './pluginConfigForm.ts';
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

test('emptyForField: a number field seeds to undefined, not an empty string', () => {
  assert.equal(emptyForField(num), undefined);
});

test('emptyForField: a string field seeds to an empty string', () => {
  assert.equal(emptyForField(str), '');
});
