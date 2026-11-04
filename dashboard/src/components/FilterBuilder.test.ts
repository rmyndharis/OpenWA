// The enum filters offer message types and chat kinds as tags. The values sent are the API's keys;
// the tags must read as words.
import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
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

after(() => rtl.cleanup());

test('enum tags name message types and chat kinds in words', () => {
  const { container } = rtl.render(
    createElement(FilterBuilder, {
      filters: {
        conditions: [
          { field: 'type', operator: 'is', value: [] },
          { field: 'kind', operator: 'is', value: [] },
        ],
      },
      onChange: () => {},
      chats: [],
    }),
  );

  const [types, kinds] = Array.from(container.querySelectorAll('.filter-enum')).map(row =>
    Array.from(row.querySelectorAll('.enum-tag')).map(tag => tag.textContent),
  );
  assert.ok(types.includes('Voice message'), `message type tags: ${types.join(', ')}`);
  assert.ok(types.includes('Hidden message'), `message type tags: ${types.join(', ')}`);
  // The unclassified bucket is not "any message" (the reply banner's wording for it).
  assert.ok(types.includes('Unknown type'), `message type tags: ${types.join(', ')}`);
  assert.ok(!types.includes('Message'), `message type tags: ${types.join(', ')}`);
  assert.deepEqual(kinds, ['Individual', 'Group', 'Channel', 'Status', 'Broadcast', 'Unknown']);
});

test('adding a condition stops at the gateway limit of 20', () => {
  const sender = { field: 'sender', operator: 'is' as const, value: ['1@c.us'] };
  const view = (count: number) =>
    rtl.render(
      createElement(FilterBuilder, {
        filters: { conditions: Array.from({ length: count }, () => ({ ...sender })) },
        onChange: () => {},
        chats: [],
      }),
    );
  const add = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('.filter-add')!;
  assert.equal(add(view(19).container).disabled, false);
  assert.equal(add(view(20).container).disabled, true);
});

test('the body text stops at the gateway limit of 1000 characters', () => {
  const { container } = rtl.render(
    createElement(FilterBuilder, {
      filters: { conditions: [{ field: 'body', operator: 'contains', value: '' }] },
      onChange: () => {},
      chats: [],
    }),
  );
  assert.equal(container.querySelector<HTMLInputElement>('.filter-text input[type="text"]')?.maxLength, 1000);
});

test('removing a row does not hand its unsent chip text to the row below', () => {
  let latest: WebhookFilters | null = null;
  function Harness() {
    const [filters, setFilters] = useState<WebhookFilters | null>({
      conditions: [
        { field: 'sender', operator: 'is', value: ['1@c.us'] },
        { field: 'chatId', operator: 'is', value: ['2@c.us'] },
      ],
    });
    latest = filters;
    return createElement(FilterBuilder, { filters, onChange: setFilters, chats: [] });
  }
  const { container } = rtl.render(createElement(Harness));

  const [first] = container.querySelectorAll<HTMLInputElement>('.chips-text');
  rtl.fireEvent.change(first, { target: { value: '62812' } });
  rtl.fireEvent.click(container.querySelector('.filter-remove')!);

  const [left] = container.querySelectorAll<HTMLInputElement>('.chips-text');
  assert.equal(left.value, '');
  rtl.fireEvent.keyDown(left, { key: 'Enter' });
  assert.deepEqual(latest, { conditions: [{ field: 'chatId', operator: 'is', value: ['2@c.us'] }] });

  // Editing a row keeps its key, so the input is not remounted (and keeps focus) on every chip added.
  rtl.fireEvent.change(left, { target: { value: '62813' } });
  rtl.fireEvent.keyDown(left, { key: 'Enter' });
  assert.deepEqual(latest, { conditions: [{ field: 'chatId', operator: 'is', value: ['2@c.us', '62813@c.us'] }] });
  assert.equal(container.querySelector('.chips-text'), left);
});

// A contact typed as a number is turned into its chat id from the digits; those may be native-script or full-width.
for (const [script, zero] of [
  ['Arabic-Indic', 0x0660],
  ['full-width', 0xff10],
] as const) {
  test(`a contact typed in ${script} digits is added as an ASCII chat id`, () => {
    const changes: (WebhookFilters | null)[] = [];
    const { container } = rtl.render(
      createElement(FilterBuilder, {
        filters: { conditions: [{ field: 'sender', operator: 'is', value: [] }] },
        onChange: next => changes.push(next),
        chats: [],
      }),
    );
    const input = container.querySelector<HTMLInputElement>('.chips-text');
    assert.ok(input, 'expected the contact input');
    const typed = [...'628123456789'].map(d => String.fromCharCode(zero + Number(d))).join('');
    rtl.fireEvent.change(input, { target: { value: typed } });
    rtl.fireEvent.keyDown(input, { key: 'Enter' });
    assert.deepEqual(changes.at(-1)?.conditions?.[0].value, ['628123456789@c.us']);
  });
}

// The Enter that commits an input method composition (isComposing, or keyCode 229) is the input method's: it adds no
// chip from the text being composed and is not cancelled, so the input method still gets it.
test('the Enter that commits an input method composition adds no contact', () => {
  const changes: (WebhookFilters | null)[] = [];
  const { container } = rtl.render(
    createElement(FilterBuilder, {
      filters: { conditions: [{ field: 'sender', operator: 'is', value: [] }] },
      onChange: next => changes.push(next),
      chats: [],
    }),
  );
  const input = container.querySelector<HTMLInputElement>('.chips-text');
  assert.ok(input, 'expected the contact input');

  rtl.fireEvent.compositionStart(input);
  rtl.fireEvent.change(input, { target: { value: '62812' } });
  assert.equal(
    rtl.fireEvent.keyDown(input, { key: 'Enter', isComposing: true }),
    true,
    'the composing Enter was cancelled',
  );
  assert.equal(rtl.fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 }), true, 'the composing Enter was cancelled');
  rtl.fireEvent.compositionEnd(input);
  assert.equal(changes.length, 0, 'a chip was added from the composing text');

  rtl.fireEvent.change(input, { target: { value: '628123456789' } });
  rtl.fireEvent.keyDown(input, { key: 'Enter' });
  assert.deepEqual(changes.at(-1)?.conditions?.[0].value, ['628123456789@c.us']);
});
