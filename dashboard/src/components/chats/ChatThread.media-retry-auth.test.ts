// A throttled media download (429 or 503) waits before trying again. If the operator signs out or switches API keys
// during that wait, the scheduled retry must stop before sending another request: it must neither hit the media route
// without credentials nor send the previous operator's media request under the replacement key.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, createRef } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';
import { loadArchivedMedia } from '../../utils/archivedMediaLoad.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let ChatThread: typeof import('./ChatThread.tsx').default;
let RoleProvider: typeof import('../RoleProvider.tsx').RoleProvider;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../RoleProvider.tsx'));
  ({ default: ChatThread } = await import('./ChatThread.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  window.sessionStorage.removeItem('openwa_user_role');
  window.sessionStorage.removeItem('openwa_api_key');
});

const CHAT: Chat = {
  id: '15551234567@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  archived: false,
  pinned: false,
  muted: false,
};

const OMITTED_DOCUMENT: ChatMessageView = {
  id: 'big',
  waMessageId: 'wamid.big',
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: '',
  type: 'document',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  metadata: { media: { mimetype: 'application/pdf', filename: 'report.pdf', omitted: true, sizeBytes: 10 } },
};

const poolFull = (): Response =>
  new Response(JSON.stringify({ statusCode: 503, message: 'Too many media downloads are in progress' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
  });

function renderDocumentThread(): { container: HTMLElement } {
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  const noop = () => {};
  const containerRef = createRef<HTMLDivElement>();
  return rtl.render(
    createElement(
      RoleProvider,
      null,
      createElement(ChatThread, {
        sessionId: 's1',
        activeChat: CHAT,
        messages: [OMITTED_DOCUMENT],
        loadingMessages: false,
        messagesError: false,
        messagesContainerRef: containerRef,
        hasMoreMessages: false,
        loadingOlderMessages: false,
        onLoadOlderMessages: noop,
        onMediaLoad: noop,
        measureMedia: noop,
        onOpenImage: noop,
        onReply: noop,
        onReact: noop,
        onDelete: noop,
        onClickButton: async () => {},
      }),
    ),
  );
}

test('a media download waiting to retry after 503 does not send a second request after sign-out or key change', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  const fetchOriginal = globalThis.fetch;
  const sentKeys: Array<string | null> = [];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sentKeys.push(headers.get('X-API-Key'));
    return Promise.resolve(sentKeys.length === 1 ? poolFull() : new Response(new Blob(['x']), { status: 200 }));
  }) as typeof fetch;

  try {
    const { container } = renderDocumentThread();
    const button = container.querySelector('[data-wa-message-id="wamid.big"] button.message-media-omitted');
    assert.ok(button, 'the over-budget document did not render its download button');
    rtl.fireEvent.click(button);

    await rtl.waitFor(() => assert.equal(sentKeys.length, 1));
    assert.equal(sentKeys[0], 'key-a');

    // Replace the API key while the 1-second Retry-After backoff is still waiting.
    window.sessionStorage.setItem('openwa_api_key', 'key-b');
    await new Promise(resolve => setTimeout(resolve, 1_250));

    assert.deepEqual(sentKeys, ['key-a'], `retry fired after key change with headers: ${JSON.stringify(sentKeys)}`);
    assert.equal(
      container.querySelector('[data-wa-message-id="wamid.big"]')?.textContent?.includes('Media unavailable') ?? false,
      false,
      'aborted retry after key change marked the bubble as unavailable',
    );
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('loadArchivedMedia stops retrying after 429 or 503 when the API key changes during backoff', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  let calls = 0;
  await assert.rejects(
    loadArchivedMedia(
      new AbortController().signal,
      async () => {
        calls += 1;
        window.sessionStorage.setItem('openwa_api_key', 'key-b');
        throw Object.assign(new Error('HTTP 429'), { status: 429 });
      },
      10,
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1, 'loadArchivedMedia invoked load again after key replacement');
});
