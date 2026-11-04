import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_FONTS, statusFontStyle, statusFontsFor } from './statusFonts.ts';

test('the offered ids are the protocol enum, so 3 to 5 are never offered', () => {
  assert.deepEqual(
    STATUS_FONTS.map(f => f.id),
    [0, 1, 2, 6, 7, 8, 9, 10],
  );
});

test('whatsapp-web.js is offered only the ids it honors, every other engine the whole enum', () => {
  assert.deepEqual(
    statusFontsFor('whatsapp-web.js').map(f => f.id),
    [0, 1, 2, 6, 7],
  );
  for (const engine of ['baileys', null]) {
    assert.deepEqual(
      statusFontsFor(engine).map(f => f.id),
      [0, 1, 2, 6, 7, 8, 9, 10],
    );
  }
});

test('id 1 is the system text face, not a serif one', () => {
  assert.deepEqual(statusFontStyle(1), { fontFamily: 'system-ui, sans-serif' });
});

test('every other id keeps the face its protocol name suggests', () => {
  assert.deepEqual(statusFontStyle(2), { fontFamily: 'cursive' });
  assert.deepEqual(statusFontStyle(6), { fontWeight: 700 });
  assert.deepEqual(statusFontStyle(7), { fontFamily: 'cursive' });
  assert.deepEqual(statusFontStyle(8), { fontFamily: 'serif' });
  assert.deepEqual(statusFontStyle(9), { fontFamily: 'sans-serif', fontWeight: 800 });
  assert.deepEqual(statusFontStyle(10), { fontFamily: 'monospace', fontWeight: 700 });
});

test('the default face, an absent id and an unknown id are left unstyled; the legacy ids still draw', () => {
  assert.deepEqual(statusFontStyle(0), {});
  assert.deepEqual(statusFontStyle(undefined), {});
  assert.deepEqual(statusFontStyle(11), {});
  assert.deepEqual(statusFontStyle(3), { fontFamily: 'fantasy' });
  assert.deepEqual(statusFontStyle(4), { fontFamily: 'serif' });
  assert.deepEqual(statusFontStyle(5), { fontFamily: 'ui-rounded, system-ui, sans-serif' });
});
