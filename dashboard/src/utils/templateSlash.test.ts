import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterTemplatesBySlash,
  firstPlaceholder,
  placeholderTokens,
  isSlashDraft,
  renderTemplateText,
  slashDraftFilter,
} from './templateSlash.ts';

const templates = [
  { id: '1', name: 'hola', body: '¡Hola! ¿En qué te ayudo?' },
  { id: '2', name: '/gracias', body: 'Gracias por escribirnos.' },
  { id: '3', name: 'pedido', body: 'Tu pedido {{orderId}} está en camino.', header: 'Nucleo' },
];

test('isSlashDraft tracks an in-progress slash command', () => {
  assert.equal(isSlashDraft('/'), true);
  assert.equal(isSlashDraft('/ho'), true);
  assert.equal(isSlashDraft('/hola '), false);
  assert.equal(isSlashDraft('hola'), false);
  assert.equal(slashDraftFilter('/ho'), 'ho');
  assert.equal(slashDraftFilter('ho'), '');
});

test('filterTemplatesBySlash ranks prefix matches first and ignores a leading slash on a template name', () => {
  const hits = filterTemplatesBySlash(templates, 'ho');
  assert.equal(hits[0]?.name, 'hola');
  assert.deepEqual(
    filterTemplatesBySlash(templates, 'gra').map(t => t.id),
    ['2'],
  );
  const named = [
    { id: 'a', name: 'stop-promo', body: 'a' },
    { id: 'b', name: 'promo', body: 'b' },
  ];
  assert.deepEqual(
    filterTemplatesBySlash(named, 'promo').map(t => t.id),
    ['b', 'a'],
    'a name that starts with the draft comes before one that only holds it',
  );
});

test('filterTemplatesBySlash stops at the limit it is given', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    name: `t${String(i).padStart(2, '0')}`,
    body: 'x',
  }));
  assert.equal(filterTemplatesBySlash(many, 't').length, 8);
  assert.equal(filterTemplatesBySlash(many, 't', 9).length, 9);
});

test('renderTemplateText joins header body footer', () => {
  assert.equal(renderTemplateText(templates[2]), 'Nucleo\n\nTu pedido {{orderId}} está en camino.');
  assert.equal(renderTemplateText({ id: 'f', name: 'f', body: ' b ', footer: 'f' }), 'b\n\nf');
});

test('the first placeholder is found in each form a send fills, and nowhere else', () => {
  const span = (text: string): string | null => {
    const found = firstPlaceholder(text);
    return found && text.slice(found.start, found.end);
  };
  assert.equal(span('Hi {{customer.name}}, ref {{order-id}} code {otp}'), '{{customer.name}}');
  assert.equal(span('ref {{ order-id }} then {{a}}'), '{{ order-id }}');
  assert.equal(span('code {otp} for {{name}}'), '{otp}');
  assert.equal(span('Nucleo\n\nTu pedido {{orderId}} está en camino.'), '{{orderId}}');
  assert.deepEqual(firstPlaceholder('ab {x}'), { start: 3, end: 6 });
  assert.equal(firstPlaceholder('sin variables'), null);
  assert.equal(firstPlaceholder('a brace { alone } or {{}} is no placeholder'), null);
  // The shared pattern is global: a search that kept its place would miss the second call.
  assert.equal(span('{a}'), '{a}');
  assert.equal(span('{a}'), '{a}');
});

test('placeholderTokens lists every placeholder as the text writes it', () => {
  assert.deepEqual(placeholderTokens('Hi {{customer.name}}, {{ order-id }} and {otp}. {{customer.name}}'), [
    '{{customer.name}}',
    '{{ order-id }}',
    '{otp}',
    '{{customer.name}}',
  ]);
  assert.deepEqual(placeholderTokens('a brace { alone } or {{}}'), []);
});
