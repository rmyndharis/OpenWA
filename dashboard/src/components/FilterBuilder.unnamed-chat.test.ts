// A contact chosen for a sender, recipient or chat filter is called by what the chat list calls it. Baileys lists a
// privacy-id chat with no name as `name: ''`, which gave its chip, the chip's remove button and its suggestion no
// text at all.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import type { Chat, WebhookFilters } from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let FilterBuilder: (typeof import('./FilterBuilder.tsx'))['FilterBuilder'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ FilterBuilder } = await import('./FilterBuilder.tsx'));
});

afterEach(() => rtl.cleanup());

const isolated = (number: string) => `${String.fromCodePoint(0x2066)}${number}${String.fromCodePoint(0x2069)}`;

const MAPPED = '262813461250072@lid';
const UNMAPPED = '262813461250073@lid';
const NAMED = '6289999999999@c.us';
const chats = [
  { id: MAPPED, name: '', phone: '15550006666' },
  { id: UNMAPPED, name: '' },
  { id: NAMED, name: 'Alice' },
] as Chat[];

function Harness({ chosen = [] }: { chosen?: string[] }) {
  const [filters, setFilters] = useState<WebhookFilters | null>({
    conditions: [{ field: 'sender', operator: 'is', value: chosen }],
  });
  return createElement(FilterBuilder, { filters, onChange: setFilters, chats });
}

const chipOf = (container: HTMLElement, id: string) => {
  const chip = Array.from(container.querySelectorAll<HTMLElement>('.chip')).find(c => c.title === id);
  assert.ok(chip, `no chip for ${id}`);
  return chip;
};

test('a chosen chat with no name is called by its phone, else by its id digits, and a named one by its name', () => {
  const { container } = rtl.render(createElement(Harness, { chosen: [MAPPED, UNMAPPED, NAMED] }));
  const text = (id: string) => chipOf(container, id).textContent;
  assert.equal(text(MAPPED), isolated('+1 555 000 6666'));
  assert.equal(text(UNMAPPED), '262813461250073');
  assert.equal(text(NAMED), 'Alice');
});

test('the remove button of a chosen chat with no name says which chip it removes', () => {
  const { container } = rtl.render(createElement(Harness, { chosen: [MAPPED, UNMAPPED, NAMED] }));
  const unnamed = rtl
    .within(container)
    .queryAllByRole('button', { name: (name: string) => name.trim() === '' })
    .map(button => button.className);
  assert.deepEqual(unnamed, [], `buttons a screen reader announces with no name: ${unnamed.join(', ')}`);
  const mapped = rtl.screen.getByRole('button', { name: `Remove ${isolated('+1 555 000 6666')}` });
  assert.equal(mapped.getAttribute('title'), `Remove ${isolated('+1 555 000 6666')}`);
  assert.ok(rtl.screen.getByRole('button', { name: 'Remove 262813461250073' }));
  assert.ok(rtl.screen.getByRole('button', { name: 'Remove Alice' }));
});

test('a chosen id the chat list does not hold keeps its id as its name', () => {
  const { container } = rtl.render(createElement(Harness, { chosen: ['6281234567890@c.us'] }));
  assert.equal(chipOf(container, '6281234567890@c.us').textContent, '6281234567890@c.us');
  assert.ok(rtl.screen.getByRole('button', { name: 'Remove 6281234567890@c.us' }));
});

test('a suggestion for a chat with no name shows its phone, with its id on the second line', () => {
  const { container } = rtl.render(createElement(Harness));
  rtl.act(() => container.querySelector<HTMLInputElement>('.chips-text')!.focus());
  const rows = Array.from(container.querySelectorAll('.chips-suggestion')).filter(row =>
    row.querySelector('.chips-suggestion-id'),
  );
  assert.deepEqual(
    rows.map(row => [
      row.querySelector('.chips-suggestion-name')?.textContent,
      row.querySelector('.chips-suggestion-id')?.textContent,
    ]),
    [
      [isolated('+1 555 000 6666'), MAPPED],
      ['262813461250073', UNMAPPED],
      ['Alice', NAMED],
    ],
  );
});
