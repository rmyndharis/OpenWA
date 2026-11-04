// The contact field of a sender, recipient or chat filter offers matching chats below it. A keyboard user reaches them
// with Tab from the field, so the list stays open while focus is inside the widget, closes once focus leaves it, and
// a pick keeps focus in the field, since the picked suggestion leaves the list under the keyboard.
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

function Harness({ chosen = [] }: { chosen?: string[] }) {
  const [filters, setFilters] = useState<WebhookFilters | null>({
    conditions: [{ field: 'sender', operator: 'is', value: chosen }],
  });
  return createElement(
    'div',
    null,
    createElement(FilterBuilder, {
      filters,
      onChange: setFilters,
      chats: [{ id: '6281111111111@c.us', name: 'Alice' } as never],
    }),
    createElement('button', { type: 'button' }, 'Elsewhere'),
  );
}

// Timers and focus moves change React state, so both run inside act.
const wait = (ms: number) => rtl.act(() => new Promise<void>(resolve => setTimeout(resolve, ms)));
const focus = (element: HTMLElement) => rtl.act(() => element.focus());

function openSuggestions(): { input: HTMLInputElement; suggestion: HTMLElement } {
  const { container } = rtl.render(createElement(Harness));
  const input = container.querySelector<HTMLInputElement>('.chips-text')!;
  focus(input);
  rtl.fireEvent.change(input, { target: { value: 'Ali' } });
  return { input, suggestion: rtl.screen.getByRole('button', { name: /Alice/ }) };
}

const suggestionShown = () => rtl.screen.queryByRole('button', { name: /Alice/ }) !== null;

test('moving focus from the contact field into its suggestions keeps the suggestions open', async () => {
  const { suggestion } = openSuggestions();
  // What Tab does in a browser: focus moves to the next focusable element, the first suggestion.
  focus(suggestion);
  await wait(200);
  assert.ok(suggestionShown(), 'the suggestion a keyboard user tabbed to was removed from the page');
});

test('moving focus out of the widget still closes the suggestions', async () => {
  openSuggestions();
  focus(rtl.screen.getByRole('button', { name: 'Elsewhere' }));
  await wait(200);
  assert.equal(suggestionShown(), false, 'the suggestions stayed open after focus left the widget');
});

test('focus that returns to the field before the list closes keeps it open', async () => {
  const { input } = openSuggestions();
  focus(rtl.screen.getByRole('button', { name: 'Elsewhere' }));
  await wait(20);
  focus(input);
  await wait(200);
  assert.ok(suggestionShown(), 'a close scheduled before focus came back still ran');
});

test('picking a suggestion from the keyboard adds it and leaves focus in the field', async () => {
  const { suggestion } = openSuggestions();
  focus(suggestion);
  // Enter or Space on a focused button fires its click.
  rtl.fireEvent.click(suggestion);
  assert.ok(rtl.screen.getByRole('button', { name: 'Remove Alice' }), 'the picked contact was not added');
  assert.equal((document.activeElement as HTMLElement | null)?.className, 'chips-text', 'focus left the field');
});

// The X of a chosen contact holds focus when pressed (Chrome and Edge focus a clicked button, a keyboard user reaches it
// with Shift+Tab), and the removal takes it off the page. Focus would fall to the page with no blur reaching the widget,
// leaving the list open over the form; it goes back to the field instead.
test('removing a chosen contact with its focused X keeps focus in the field, and leaving closes the suggestions', async () => {
  const { container } = rtl.render(createElement(Harness, { chosen: ['6281111111111@c.us'] }));
  const input = container.querySelector<HTMLInputElement>('.chips-text')!;
  focus(input);
  const remove = rtl.screen.getByRole('button', { name: 'Remove Alice' });
  focus(remove);
  rtl.fireEvent.click(remove);
  assert.equal(
    rtl.screen.queryByRole('button', { name: 'Remove Alice' }) === null,
    true,
    'the contact was not removed',
  );
  assert.equal((document.activeElement as HTMLElement | null)?.className, 'chips-text', 'focus fell to the page');
  assert.ok(suggestionShown(), 'the field holding focus offers no suggestions');

  focus(rtl.screen.getByRole('button', { name: 'Elsewhere' }));
  await wait(200);
  assert.equal(suggestionShown(), false, 'the suggestions stayed open over the form after focus left the field');
});

test('an X clicked without taking focus removes the contact and leaves focus where it was', async () => {
  rtl.render(createElement(Harness, { chosen: ['6281111111111@c.us'] }));
  focus(rtl.screen.getByRole('button', { name: 'Elsewhere' }));
  // Safari focuses no button on a click, so focus stays outside the widget.
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Remove Alice' }));
  assert.equal(
    rtl.screen.queryByRole('button', { name: 'Remove Alice' }) === null,
    true,
    'the contact was not removed',
  );
  assert.equal(document.activeElement?.textContent, 'Elsewhere', 'the removal moved focus into the field');
  assert.equal(suggestionShown(), false, 'the removal opened the suggestions');
});
