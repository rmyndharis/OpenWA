import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isComposingKey } from './composition.ts';

test('a keydown flagged as composing, or carrying the input method key code, belongs to the input method', () => {
  assert.equal(isComposingKey({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isComposingKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isComposingKey({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isComposingKey({ isComposing: false, keyCode: 27 }), false);
});
