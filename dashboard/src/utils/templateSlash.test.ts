import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterTemplatesBySlash,
  findTemplateBySlashName,
  isSlashDraft,
  renderTemplateText,
  slashQuery,
  templateNeedsVariables,
} from './templateSlash.ts';

const templates = [
  { id: '1', name: 'hola', body: '¡Hola! ¿En qué te ayudo?' },
  { id: '2', name: '/gracias', body: 'Gracias por escribirnos.' },
  { id: '3', name: 'pedido', body: 'Tu pedido {{orderId}} está en camino.', header: 'Nucleo' },
];

test('slashQuery accepts /name only', () => {
  assert.equal(slashQuery('/hola'), 'hola');
  assert.equal(slashQuery('  /gracias  '), 'gracias');
  assert.equal(slashQuery('/hola mundo'), null);
  assert.equal(slashQuery('hola'), null);
  assert.equal(slashQuery('/'), null);
});

test('isSlashDraft tracks an in-progress slash command', () => {
  assert.equal(isSlashDraft('/'), true);
  assert.equal(isSlashDraft('/ho'), true);
  assert.equal(isSlashDraft('/hola '), false);
  assert.equal(isSlashDraft('hola'), false);
});

test('findTemplateBySlashName ignores a leading slash on the template name', () => {
  assert.equal(findTemplateBySlashName(templates, 'hola')?.id, '1');
  assert.equal(findTemplateBySlashName(templates, 'gracias')?.id, '2');
  assert.equal(findTemplateBySlashName(templates, 'nope'), undefined);
});

test('filterTemplatesBySlash ranks prefix matches first', () => {
  const hits = filterTemplatesBySlash(templates, 'ho');
  assert.equal(hits[0]?.name, 'hola');
});

test('renderTemplateText joins header body footer', () => {
  assert.equal(renderTemplateText(templates[2]), 'Nucleo\n\nTu pedido {{orderId}} está en camino.');
  assert.equal(templateNeedsVariables(templates[0]), false);
  assert.equal(templateNeedsVariables(templates[2]), true);
});
