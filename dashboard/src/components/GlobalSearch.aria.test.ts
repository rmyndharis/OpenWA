import '../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { SearchHit } from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let GlobalSearch: (typeof import('./GlobalSearch.tsx'))['GlobalSearch'];
const realFetch = globalThis.fetch;

const makeHit = (id: string, body: string): SearchHit => ({
  messageId: id,
  waMessageId: `wamid.${id}`,
  sessionId: 'sess-1',
  chatId: 'alice@c.us',
  body,
  snippet: body,
  timestamp: 1_700_000_000,
  type: 'text',
  direction: 'incoming',
  from: 'alice@c.us',
});

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ GlobalSearch } = await import('./GlobalSearch.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

after(() => {
  globalThis.fetch = realFetch;
});

test('GlobalSearch combobox wires ARIA 1.2 listbox attributes and active descendant selection', async () => {
  const hits = [makeHit('m1', 'hello one'), makeHit('m2', 'hello two')];
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ hits, total: 2, tookMs: 1, provider: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;

  const picked: string[] = [];
  rtl.render(
    createElement(GlobalSearch, {
      currentSessionId: 'sess-1',
      onHit: hit => picked.push(hit.messageId),
    }),
  );

  const combobox = rtl.screen.getByRole('combobox');
  assert.equal(combobox.getAttribute('aria-autocomplete'), 'list');
  assert.equal(combobox.getAttribute('aria-expanded'), 'false');

  rtl.fireEvent.change(combobox, { target: { value: 'hello' } });
  const listbox = await rtl.screen.findByRole('listbox');
  const options = await rtl.screen.findAllByRole('option');
  assert.equal(options.length, 2);
  assert.equal(combobox.getAttribute('aria-expanded'), 'true');
  assert.equal(combobox.getAttribute('aria-controls'), listbox.id);
  assert.equal(combobox.getAttribute('aria-activedescendant'), null);

  rtl.fireEvent.keyDown(combobox, { key: 'ArrowDown' });
  assert.equal(combobox.getAttribute('aria-activedescendant'), options[0].id);
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  assert.equal(options[1].getAttribute('aria-selected'), 'false');

  rtl.fireEvent.keyDown(combobox, { key: 'ArrowDown' });
  assert.equal(combobox.getAttribute('aria-activedescendant'), options[1].id);
  assert.equal(options[1].getAttribute('aria-selected'), 'true');

  rtl.fireEvent.keyDown(combobox, { key: 'Enter' });
  assert.deepEqual(picked, ['m2']);
});

test('GlobalSearch clears aria-activedescendant and blocks stale Enter while loading on query or scope change', async () => {
  let releasePending: (() => void) | null = null;
  let callIndex = 0;
  globalThis.fetch = (() => {
    callIndex += 1;
    if (callIndex === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ hits: [makeHit('m1', 'hello one')], total: 1, tookMs: 1, provider: 'test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return new Promise<Response>(resolve => {
      releasePending = () =>
        resolve(
          new Response(
            JSON.stringify({ hits: [makeHit(`m${callIndex}`, 'next hit')], total: 1, tookMs: 1, provider: 'test' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
    });
  }) as typeof fetch;

  const picked: string[] = [];
  rtl.render(
    createElement(GlobalSearch, {
      currentSessionId: 'sess-1',
      onHit: hit => picked.push(hit.messageId),
    }),
  );

  const combobox = rtl.screen.getByRole('combobox');
  rtl.fireEvent.change(combobox, { target: { value: 'hello' } });
  const [firstOption] = await rtl.screen.findAllByRole('option');
  rtl.fireEvent.keyDown(combobox, { key: 'ArrowDown' });
  assert.equal(combobox.getAttribute('aria-activedescendant'), firstOption.id);

  // Typing a new query enters loading state with options unmounted; active descendant and Enter must be gated.
  rtl.fireEvent.change(combobox, { target: { value: 'world' } });
  assert.equal(combobox.getAttribute('aria-activedescendant'), null);
  assert.equal(rtl.screen.queryByRole('option'), null);
  rtl.fireEvent.keyDown(combobox, { key: 'ArrowDown' });
  rtl.fireEvent.keyDown(combobox, { key: 'Enter' });
  assert.deepEqual(picked, []);

  await rtl.waitFor(() => assert.ok(releasePending !== null));
  await rtl.act(async () => {
    releasePending?.();
    releasePending = null;
  });
  const [secondOption] = await rtl.screen.findAllByRole('option');
  rtl.fireEvent.keyDown(combobox, { key: 'ArrowDown' });
  assert.equal(combobox.getAttribute('aria-activedescendant'), secondOption.id);

  // Toggling scope also starts a fresh loading cycle and clears active descendant before results arrive.
  const scopeCheckbox = rtl.screen.getByRole('checkbox');
  rtl.fireEvent.click(scopeCheckbox);
  assert.equal(combobox.getAttribute('aria-activedescendant'), null);
  rtl.fireEvent.keyDown(combobox, { key: 'Enter' });
  assert.deepEqual(picked, []);

  await rtl.waitFor(() => assert.ok(releasePending !== null));
  await rtl.act(async () => {
    releasePending?.();
    releasePending = null;
  });
  await rtl.screen.findAllByRole('option');
  rtl.fireEvent.keyDown(combobox, { key: 'ArrowDown' });
  rtl.fireEvent.keyDown(combobox, { key: 'Enter' });
  assert.deepEqual(picked, ['m3']);
});
