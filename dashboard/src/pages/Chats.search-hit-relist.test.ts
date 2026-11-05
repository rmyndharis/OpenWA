import '../test-helpers/register-hooks.ts';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, SearchHit, Session } from '../services/api';
import { resetSocketDouble } from '../test-helpers/socket-io-double.ts';

const session = (id: string, name: string): Session => ({
  id,
  name,
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const FIRST = session('session-a', 'First');
const SECOND = session('session-b', 'Second');
const THIRD = session('session-c', 'Third');
const FOURTH = session('session-d', 'Fourth');

// The contact every hit names, by its phone id; the first account lists it under a privacy id in the lookup cases.
const PHONE_ID = '15550001111@c.us';
const LID_ID = '1000000000001@lid';
const row = (id: string, name: string): Chat => ({
  id,
  name,
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
});
const hit = (target: Session, n: number): SearchHit => ({
  messageId: `db-${n}`,
  waMessageId: `wa-${n}`,
  sessionId: target.id,
  chatId: PHONE_ID,
  body: `sample ${n}`,
  snippet: `sample result ${n}`,
  timestamp: 1_700_000_000,
  type: 'text',
  direction: 'incoming',
  from: PHONE_ID,
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

let sessionReads = 0;
/** The session lists read after the first one, each answered when the case lets it (or fails it). */
let relists: Array<(fail?: boolean) => void> = [];
let finishPhoneLookup: (() => void) | undefined;
let finishFirstList: (() => void) | undefined;
let hits: SearchHit[] = [];
/** 'stage': the first account lists the contact under a privacy id; 'effect-stage' also holds that account's list. */
let mode = '';

let rtl: typeof import('@testing-library/react');
let Chats: (typeof import('./Chats.tsx'))['Chats'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let client: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/sessions') {
      // The page lists two sessions at load; the lists it reads again for a hit answer when the case lets them.
      if (++sessionReads === 1) return Promise.resolve(json([FIRST, THIRD]));
      return new Promise(resolve =>
        relists.push((fail = false) =>
          resolve(fail ? json({ message: 'held relist failed' }, 503) : json([FIRST, SECOND, THIRD, FOURTH])),
        ),
      );
    }
    if (path.startsWith('/api/search?')) return Promise.resolve(json({ hits, total: hits.length }));
    const chats = /^\/api\/sessions\/(session-[abcd])\/chats\?/.exec(path);
    if (chats) {
      const id = chats[1] === 'session-a' && mode.includes('stage') ? LID_ID : PHONE_ID;
      const rows = [row(id, `${chats[1]} contact`)];
      if (chats[1] === 'session-a' && mode === 'effect-stage') {
        return new Promise(resolve => (finishFirstList = () => resolve(json(rows))));
      }
      return Promise.resolve(json(rows));
    }
    if (/\/contacts\/[^/]+\/phone$/.test(path)) {
      return new Promise(
        resolve => (finishPhoneLookup = () => resolve(json({ contactId: LID_ID, phone: '15550001111' }))),
      );
    }
    if (path.includes('/contacts/profile-pictures')) return Promise.resolve(json({ pictures: {} }));
    if (path.includes('/profile-picture')) return Promise.resolve(json({ url: null }));
    if (path.includes('/messages?')) return Promise.resolve(json({ messages: [], total: 0 }));
    return Promise.resolve(json([]));
  }) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Chats } = await import('./Chats.tsx'));
});

beforeEach(() => {
  sessionReads = 0;
  relists = [];
  finishPhoneLookup = undefined;
  finishFirstList = undefined;
  mode = '';
  hits = [hit(SECOND, 1), hit(FOURTH, 2)];
  window.sessionStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_engine_type', 'whatsapp-web.js');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
});

afterEach(async () => {
  finishPhoneLookup?.();
  finishFirstList?.();
  for (const answer of relists) answer();
  rtl.cleanup();
  resetSocketDouble();
  await client?.cancelQueries();
  client?.clear();
});

async function render(): Promise<HTMLElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const view = rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Chats))),
    ),
  );
  await rtl.waitFor(() => assert.equal(selected(view.container), 'First'));
  if (mode !== 'effect-stage') await rtl.screen.findByText('session-a contact');
  return view.container;
}

const selected = (container: HTMLElement): string | null | undefined =>
  container.querySelector('.session-switcher-btn .session-name')?.textContent;
const title = (container: HTMLElement): string | null | undefined =>
  container.querySelector('.room-header .room-contact-name')?.textContent;

/** Click the n-th result of the message search. */
async function clickHit(container: HTMLElement, n: number): Promise<void> {
  if (!container.querySelector('.global-search-input')) {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Search messages' }));
  }
  const input = container.querySelector('.global-search-input') as HTMLInputElement;
  if (input.value !== 'sample') rtl.fireEvent.change(input, { target: { value: 'sample' } });
  else rtl.fireEvent.focus(input);
  const result = await rtl.waitFor(() => {
    const found = container.querySelectorAll('.global-search-hit')[n];
    assert.ok(found, 'the result is listed');
    return found;
  });
  rtl.fireEvent.click(result);
}

/** Choose a session in the switcher and wait until its own list has committed. */
async function choose(container: HTMLElement, name: string, id: string): Promise<void> {
  rtl.fireEvent.click(container.querySelector('.session-switcher-btn') as HTMLElement);
  rtl.fireEvent.click(
    rtl.within(container.querySelector('[role="listbox"]') as HTMLElement).getByRole('option', {
      name: new RegExp(name),
    }),
  );
  await rtl.screen.findByText(`${id} contact`);
  assert.equal(selected(container), name);
}

const answerRelist = (n: number, fail = false): Promise<void> =>
  rtl.act(async () => {
    relists[n](fail);
  });
const relistsHeld = (count: number) => rtl.waitFor(() => assert.equal(relists.length, count));

// A search hit of a session the page has not listed waits for the session list to be read again. The user can choose
// something else meanwhile, and a choice made after the click is the one that stands when the list comes back.
test('a search hit waiting for the session list yields to the session the user chose meanwhile', async () => {
  const container = await render();
  await clickHit(container, 0);
  await relistsHeld(1);
  await choose(container, 'Third', THIRD.id);

  await answerRelist(0);

  assert.equal(selected(container), 'Third');
  assert.notEqual(title(container), 'session-b contact');
});

test('a held session list stays abandoned after the user left the session and came back', async () => {
  const container = await render();
  await clickHit(container, 0);
  await relistsHeld(1);
  await choose(container, 'Third', THIRD.id);
  await choose(container, 'First', FIRST.id);

  await answerRelist(0);

  assert.equal(selected(container), 'First');
});

test('a held session list stays abandoned after the user opened a chat and closed it again', async () => {
  const container = await render();
  await clickHit(container, 0);
  await relistsHeld(1);
  rtl.fireEvent.click(rtl.screen.getByText('session-a contact'));
  await rtl.waitFor(() => assert.ok(container.querySelector('.room-header')));
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Back' }));
  await rtl.waitFor(() => assert.equal(Boolean(container.querySelector('.room-header')), false));

  await answerRelist(0);

  assert.equal(selected(container), 'First');
});

for (const olderFirst of [true, false]) {
  test(`two hits waiting for the session list keep the newer one (the older list answers first: ${olderFirst})`, async () => {
    const container = await render();
    await clickHit(container, 0);
    await relistsHeld(1);
    await clickHit(container, 1);
    await relistsHeld(2);

    await answerRelist(olderFirst ? 0 : 1);
    await answerRelist(olderFirst ? 1 : 0);

    assert.equal(selected(container), 'Fourth');
    assert.equal(title(container), 'session-d contact');
  });
}

// An older hit of a chat the list keeps under a privacy id looks the phone up before it opens the chat. A newer hit that
// is still waiting for the session list replaces it, and the older lookup must not open a room that the newer one then
// reads as the user's own choice.
for (const stage of ['callback-stage', 'effect-stage']) {
  test(`a newer hit waiting for the session list supersedes an older phone lookup (${stage})`, async () => {
    mode = stage;
    hits = [hit(FIRST, 1), hit(SECOND, 2)];
    const container = await render();
    await clickHit(container, 0);
    if (stage === 'effect-stage') {
      await rtl.waitFor(() => assert.ok(finishFirstList));
      await rtl.act(async () => finishFirstList?.());
    }
    await rtl.waitFor(() => assert.ok(finishPhoneLookup, 'the phone lookup is under way'));
    await clickHit(container, 1);
    await relistsHeld(1);

    await rtl.act(async () => finishPhoneLookup?.());
    await answerRelist(0);

    assert.equal(selected(container), 'Second');
    assert.equal(title(container), 'session-b contact');
  });
}

// The same holds for a hit that already has its session and waits for the phone lookup of its chat: a room the user opened
// and closed again while it waited is a choice that ended the hit, although the open chat is back to what it was.
for (const stage of ['callback-stage', 'effect-stage']) {
  test(`a room opened and closed again ends a search hit waiting for its phone lookup (${stage})`, async () => {
    mode = stage;
    hits = [hit(FIRST, 1)];
    const container = await render();
    await clickHit(container, 0);
    if (stage === 'effect-stage') {
      await rtl.waitFor(() => assert.ok(finishFirstList));
      await rtl.act(async () => finishFirstList?.());
    }
    await rtl.waitFor(() => assert.ok(finishPhoneLookup, 'the phone lookup is under way'));
    rtl.fireEvent.click(rtl.screen.getByText('session-a contact'));
    await rtl.waitFor(() => assert.ok(container.querySelector('.room-header')));
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Back' }));
    await rtl.waitFor(() => assert.equal(Boolean(container.querySelector('.room-header')), false));

    await rtl.act(async () => finishPhoneLookup?.());

    assert.equal(Boolean(container.querySelector('.room-header')), false);
  });
}

test('a held session list that fails after the user chose another session shows no error', async () => {
  const container = await render();
  await clickHit(container, 0);
  await relistsHeld(1);
  await choose(container, 'Third', THIRD.id);

  await answerRelist(0, true);

  assert.equal(selected(container), 'Third');
  assert.equal(Boolean(rtl.screen.queryByText('held relist failed')), false);
});
