// A sender, recipient or chat filter value typed as a number becomes `<digits>@c.us`. More than 15 digits (E.164) is
// no phone number, such as two numbers typed with a space between them, so it is not added as one.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import type { WebhookFilters } from '../services/api.ts';

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

function Harness() {
  const [filters, setFilters] = useState<WebhookFilters | null>({
    conditions: [{ field: 'sender', operator: 'is', value: [] }],
  });
  return createElement(FilterBuilder, {
    filters,
    onChange: setFilters,
    chats: [],
  });
}

// Types a value, presses Enter and returns the chips the row then holds (each titled with its JID).
function chipsAfterTyping(value: string): string[] {
  const { container } = rtl.render(createElement(Harness));
  const input = container.querySelector<HTMLInputElement>('.chips-text')!;
  rtl.fireEvent.change(input, { target: { value } });
  rtl.fireEvent.keyDown(input, { key: 'Enter' });
  return Array.from(container.querySelectorAll('.chip')).map(chip => chip.getAttribute('title') ?? '');
}

test('two numbers typed with a space between them are not added as one sender', () => {
  assert.deepEqual(chipsAfterTyping('6281234567890 6289876543210'), []);
});

test('a fifteen-digit number is still added', () => {
  assert.deepEqual(chipsAfterTyping('123456789012345'), ['123456789012345@c.us']);
});
