// A contact chosen for a sender, recipient or chat filter shows as a chip with a remove button. The button must say
// which chip it removes; an icon alone is announced as a nameless button.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

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

test('every button in a filter row with a chosen contact has an accessible name', () => {
  const { container } = rtl.render(
    createElement(FilterBuilder, {
      filters: {
        conditions: [{ field: 'sender', operator: 'is', value: ['6281234567890@c.us', '6289999999999@c.us'] }],
      },
      onChange: () => {},
      chats: [{ id: '6289999999999@c.us', name: 'Alice' } as never],
    }),
  );
  const unnamed = rtl
    .within(container)
    .queryAllByRole('button', { name: (name: string) => name.trim() === '' })
    .map(button => button.className);
  assert.deepEqual(unnamed, [], `buttons a screen reader announces with no name: ${unnamed.join(', ')}`);
  // Each remove button names its own chip, by the contact's name where the chat list has one.
  assert.ok(rtl.screen.getByRole('button', { name: 'Remove 6281234567890@c.us' }));
  assert.ok(rtl.screen.getByRole('button', { name: 'Remove Alice' }));
});
