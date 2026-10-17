// Render test for the chat thread's write actions. The gateway answers reply, react, delete and a
// prompt-button tap only for an operator key, so a read-only key must not be offered them. It also
// checks the thread, not just the helpers, resolves an @mention in a body and in a quote.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, createRef, type ComponentProps } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
// Set by a test that needs the engine's answer for a focus it did not give by key press, which jsdom cannot.
let focusVisibleOverride: boolean | null = null;
let matchesOriginal: typeof Element.prototype.matches;
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
  // jsdom answers :focus-visible from the last key or pointer event that any test fired before, so the same
  // call matched in one run and not in the next. Here it holds for the element that has focus, as for the
  // focus a key press brings, and not for a focus event on an element that is not the focused one, as for
  // the focus of a click.
  matchesOriginal = window.Element.prototype.matches;
  window.Element.prototype.matches = function (this: Element, selector: string): boolean {
    if (selector !== ':focus-visible') return matchesOriginal.call(this, selector);
    return focusVisibleOverride ?? this === document.activeElement;
  } as typeof Element.prototype.matches;
});

after(() => {
  window.Element.prototype.matches = matchesOriginal;
});

afterEach(() => {
  focusVisibleOverride = null;
  mock.restoreAll();
  rtl.cleanup();
  window.sessionStorage.removeItem('openwa_user_role');
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

const PROMPT: ChatMessageView = {
  id: 'db-1',
  waMessageId: 'wamid.1',
  chatId: CHAT.id,
  from: CHAT.id,
  to: 'me',
  body: 'Confirm?',
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  timestamp: 1_700_000_000,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  metadata: { buttons: [{ id: 'y', text: 'Yes' }] },
};

function renderThread(
  role: string,
  messages: ChatMessageView[] = [PROMPT],
  activeChat: Chat = CHAT,
  props: Partial<ComponentProps<typeof ChatThread>> = {},
): {
  clicks: string[];
  container: HTMLElement;
  rerenderWith: (next: ChatMessageView[]) => void;
  rerenderProps: (next: Partial<ComponentProps<typeof ChatThread>>) => void;
} {
  window.sessionStorage.setItem('openwa_user_role', role);
  const clicks: string[] = [];
  const noop = () => {};
  const containerRef = createRef<HTMLDivElement>();
  let current = props;
  let shown = messages;
  const tree = (list: ChatMessageView[]) =>
    createElement(
      RoleProvider,
      null,
      createElement(ChatThread, {
        sessionId: 's1',
        activeChat,
        messages: list,
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
        onClickButton: async (_message, button) => {
          clicks.push(button.id);
        },
        ...current,
      }),
    );
  const { container, rerender } = rtl.render(tree(messages));
  return {
    clicks,
    container,
    rerenderWith: next => {
      shown = next;
      rerender(tree(shown));
    },
    rerenderProps: next => {
      current = { ...current, ...next };
      rerender(tree(shown));
    },
  };
}

test('a read-only key sees prompt choices disabled and no reply, react or delete actions', () => {
  const { clicks, container } = renderThread('viewer');
  const yes = rtl.screen.getByRole('button', { name: 'Yes' });
  assert.equal(yes.matches(':disabled'), true);
  rtl.fireEvent.click(yes);
  assert.deepEqual(clicks, []);
  assert.ok(!container.querySelector('.message-actions-menu'));
});

test('an operator key can tap a prompt choice and gets the message actions', async () => {
  const { clicks, container } = renderThread('operator');
  const yes = rtl.screen.getByRole('button', { name: 'Yes' });
  assert.equal(yes.matches(':disabled'), false);
  rtl.fireEvent.click(yes);
  await rtl.waitFor(() => assert.deepEqual(clicks, ['y']));
  assert.ok(container.querySelector('.message-actions-menu'));
});

test('an optimistic bubble with no WhatsApp id yet offers no reply, react or delete', () => {
  // Every action addresses the message by its WhatsApp id; a pending or failed placeholder only has
  // its local temp_ id, which the gateway can never resolve.
  for (const status of ['pending', 'failed'] as const) {
    const { container } = renderThread('operator', [
      { ...PROMPT, id: 'temp_1', waMessageId: undefined, direction: 'outgoing', status, metadata: undefined },
    ]);
    assert.ok(!container.querySelector('.message-actions-menu'), `a ${status} placeholder offered actions`);
    rtl.cleanup();
  }
});

test('an @mention of a participant who posted in the thread shows their first name, in the body and the quote', () => {
  const GROUP: Chat = { ...CHAT, id: '120363000000000000@g.us', name: 'Team', isGroup: true, kind: 'group' };
  const fromBob: ChatMessageView = {
    ...PROMPT,
    id: 'db-bob',
    waMessageId: 'wamid.bob',
    chatId: GROUP.id,
    from: GROUP.id,
    author: '15551230000@c.us',
    chatName: 'Bob Smith',
    body: 'hello',
    metadata: undefined,
  };
  const mentioning: ChatMessageView = {
    ...fromBob,
    id: 'db-mention',
    waMessageId: 'wamid.mention',
    author: '15559990000@c.us',
    chatName: 'Ann',
    body: 'thanks @15551230000',
    timestamp: 1_700_000_001,
    metadata: { quotedMessage: { id: 'wamid.bob', body: 'ping @15551230000' } },
  };
  const { container } = renderThread('viewer', [fromBob, mentioning], GROUP);
  const body = [...container.querySelectorAll('.message-text')].find(el => el.textContent?.startsWith('thanks'));
  assert.equal(body?.querySelector('bdi')?.textContent, '@Bob');
  assert.equal(container.querySelector('.quote-body bdi')?.textContent, '@Bob');
});

test('a document sent by URL opens in a new tab instead of navigating the dashboard away', () => {
  // Browsers ignore `download` on a cross-origin link, so a plain click would unload the dashboard.
  const doc = (id: string, data: string): ChatMessageView => ({
    ...PROMPT,
    id,
    waMessageId: `wamid.${id}`,
    body: '',
    type: 'document',
    metadata: { media: { mimetype: 'application/pdf', filename: `${id}.pdf`, data } },
  });
  const { container } = renderThread('operator', [
    doc('remote', 'https://files.example.com/remote.pdf'),
    doc('inline', 'JVBERi0='),
  ]);
  const [remote, inline] = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.chat-document-media'));
  assert.equal(remote.getAttribute('target'), '_blank');
  assert.equal(remote.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(inline.getAttribute('target'), null);
  assert.equal(inline.getAttribute('download'), 'inline.pdf');
});

test('archive-only media previews inline from the media route; a plain omitted marker and a document keep the button', async () => {
  // MESSAGE_INLINE_MEDIA=archive leaves `{ omitted, archived }` on the row: the image rendered inline
  // before, so it must still. The over-budget marker (no `archived`) must not fetch on render, and a
  // document has nothing to preview.
  const media = (id: string, type: ChatMessageView['type'], archived: boolean): ChatMessageView => ({
    ...PROMPT,
    id,
    waMessageId: `wamid.${id}`,
    body: '',
    type,
    metadata: { media: { mimetype: 'image/jpeg', filename: `${id}.jpg`, omitted: true, sizeBytes: 10, archived } },
  });
  const fetched: string[] = [];
  const fetchOriginal = globalThis.fetch;
  const createOriginal = URL.createObjectURL;
  const revokeOriginal = URL.revokeObjectURL;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 });
  }) as typeof fetch;
  URL.createObjectURL = () => 'blob:archived';
  URL.revokeObjectURL = () => {};
  try {
    const { container } = renderThread('viewer', [
      media('arch', 'image', true),
      media('plain', 'image', false),
      media('doc', 'document', true),
    ]);
    const img = await rtl.waitFor(() => {
      const found = container.querySelector('[data-wa-message-id="wamid.arch"] img.chat-image-media');
      assert.ok(found, 'the archived image did not preview');
      return found;
    });
    assert.equal(img.getAttribute('src'), 'blob:archived');
    assert.equal(fetched.length, 1, 'only the archived image is fetched on render');
    assert.match(fetched[0], /\/messages\/.+\/wamid\.arch\/media$/);
    assert.ok(container.querySelector('[data-wa-message-id="wamid.plain"] button.message-media-omitted'));
    assert.ok(container.querySelector('[data-wa-message-id="wamid.doc"] button.message-media-omitted'));
  } finally {
    globalThis.fetch = fetchOriginal;
    URL.createObjectURL = createOriginal;
    URL.revokeObjectURL = revokeOriginal;
  }
});

test('an archived image is observed against the thread scroller and saved under its own name, or one unique to its message', async () => {
  // ArchivedMediaPreview is covered on its own; this pins what the thread hands it. The scroll container
  // as observer root keeps the lazy-load lead from being clipped to the container's own box, the stored
  // file name is what a named photo saves under, and the row id keeps nameless photos apart.
  const image = (id: string, filename?: string): ChatMessageView => ({
    ...PROMPT,
    id,
    waMessageId: `wamid.${id}`,
    body: '',
    type: 'image',
    metadata: { media: { mimetype: 'image/jpeg', filename, omitted: true, sizeBytes: 10, archived: true } },
  });
  const roots: unknown[] = [];
  class IntersectingObserver {
    callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      roots.push(options?.root);
    }
    // Reports the placeholder as inside the margin at once, so the preview fetches.
    observe(target: Element): void {
      const entry = { isIntersecting: true, target } as IntersectionObserverEntry;
      this.callback([entry], this as unknown as IntersectionObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  const downloads: string[] = [];
  // The viewer saves through a detached <a download> it clicks with dispatchEvent.
  const anchorProto = HTMLAnchorElement.prototype as { dispatchEvent?: unknown };
  const observerTarget = globalThis as { IntersectionObserver?: unknown };
  const fetchOriginal = globalThis.fetch;
  const createOriginal = URL.createObjectURL;
  const revokeOriginal = URL.revokeObjectURL;
  observerTarget.IntersectionObserver = IntersectingObserver;
  globalThis.fetch = (async () =>
    new Response(new Blob(['x'], { type: 'image/jpeg' }), { status: 200 })) as typeof fetch;
  URL.createObjectURL = () => 'blob:archived';
  URL.revokeObjectURL = () => {};
  anchorProto.dispatchEvent = function (this: HTMLAnchorElement, event: Event): boolean {
    if (event.type === 'click') downloads.push(this.download);
    return true;
  };
  try {
    for (const message of [image('db-named', 'holiday.jpg'), image('db-nameless')]) {
      const { container } = renderThread('viewer', [message]);
      const img = await rtl.waitFor(() => {
        const found = container.querySelector('img.chat-image-media');
        assert.ok(found, 'the archived image did not preview');
        return found;
      });
      // A boolean, not assert.equal: a failed equality would inspect a whole jsdom tree.
      const scroller = container.querySelector('.room-messages');
      assert.ok(scroller && roots.at(-1) === scroller, 'the observer is not rooted at the thread scroller');
      rtl.fireEvent.click(img);
      rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Download' }));
      await rtl.act(() => new Promise(resolve => setTimeout(resolve, 50)));
      rtl.cleanup();
    }
    assert.deepEqual(downloads, ['holiday.jpg', 'image-db-nameless.jpg']);
  } finally {
    delete observerTarget.IntersectionObserver;
    delete anchorProto.dispatchEvent;
    globalThis.fetch = fetchOriginal;
    URL.createObjectURL = createOriginal;
    URL.revokeObjectURL = revokeOriginal;
  }
});

test('a media download answered after sign-out saves no file', async () => {
  // Logout cancels nothing in flight: a download the operator started just before it would otherwise
  // land in the downloads folder with the login form already showing.
  const message: ChatMessageView = {
    ...PROMPT,
    id: 'big',
    waMessageId: 'wamid.big',
    body: '',
    type: 'document',
    metadata: { media: { mimetype: 'application/pdf', filename: 'report.pdf', omitted: true, sizeBytes: 10 } },
  };
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  const fetchOriginal = globalThis.fetch;
  const createOriginal = URL.createObjectURL;
  const revokeOriginal = URL.revokeObjectURL;
  const createElementOriginal = document.createElement;
  const saved: string[] = [];
  let answer!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(resolve => (answer = resolve))) as typeof fetch;
  URL.createObjectURL = () => 'blob:report';
  URL.revokeObjectURL = () => {};
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = createElementOriginal.call(document, tag, options);
    if (tag === 'a')
      (element as HTMLAnchorElement).click = () => void saved.push((element as HTMLAnchorElement).download);
    return element;
  }) as typeof document.createElement;
  try {
    const { container } = renderThread('viewer', [message]);
    const button = container.querySelector('[data-wa-message-id="wamid.big"] button.message-media-omitted');
    assert.ok(button, 'the over-budget document did not render its download button');
    rtl.fireEvent.click(button);
    await rtl.waitFor(() => assert.ok(answer, 'the download did not start'));
    window.sessionStorage.removeItem('openwa_api_key');
    answer(new Response(new Blob(['x']), { status: 200 }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(saved, [], 'the media file was saved after the sign-out');
  } finally {
    globalThis.fetch = fetchOriginal;
    URL.createObjectURL = createOriginal;
    URL.revokeObjectURL = revokeOriginal;
    document.createElement = createElementOriginal;
    window.sessionStorage.removeItem('openwa_api_key');
  }
});

test('poll messages display exact choices, including outgoing and legacy polls', () => {
  const poll = { name: 'Where?', options: [' Park ', '<script>Beach</script>'], allowMultipleAnswers: false };
  const { container } = renderThread('viewer', [
    { ...PROMPT, type: 'poll', body: 'Where?', metadata: { poll } },
    {
      ...PROMPT,
      id: 'out',
      waMessageId: 'out',
      type: 'poll',
      direction: 'outgoing',
      body: 'Where?',
      metadata: { poll },
    },
    { ...PROMPT, id: 'legacy', waMessageId: 'legacy', type: 'poll', body: 'Legacy question', metadata: undefined },
  ]);
  assert.deepEqual(
    Array.from(container.querySelectorAll('li bdi')).map(node => node.textContent),
    [...poll.options, ...poll.options],
  );
  assert.equal(container.querySelector('script'), null);
  assert.ok(container.textContent?.includes('Legacy question'));
});

test('a poll whose body is empty shows the question from its metadata', () => {
  // whatsapp-web.js hands a poll over with an empty body and its name only in metadata.poll.
  const poll = { name: 'Where shall we meet?', options: ['Park', 'Beach'], allowMultipleAnswers: false };
  const { container } = renderThread('viewer', [{ ...PROMPT, type: 'poll', body: '', metadata: { poll } }]);
  assert.ok(container.textContent?.includes('Where shall we meet?'));
});

test('an archived sticker previews as an image and an archived voice note as audio', async () => {
  const media = (id: string, type: ChatMessageView['type'], mimetype: string): ChatMessageView => ({
    ...PROMPT,
    id,
    waMessageId: `wamid.${id}`,
    body: '',
    type,
    metadata: { media: { mimetype, filename: `${id}.bin`, omitted: true, sizeBytes: 10, archived: true } },
  });
  const fetchOriginal = globalThis.fetch;
  const createOriginal = URL.createObjectURL;
  const revokeOriginal = URL.revokeObjectURL;
  globalThis.fetch = (async () => new Response(new Blob(['x']), { status: 200 })) as typeof fetch;
  URL.createObjectURL = () => 'blob:archived';
  URL.revokeObjectURL = () => {};
  try {
    const { container } = renderThread('viewer', [
      media('stk', 'sticker', 'image/webp'),
      media('vn', 'voice', 'audio/ogg; codecs=opus'),
    ]);
    await rtl.waitFor(() => {
      assert.ok(container.querySelector('[data-wa-message-id="wamid.stk"] img.chat-image-media'));
      assert.ok(container.querySelector('[data-wa-message-id="wamid.vn"] audio'));
    });
  } finally {
    globalThis.fetch = fetchOriginal;
    URL.createObjectURL = createOriginal;
    URL.revokeObjectURL = revokeOriginal;
  }
});

// The message actions appear on hover, so a keyboard user reaches them through the bubble: one tab stop
// for the thread (the focused message, else the newest) and the arrow keys between messages.
test('the thread is one tab stop and the arrow keys move between messages that carry actions', () => {
  const second: ChatMessageView = {
    ...PROMPT,
    id: 'db-2',
    waMessageId: 'wamid.2',
    body: 'Second',
    metadata: undefined,
  };
  const noActions: ChatMessageView = {
    ...PROMPT,
    id: 'db-3',
    waMessageId: undefined,
    body: 'Third',
    direction: 'outgoing',
    status: 'pending',
    metadata: undefined,
  };
  const { container } = renderThread('operator', [PROMPT, second, noActions]);
  const stops = (): Array<string | null> =>
    [...container.querySelectorAll<HTMLElement>('[data-roving-message]')].map(el => el.getAttribute('tabindex'));

  // The bubble without a WhatsApp id offers no action, so it is no stop at all.
  assert.equal(container.querySelectorAll('[data-roving-message]').length, 2);
  // Nothing focused yet: the newest message that carries actions holds the tab stop.
  assert.deepEqual(stops(), ['-1', '0']);

  const bubbles = container.querySelectorAll<HTMLElement>('[data-roving-message]');
  bubbles[1].focus();
  rtl.fireEvent.keyDown(bubbles[1], { key: 'ArrowUp' });
  assert.equal(document.activeElement, bubbles[0]);
  assert.deepEqual(stops(), ['0', '-1']);

  rtl.fireEvent.keyDown(bubbles[0], { key: 'ArrowDown' });
  assert.equal(document.activeElement, bubbles[1]);
  rtl.fireEvent.keyDown(bubbles[1], { key: 'Home' });
  assert.equal(document.activeElement, bubbles[0]);
  rtl.fireEvent.keyDown(bubbles[0], { key: 'End' });
  assert.equal(document.activeElement, bubbles[1]);
});

test('a key pressed inside a message action keeps its own meaning', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const bubbles = container.querySelectorAll<HTMLElement>('[data-roving-message]');
  const reply = bubbles[1].querySelector<HTMLElement>('.action-btn');
  assert.ok(reply);
  reply.focus();
  rtl.fireEvent.keyDown(reply, { key: 'ArrowUp' });
  assert.equal(document.activeElement, reply);
});

const bubblesOf = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-roving-message]'),
];

/**
 * Where focus is, as text: the id of the message whose bubble or control holds it, 'body' when it fell to
 * the page, 'elsewhere' for any other element. A failed assert.equal on two DOM nodes spends minutes
 * printing them, so focus is compared by name.
 */
const focusedMessage = (): string =>
  document.activeElement === document.body
    ? 'body'
    : (document.activeElement?.closest('[data-wa-message-id]')?.getAttribute('data-wa-message-id') ?? 'elsewhere');

// A bubble is the one tab stop of the thread; what is inside it (a link, a preview, a button) is a stop
// of its own, and landing on it must not make its bubble the stop as well, or Shift+Tab visits both.
test('focus on a link inside a message does not move the thread tab stop', () => {
  const linked: ChatMessageView = { ...PROMPT, id: 'db-0', waMessageId: 'wamid.0', body: 'see https://example.org/a' };
  const newest: ChatMessageView = {
    ...PROMPT,
    id: 'db-9',
    waMessageId: 'wamid.9',
    body: 'Newest',
    metadata: undefined,
  };
  const { container } = renderThread('operator', [linked, newest]);
  const stops = (): Array<string | null> => bubblesOf(container).map(el => el.getAttribute('tabindex'));
  assert.deepEqual(stops(), ['-1', '0']);

  const link = container.querySelector<HTMLElement>('[data-wa-message-id="wamid.0"] a[href]');
  assert.ok(link, 'the body links its URL');
  rtl.act(() => link.focus());

  assert.deepEqual(stops(), ['-1', '0']);
});

test('arrow keys, Home and End are consumed and reach the stops from the middle of three', () => {
  const messages = ['a', 'b', 'c'].map((id): ChatMessageView => ({
    ...PROMPT,
    id: `db-${id}`,
    waMessageId: `wamid.${id}`,
    metadata: undefined,
  }));
  const { container } = renderThread('operator', messages);
  const bubbles = bubblesOf(container);
  bubbles[1].focus();

  // fireEvent returns false when the handler called preventDefault.
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'Home' }), false);
  assert.equal(document.activeElement, bubbles[0]);
  bubbles[1].focus();
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'End' }), false);
  assert.equal(document.activeElement, bubbles[2]);
  bubbles[1].focus();
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'ArrowUp' }), false);
  assert.equal(document.activeElement, bubbles[0]);
  bubbles[1].focus();
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'ArrowDown' }), false);
  assert.equal(document.activeElement, bubbles[2]);
  // A key the thread does not use is left alone.
  assert.equal(rtl.fireEvent.keyDown(bubbles[1], { key: 'a' }), true);
});

// On the first message there is nowhere further for Home to go, and on the last none for End: the browser
// scrolls the thread then, as it does for ArrowUp and ArrowDown past the ends, so Home asks for an older page
// as the other keys do. Focus stays where it is.
test('Home on the first message and End on the last are left to the browser, and keep focus', () => {
  const messages = ['a', 'b', 'c'].map((id): ChatMessageView => ({
    ...PROMPT,
    id: `db-${id}`,
    waMessageId: `wamid.${id}`,
    metadata: undefined,
  }));
  const { container } = renderThread('operator', messages);
  const bubbles = bubblesOf(container);

  bubbles[0].focus();
  assert.equal(rtl.fireEvent.keyDown(bubbles[0], { key: 'Home' }), true);
  assert.equal(focusedMessage(), 'wamid.a');
  assert.equal(rtl.fireEvent.keyDown(bubbles[0], { key: 'ArrowUp' }), true);

  bubbles[2].focus();
  assert.equal(rtl.fireEvent.keyDown(bubbles[2], { key: 'End' }), true);
  assert.equal(focusedMessage(), 'wamid.c');
  assert.equal(rtl.fireEvent.keyDown(bubbles[2], { key: 'ArrowDown' }), true);

  // From any other message the key still moves to the end it names.
  assert.equal(rtl.fireEvent.keyDown(bubbles[2], { key: 'Home' }), false);
  assert.equal(focusedMessage(), 'wamid.a');
});

// Deleting removes the buttons that hold focus, so focus would fall to the page and the next Tab would
// land in the composer.
test('keyboard focus stays in the thread when the focused message is deleted', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first, second]);
  const bubbles = bubblesOf(container);
  const del = bubbles[1].querySelector<HTMLElement>('[aria-label][class*="action"], .action-btn:last-of-type');
  assert.ok(del, 'the newest message offers its actions');
  del.focus();
  assert.equal(document.activeElement, del);

  rerenderWith([first, { ...second, type: 'revoked', body: '' }]);

  const active = document.activeElement;
  assert.ok(active && active !== document.body, 'focus fell to the page');
  assert.ok(container.contains(active), 'focus left the thread');
});

test('keyboard focus returns without scrolling, and to the stop that took the place of the deleted message', () => {
  const [a, b, c, d]: ChatMessageView[] = ['1', '2', '3', '4'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c, d]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();
  const original = HTMLElement.prototype.focus;
  const calls: Array<{ id: string | null; options?: FocusOptions }> = [];
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    calls.push({ id: this.closest('[data-wa-message-id]')?.getAttribute('data-wa-message-id') ?? null, options });
    original.call(this, options);
  };
  try {
    rerenderWith([a, { ...b, type: 'revoked', body: '' }, c, d]);
  } finally {
    HTMLElement.prototype.focus = original;
  }

  // The message after the deleted one now holds its place among the stops (not the newest one), and
  // nothing scrolls.
  assert.deepEqual(calls, [{ id: 'wamid.3', options: { preventScroll: true } }]);
  assert.equal(focusedMessage(), 'wamid.3');
});

// The place is the bubble's position in the document when it is lost, not an index taken at focus time: an
// older page that landed in between would have made that index name a message far from it.
test('the stop that takes the place is found after an older page landed since the focus', () => {
  const [o1, o2, a, b, c]: ChatMessageView[] = ['o1', 'o2', 'a', 'b', 'c'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rerenderWith([o1, o2, a, b, c]);
  assert.equal(document.activeElement, del);
  rerenderWith([o1, o2, a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.c');
});

// A message that leaves the list takes its bubble out of the document with its controls: the stop after it
// takes the focus, and the one before it when it was the last.
test('focus goes to the next stop, then the previous one, when the focused message leaves the list', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const reply = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn');
  assert.ok(reply);
  reply.focus();

  rerenderWith([a, c]);
  assert.equal(focusedMessage(), 'wamid.3');

  rerenderWith([a]);
  assert.equal(focusedMessage(), 'wamid.1');
});

// Only the control went away: its message is still a stop, and it keeps the focus.
test('focus stays on the bubble when a link inside it is the control that went away', () => {
  const linked: ChatMessageView = {
    ...PROMPT,
    id: 'db-2',
    waMessageId: 'wamid.2',
    body: 'see https://example.org/a',
    metadata: undefined,
  };
  const next: ChatMessageView = { ...PROMPT, id: 'db-3', waMessageId: 'wamid.3', body: 'Next', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [linked, next]);
  const link = container.querySelector<HTMLElement>('[data-wa-message-id="wamid.2"] a[href]');
  assert.ok(link, 'the body links its URL');
  link.focus();

  rerenderWith([{ ...linked, body: 'see no link now' }, next]);

  assert.equal(focusedMessage(), 'wamid.2');
});

// A refetch after a reconnect replaces the live copy of a message with its stored row, whose id differs,
// so React remounts the bubble: the message is the same, and focus belongs on it.
test('focus goes to the same message when its bubble is remounted under another key', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rerenderWith([a, b, c].map(m => ({ ...m, id: `row-${m.waMessageId}` })));

  assert.equal(focusedMessage(), 'wamid.2');
});

// Firefox and WebKit leave the focused element active for a frame after it stopped being focusable, so
// the check after the commit finds focus still on the revoked bubble (jsdom never clears it): it has to be
// moved to a stop then, not left for the focusout that follows, which only forgets it.
test('a revoked bubble that still holds focus gives it to the stop that takes its place', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const bubble = bubblesOf(container)[1];
  bubble.focus();
  assert.equal(focusedMessage(), 'wamid.2');

  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.3');
});

// The newest message has no stop after it, so the one before takes its place, and never the oldest.
test('keyboard focus goes to the stop before the deleted message when it was the newest', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[2].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rerenderWith([a, b, { ...c, type: 'revoked', body: '' }]);

  assert.equal(focusedMessage(), 'wamid.2');
});

// Focus the page reports as lost while the control that held it is still a stop (a disabled button, a
// browser that reports the page as active): the thread has nothing to give back, and moving focus to a
// neighbour on a later change of the list would take it from wherever the reader put it.
test('focus the page reports as lost is left alone while the control is still a stop', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.body });
  try {
    rerenderWith([a, b, { ...c, status: 'read' }]);
  } finally {
    delete (document as { activeElement?: unknown }).activeElement;
  }

  // Nothing moved focus: the button still holds it for jsdom.
  assert.ok(document.activeElement === del, 'focus was moved off the control that still holds it');
});

// What was remembered is used once. Here the only stop is gone and nothing in the thread can take the
// focus; a message that arrives later, after the place of the old bubble, does not draw it in.
test('focus is given back once, not at every later change of the list', () => {
  const [a, b]: ChatMessageView[] = ['1', '2'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a]);
  const del = bubblesOf(container)[0].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  del.focus();

  rerenderWith([{ ...a, type: 'revoked', body: '' }]);
  assert.equal(focusedMessage(), 'body');
  rerenderWith([{ ...a, type: 'revoked', body: '' }, b]);

  assert.equal(focusedMessage(), 'body');
});

// A control that is not a message holds no memory: when it goes away (the jump button once the reader is at
// the bottom) React delivers no blur, and a later change of the list used to take focus to the newest
// bubble, which scrolled a reader who had gone back up to read history down to it.
test('a thread control that is removed does not make a later change of the list take focus', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const control = document.createElement('button');
  thread.appendChild(control);
  control.focus();
  control.remove();
  assert.equal(document.activeElement, document.body);

  rerenderWith([first, second]);
  rerenderWith([first, { ...second, status: 'read' }]);

  assert.equal(focusedMessage(), 'body');
});

test('a focus a pointer brought to an action is not given back, and marks pointer use', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first, second]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  // A mouse click: the press, then the focusin of an element that is not the focused one, so not :focus-visible.
  rtl.fireEvent.pointerDown(del);
  rtl.fireEvent.focusIn(del);
  assert.equal(thread.hasAttribute('data-pointer'), true);

  rerenderWith([first, { ...second, type: 'revoked', body: '' }]);

  assert.equal(focusedMessage(), 'body');
});

/** Makes the thread's clock (performance.now) a number the test moves. */
function holdClock(): { advance: (ms: number) => void } {
  let now = 50_000;
  mock.method(performance, 'now', () => now);
  return {
    advance: ms => {
      now += ms;
    },
  };
}

// A script or a screen reader moves focus after a click: nothing pointed at it, so it is not pointer mode,
// and the actions of the message it lands on are shown to that reader.
test('focus moved by a script after a click is not pointer focus, and shows the actions', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const clock = holdClock();
  const [first, second] = bubblesOf(container);

  rtl.fireEvent.pointerDown(first);
  rtl.fireEvent.focusIn(first);
  assert.equal(thread.hasAttribute('data-pointer'), true);

  clock.advance(1500);
  rtl.fireEvent.focusIn(second);
  assert.equal(thread.hasAttribute('data-pointer'), false);
});

// A click focuses its target in the task of its press, which is far inside the window.
test('focus a click brings keeps pointer mode, also a moment after the press', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const clock = holdClock();

  rtl.fireEvent.pointerDown(bubblesOf(container)[0]);
  clock.advance(400);
  rtl.fireEvent.focusIn(bubblesOf(container)[1]);

  assert.equal(thread.hasAttribute('data-pointer'), true);
});

// The lightbox is outside the thread, and its close button gives focus back to the bubble that opened it
// as it goes away: a press anywhere in the page is the one that focus follows, not only a press in the thread.
test('focus given back after a press outside the thread is pointer focus, until the window has passed', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const close = document.createElement('button');
  document.body.appendChild(close);
  const clock = holdClock();
  try {
    rtl.fireEvent.pointerDown(close);
    clock.advance(300);
    rtl.fireEvent.focusIn(bubblesOf(container)[0]);
    assert.equal(thread.hasAttribute('data-pointer'), true);

    rtl.fireEvent.pointerDown(close);
    clock.advance(1500);
    rtl.fireEvent.focusIn(bubblesOf(container)[1]);
    assert.equal(thread.hasAttribute('data-pointer'), false);
  } finally {
    close.remove();
  }
});

// A click acts on release, so the lightbox gives focus back when the press is let go, not when it went down. A
// press held for longer than the window is still the pointer's, and the window runs from the last pointer event.
test('focus given back on the release of a long press is pointer focus, counted from the release', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const close = document.createElement('button');
  document.body.appendChild(close);
  const clock = holdClock();
  try {
    rtl.fireEvent.pointerDown(close);
    clock.advance(1400);
    rtl.fireEvent.pointerUp(close);
    clock.advance(300);
    rtl.fireEvent.focusIn(bubblesOf(container)[0]);
    assert.equal(thread.hasAttribute('data-pointer'), true);

    rtl.fireEvent.pointerDown(close);
    clock.advance(1400);
    rtl.fireEvent.pointerUp(close);
    clock.advance(1500);
    rtl.fireEvent.focusIn(bubblesOf(container)[1]);
    assert.equal(thread.hasAttribute('data-pointer'), false);
  } finally {
    close.remove();
  }
});

// A lightbox or a menu may stop its pointer events from bubbling: the page still has to see them.
test('the pointer is noted before a handler that stops its events from reaching the document', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const close = document.createElement('button');
  for (const type of ['pointerdown', 'pointerup']) close.addEventListener(type, event => event.stopPropagation());
  document.body.appendChild(close);
  const clock = holdClock();
  try {
    rtl.fireEvent.pointerDown(close);
    clock.advance(1400);
    rtl.fireEvent.pointerUp(close);
    clock.advance(300);
    rtl.fireEvent.focusIn(bubblesOf(container)[0]);
    assert.equal(thread.hasAttribute('data-pointer'), true);
  } finally {
    close.remove();
  }
});

test('the thread stops listening for the pointer on the document when it unmounts', () => {
  const original = { add: document.addEventListener, remove: document.removeEventListener };
  const listening = new Set<string>();
  mock.method(
    document,
    'addEventListener',
    function (this: Document, ...args: Parameters<Document['addEventListener']>) {
      if (args[0].startsWith('pointer') && args[2] === true) listening.add(args[0]);
      return original.add.apply(this, args);
    },
  );
  mock.method(
    document,
    'removeEventListener',
    function (this: Document, ...args: Parameters<Document['removeEventListener']>) {
      if (args[2] === true) listening.delete(args[0]);
      return original.remove.apply(this, args);
    },
  );
  renderThread('operator');
  assert.deepEqual([...listening].sort(), ['pointerdown', 'pointerup']);

  rtl.cleanup();
  assert.deepEqual([...listening], []);
});

// A click on the controls of an audio or video element sends the page no pointer event at all.
test('focus on a media control is pointer focus without any press seen', () => {
  const voice: ChatMessageView = {
    ...PROMPT,
    id: 'db-vn',
    waMessageId: 'wamid.vn',
    type: 'voice',
    body: '',
    metadata: { media: { mimetype: 'audio/ogg', data: 'AAAA' } },
  };
  const { container } = renderThread('operator', [PROMPT, voice]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const audio = container.querySelector<HTMLElement>('audio');
  assert.ok(audio);
  holdClock();

  rtl.fireEvent.focusIn(audio);
  assert.equal(thread.hasAttribute('data-pointer'), true);

  rtl.fireEvent.focusIn(bubblesOf(container)[0]);
  assert.equal(thread.hasAttribute('data-pointer'), false);
});

// Focus nothing pointed at is held like focus a key brought: a delete reached that way still gives it back.
test('focus no pointer brought is held, and given back when the message is deleted', () => {
  const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container, rerenderWith } = renderThread('operator', [a, b, c]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  holdClock();

  // Not :focus-visible and no press before it: an assistive technology's focus.
  rtl.fireEvent.focusIn(del);
  rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

  assert.equal(focusedMessage(), 'wamid.3');
});

/** Runs `fn` with `document.hasFocus()` answering `has`: false while another window or a dialog has focus. */
function withPageFocus(has: boolean, fn: () => void): void {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => has });
  try {
    fn();
  } finally {
    delete (document as { hasFocus?: unknown }).hasFocus;
  }
}

// What the thread sees when a native dialog (the delete confirmation) or another window takes the page's focus:
// a blur with no relatedTarget, delivered after confirm() has returned, for the control that is still the
// document's active element. What differs between engines is what document.hasFocus() answers at that moment:
// stock Chrome 155 delivers it with false, stock Firefox 158 with true. Each test that follows runs in both.
const PAGE_BLURS = [
  { when: 'hasFocus() false at the blur', pageHasFocus: false },
  { when: 'hasFocus() true at the blur', pageHasFocus: true },
] as const;

/** The blur a dialog causes: not a focus move, so the control stays the active element. */
function blurForDialog(element: HTMLElement, pageHasFocus: boolean): void {
  assert.ok(document.activeElement === element, 'the blur of a dialog is for the element that is still active');
  withPageFocus(pageHasFocus, () => rtl.fireEvent.focusOut(element));
}

// The confirmation of a mouse click on Delete can stay open for longer than the window. The page's focus
// coming back is not a script's: pointer mode stays, and nothing is held that a click did not bring. The click's
// focus is not :focus-visible, and the blur the dialog causes is delivered in either order of PAGE_BLURS.
for (const { when, pageHasFocus } of PAGE_BLURS) {
  test(`a dialog that outlasts the pointer window does not turn a click into keyboard focus (${when})`, () => {
    const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
      ...PROMPT,
      id: `db-${n}`,
      waMessageId: `wamid.${n}`,
      metadata: undefined,
    }));
    const { container, rerenderWith } = renderThread('operator', [a, b, c]);
    const thread = container.querySelector<HTMLElement>('.room-messages');
    assert.ok(thread);
    const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
    assert.ok(del);
    const clock = holdClock();

    rtl.fireEvent.pointerDown(del);
    focusVisibleOverride = false;
    del.focus();
    blurForDialog(del, pageHasFocus);
    clock.advance(4000);
    rtl.fireEvent.focusIn(del);
    focusVisibleOverride = null;

    assert.equal(thread.hasAttribute('data-pointer'), true);
    rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);
    assert.equal(focusedMessage(), 'body');
  });
}

test('focus that is moved elsewhere before a message was deleted stays there', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first, second]);
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  try {
    bubblesOf(container)[1].focus();
    outside.focus();
    rerenderWith([first, { ...second, type: 'revoked', body: '' }]);
    assert.ok(document.activeElement === outside, 'focus was taken from the element it was moved to');
  } finally {
    outside.remove();
  }
});

// Focus that went to another control and was lost from there (the control closed, as a dialog does) is not
// the thread's to take back: what the thread remembered ended when focus left it.
test('focus that left the thread and was then lost is not taken back into it', () => {
  const first: ChatMessageView = { ...PROMPT, id: 'db-1', waMessageId: 'wamid.1', metadata: undefined };
  const second: ChatMessageView = { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2', metadata: undefined };
  const { container, rerenderWith } = renderThread('operator', [first, second]);
  const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
  assert.ok(del);
  const outside = document.createElement('input');
  document.body.appendChild(outside);
  try {
    del.focus();
    outside.focus();
    outside.remove();
    assert.equal(focusedMessage(), 'body');

    rerenderWith([first, { ...second, type: 'revoked', body: '' }]);

    assert.equal(focusedMessage(), 'body');
  } finally {
    outside.remove();
  }
});

// A native dialog or another window takes the page's focus: the focused control gets a blur with no
// relatedTarget and is still the active element, and it is the active element again when the page is. What was
// held for it must survive that, or the delete that follows finds nothing to give back and the next Tab lands in
// the composer.
for (const { when, pageHasFocus } of PAGE_BLURS) {
  test(`focus held for a control survives the page losing focus, and is given back when the list changes (${when})`, () => {
    const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
      ...PROMPT,
      id: `db-${n}`,
      waMessageId: `wamid.${n}`,
      metadata: undefined,
    }));
    const { container, rerenderWith } = renderThread('operator', [a, b, c]);
    const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
    assert.ok(del);
    del.focus();

    blurForDialog(del, pageHasFocus);
    rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

    assert.equal(focusedMessage(), 'wamid.3');
  });

  // The focus given back with the page is not classified again: the place held for the keyboard is kept and
  // pointer mode is not entered, whether or not the engine calls that focus :focus-visible.
  test(`focus given back with the page keeps what was held, whatever :focus-visible says (${when})`, () => {
    const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
      ...PROMPT,
      id: `db-${n}`,
      waMessageId: `wamid.${n}`,
      metadata: undefined,
    }));
    const { container, rerenderWith } = renderThread('operator', [a, b, c]);
    const thread = container.querySelector<HTMLElement>('.room-messages');
    assert.ok(thread);
    const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
    assert.ok(del);
    del.focus();

    blurForDialog(del, pageHasFocus);
    focusVisibleOverride = false;
    rtl.fireEvent.focusIn(del);
    focusVisibleOverride = null;
    rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

    assert.equal(focusedMessage(), 'wamid.3');
    assert.equal(thread.hasAttribute('data-pointer'), false);
  });

  // The element the page took focus from is only forgiven for the round trip: if focus left the thread by
  // another route and the element is focused again later, that is a new focus and is classified as one.
  test(`a later focus on a control the page once took focus from is classified again (${when})`, () => {
    const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
      ...PROMPT,
      id: `db-${n}`,
      waMessageId: `wamid.${n}`,
      metadata: undefined,
    }));
    const { container, rerenderWith } = renderThread('operator', [a, b, c]);
    const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
    assert.ok(del);
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    try {
      del.focus();
      blurForDialog(del, pageHasFocus);
      // The page never gave focus back to it; the reader moved on to a control outside the thread and returned.
      outside.focus();
      del.focus();
      rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

      assert.equal(focusedMessage(), 'wamid.3');
    } finally {
      outside.remove();
    }
  });

  // The round trip ends when the page gives focus back. The control it was given back to is then an ordinary
  // one: moving on to another message and returning to it is a new focus, held for it like any other.
  test(`a control the page gave focus back to is classified again when the reader returns to it (${when})`, () => {
    const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
      ...PROMPT,
      id: `db-${n}`,
      waMessageId: `wamid.${n}`,
      metadata: undefined,
    }));
    const { container, rerenderWith } = renderThread('operator', [a, b, c]);
    const [first, second] = bubblesOf(container);
    const del = second.querySelector<HTMLElement>('.action-btn:last-of-type');
    assert.ok(del);
    del.focus();

    blurForDialog(del, pageHasFocus);
    rtl.fireEvent.focusIn(del);
    first.focus();
    del.focus();
    rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);

    assert.equal(focusedMessage(), 'wamid.3');
  });

  // Only the one control the page took focus from is forgiven. A focus that lands on another control while the
  // page is still away is a new focus: what is held moves to it, or the place given back after the next change
  // of the list is the stale one.
  test(`a focus on another control after the page lost focus is classified, not taken for the return (${when})`, () => {
    const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
      ...PROMPT,
      id: `db-${n}`,
      waMessageId: `wamid.${n}`,
      metadata: undefined,
    }));
    const { container, rerenderWith } = renderThread('operator', [a, b, c]);
    const [, second, third] = bubblesOf(container);
    const del = second.querySelector<HTMLElement>('.action-btn:last-of-type');
    assert.ok(del);
    del.focus();

    blurForDialog(del, pageHasFocus);
    third.focus();
    rerenderWith([a, b, { ...c, type: 'revoked', body: '' }]);

    assert.equal(focusedMessage(), 'wamid.2');
  });
}

// Focus that went somewhere is not the page's loss, whatever document.hasFocus() answers: the control has
// stopped being the active element by the time the blur is delivered, as in every engine, and nothing is
// held for it. This is what tells a click on a blank area from a dialog without reading the order in which the
// engine delivers the dialog's blur.
for (const { when, pageHasFocus } of PAGE_BLURS) {
  test(`focus that went nowhere is not held (${when})`, () => {
    const [a, b, c]: ChatMessageView[] = ['1', '2', '3'].map(n => ({
      ...PROMPT,
      id: `db-${n}`,
      waMessageId: `wamid.${n}`,
      metadata: undefined,
    }));
    const { container, rerenderWith } = renderThread('operator', [a, b, c]);
    const thread = container.querySelector<HTMLElement>('.room-messages');
    assert.ok(thread);
    const del = bubblesOf(container)[1].querySelector<HTMLElement>('.action-btn:last-of-type');
    assert.ok(del);
    del.focus();
    let activeAtBlur: Element | null = null;
    thread.addEventListener('focusout', () => {
      activeAtBlur = document.activeElement;
    });

    withPageFocus(pageHasFocus, () => del.blur());

    assert.ok(activeAtBlur === document.body, 'the blur of a focus that went nowhere finds no active element');
    rerenderWith([a, { ...b, type: 'revoked', body: '' }, c]);
    assert.equal(focusedMessage(), 'body');
  });
}

// Chats.css shows the actions while focus is inside a bubble, but a click focuses the bubble too, and
// its menu would stay drawn over the message after the pointer left. The thread marks pointer use and the
// stylesheet reveals on focus only without the mark. jsdom has no layout, so the selectors are pinned.
test('a pointer press marks pointer use, a key press clears it, and focus reveals the actions only without the mark', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  assert.equal(thread.hasAttribute('data-pointer'), false);
  rtl.fireEvent.pointerDown(bubblesOf(container)[0]);
  assert.equal(thread.hasAttribute('data-pointer'), true);
  rtl.fireEvent.keyDown(bubblesOf(container)[0], { key: 'Tab' });
  assert.equal(thread.hasAttribute('data-pointer'), false);

  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  for (const target of [
    '.message-bubble-container:focus-within .message-actions-menu',
    '.reaction-trigger-wrapper:focus-within .reaction-quick-popover',
  ]) {
    const rule = css.split('\n').find(line => line.includes(target));
    assert.ok(rule, `${target} reveals the menu on focus`);
    assert.ok(
      rule.includes('.room-messages:not([data-pointer])'),
      `${target} reveals only while the pointer mark is off`,
    );
  }
});

// The button is a child of the scroller. Absolutely positioned there it moves with the content, which put it
// at the bottom of the first screen of the thread and off screen whenever it was shown. Sticky, as the last
// child, it holds to the bottom of the visible pane. jsdom has no layout, so the declarations are pinned:
// the negative margin takes back the room an in-flow button would add to the scroll height, align-self puts
// it at the logical end, and it sits below the actions menu (z-index 5) it would otherwise cover.
test('the scroll-to-bottom button is sticky inside the scroller, not absolute, and below the actions menu', () => {
  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  const rule = /\.chats-page \.scroll-to-bottom-btn \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /position:\s*sticky;/);
  assert.match(rule, /bottom:\s*[\d.]+rem;/);
  assert.match(rule, /align-self:\s*flex-end;/);
  assert.doesNotMatch(rule, /position:\s*absolute/);
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const button = declarationsOf(plain, '.chats-page .scroll-to-bottom-btn');
  const gap = lengthPx(declarationsOf(plain, '.chats-page .room-messages').gap);
  assert.equal(
    lengthPx(button['margin-top']),
    -(lengthPx(button.height) + gap),
    'the negative margin takes back the height and the gap the button adds to the scroll height',
  );
  const menu = /\.chats-page \.message-actions-menu \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const level = (text: string): number => Number(/z-index:\s*(\d+);/.exec(text)?.[1]);
  assert.ok(level(rule) < level(menu), 'the jump button paints over the actions menu');
});

// The stylesheet without its comments, and what is read from it. jsdom has no layout, so the declarations are
// read and evaluated.
const chatsCss = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The `@container` blocks of a stylesheet: the condition, and what is between the braces. */
function containerBlocks(source: string): Array<{ condition: string; body: string }> {
  const blocks: Array<{ condition: string; body: string }> = [];
  for (const head of source.matchAll(/@container\s*([^{]*)\{/g)) {
    const from = (head.index ?? 0) + head[0].length;
    let depth = 1;
    let at = from;
    while (depth > 0 && at < source.length) {
      if (source[at] === '{') depth += 1;
      else if (source[at] === '}') depth -= 1;
      at += 1;
    }
    blocks.push({ condition: head[1].trim(), body: source.slice(from, at - 1) });
  }
  return blocks;
}

/** The declarations of the rule written with exactly `selector`, by property. */
function declarationsOf(source: string, selector: string): Record<string, string> {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  const body = source.slice(source.indexOf('{', at) + 1, source.indexOf('}', at));
  const entries = body
    .split(';')
    .map(declaration => declaration.split(':'))
    .filter(parts => parts.length >= 2)
    .map(([name, ...value]): [string, string] => [name.trim(), value.join(':').trim()]);
  return Object.fromEntries(entries);
}

// A length in px: rem is 16px and em is the given font size, var() is the declared custom property, and calc
// is plain arithmetic.
function lengthPx(value: string, vars: Record<string, string> = {}, emPx = 16): number {
  const expression = value
    .replace(/var\((--[\w-]+)\)/g, (_, name: string) => `(${vars[name]})`)
    .replace(/calc/g, '')
    .replace(/(-?\d*\.?\d+)rem/g, '($1*16)')
    .replace(/(-?\d*\.?\d+)em/g, `($1*${emPx})`)
    .replace(/px/g, '');
  return Function(`return (${expression})`)() as number;
}

// Where the first text of a thread begins, below its padding. A thread opens with the day pill of its first
// message (see the render test below), so that pill's text is the first a reader at the top of the thread sees.
function firstTextStartsPx(): number {
  const thread = declarationsOf(chatsCss, '.chats-page .room-messages');
  const day = declarationsOf(chatsCss, '.chats-page .day-separator');
  const pill = declarationsOf(chatsCss, '.chats-page .day-separator span');
  return (
    lengthPx(thread.padding) +
    lengthPx(day['margin-block'].split(' ')[0]) +
    lengthPx(pill['padding-block'].split(' ')[0])
  );
}

// The older-page indicator sat in flow above the oldest bubble, so it pushed the reader's content down by its
// height and one gap when the page was requested, and back up when it landed. The loading pill's height and
// margins add up to minus the thread's gap, so it adds nothing to the scroll height, and the failure is out of
// flow, so it adds nothing at whatever height its text needs.
test('the older-page indicator takes no room in the thread, loading or failed', () => {
  const rule = (selector: string) => declarationsOf(chatsCss, selector);
  const thread = rule('.chats-page .room-messages');
  const gap = lengthPx(thread.gap);
  const padding = lengthPx(thread.padding);
  const loading = rule('.chats-page .messages-loading-older');
  const failed = rule('.chats-page .messages-loading-older.failed');
  const failedText = rule('.chats-page .messages-loading-older.failed > span');
  const text = rule('.chats-page .messages-loading-older > span');
  const own = { '--older-row-height': loading['--older-row-height'] };

  const outer =
    lengthPx(loading['margin-top'], own) + lengthPx(loading.height, own) + lengthPx(loading['margin-bottom'], own);
  assert.equal(outer, -gap, "the loading indicator's margins and height add up to the thread's gap, minus it");
  assert.equal(loading.position, 'sticky', 'the loading indicator holds to the top edge of the pane (sticky)');
  assert.ok(
    padding + lengthPx(loading['margin-top'], own) >= 0,
    'the loading indicator is lifted no further than the padding above the first message',
  );
  // Sticky offsets are measured from the padding edge, so top is the margin that lifts it: any other value
  // pushes it down onto the first bubble when the thread is at its top.
  assert.equal(
    lengthPx(loading.top, own),
    lengthPx(loading['margin-top'], own),
    "the loading indicator's sticky offset is its lift into the padding",
  );
  assert.equal(
    loading['pointer-events'],
    'none',
    'the loading indicator passes pointer events to the bubbles under it',
  );

  // Out of flow, the failure adds nothing to the thread whatever its height, and it stays at the top of the
  // thread instead of following the reader. Its text wraps up to two lines, and they have to end where the text
  // of the first message begins: a reader at the top of the thread is on that message.
  assert.equal(failed.position, 'absolute', 'the failure indicator is out of flow (position: absolute)');
  assert.ok(lengthPx(failed.top, own) >= 0, 'the failure indicator starts inside the pane (top is not negative)');
  assert.match(failed['max-width'], /100%/, 'the failure indicator is no wider than the pane (max-width is a share)');
  assert.equal(failed.height, 'auto', 'the failure indicator is as tall as its text (height: auto)');
  assert.equal(failedText['white-space'], 'normal', 'the failure text wraps (white-space: normal)');
  const lineClamp = Number(failedText['-webkit-line-clamp']);
  assert.equal(lineClamp, 2, 'the failure text is limited to two lines (-webkit-line-clamp: 2)');

  const fontSize = lengthPx(failed['font-size'], own);
  const line = fontSize * Number(loading['line-height']);
  const border = lengthPx(loading.border.split(' ')[0], own);
  const paddingBlock = lengthPx(failed.padding.split(' ')[0], own);
  const clipRoom = lengthPx(text['padding-block'], own, fontSize);
  const box = Math.max(lineClamp * line + 2 * (border + paddingBlock), lengthPx(failed['min-height'], own));
  // The text paints into the room the clip leaves it below the last line, past the border.
  const ink = border + paddingBlock + lineClamp * line + clipRoom;
  assert.ok(
    lengthPx(failed.top, own) + Math.max(box, ink) <= firstTextStartsPx(),
    "the failure indicator, at two lines, ends above the thread's first text",
  );
});

// The indicator is positioned and comes before the bubbles, so it needs a z-index to be seen over the bubbles
// that scroll under it, and it must not exceed a bubble's actions menu, which it would then cover.
test('the older-page indicator stacks over the bubbles and not over their actions menu', () => {
  const indicator = Number(declarationsOf(chatsCss, '.chats-page .messages-loading-older')['z-index']);
  const menu = Number(declarationsOf(chatsCss, '.chats-page .message-actions-menu')['z-index']);
  assert.ok(indicator > 0, `the indicator has a positive z-index: ${indicator}`);
  assert.ok(indicator <= menu, `the indicator is not above the actions menu: ${indicator} against ${menu}`);
});

// The text of the indicator clips, for its ellipsis and for the limit on the failure's lines, and a line box is
// shorter than the glyphs of some scripts: the tails of g and p, Telugu conjuncts below the base, Arabic marks.
// The padding is the room the clip leaves them and the negative margin takes it back, so the box lays out as
// the line it is.
test('the text of the older-page indicator has room to paint beyond its line without taking any', () => {
  const text = declarationsOf(chatsCss, '.chats-page .messages-loading-older > span');
  assert.equal(text.overflow, 'hidden', 'the text clips (overflow: hidden)');
  for (const axis of ['block', 'inline']) {
    const room = lengthPx(text[`padding-${axis}`]);
    assert.ok(room > 0, `the text has room to paint beyond its line in the ${axis} direction`);
    assert.equal(
      lengthPx(text[`margin-${axis}`]),
      -room,
      `the room in the ${axis} direction is taken back by the margin`,
    );
  }
  // The tallest marks seen (Telugu below the base, in WebKit) need a quarter of the size of the text.
  assert.match(text['padding-block'], /^[\d.]+em$/, 'the room is in em, so it follows the size of the text');
  assert.ok(
    Number.parseFloat(text['padding-block']) >= 0.25,
    'the room above and below a line is a quarter em or more',
  );
});

// The failure shows its whole sentence in a thread wide enough for two lines of it, and only the retry
// instruction at the query's width (max-width: it includes that width) or less. The width that decides it is
// the thread's, not the viewport's: beside the list the thread is narrower than a phone's. Both texts are in
// the document and the stylesheet shows one.
test('the failure indicator shows its retry instruction alone in a thread too narrow for the sentence', () => {
  const thread = declarationsOf(chatsCss, '.chats-page .room-messages');
  assert.equal(
    thread['container-type'],
    'inline-size',
    'the thread is the container the failure text is sized against',
  );

  const hint = declarationsOf(chatsCss, '.chats-page .messages-loading-older.failed > .older-failure-hint');
  assert.equal(hint.display, 'none', 'the retry instruction alone is hidden while the sentence is shown');

  const blocks = containerBlocks(chatsCss);
  assert.equal(blocks.length, 2, 'the indicator changes at two widths: the failure text, and the loading label');
  const narrow = blocks.find(block => block.body.includes('.older-failure-hint'));
  assert.ok(narrow, 'the failure text has a width at which it changes');
  const limit = /^\(max-width:\s*([\d.]+)rem\)$/.exec(narrow.condition);
  assert.ok(limit, `the width is a number of rem, not of px or of the viewport: ${narrow.condition}`);
  // The container is the scroller and the query measures its content box: the client width, which leaves out a
  // scrollbar, less the padding of 1.5rem on each side.
  const clientWidth =
    Number(limit[1]) * 16 + 2 * lengthPx(declarationsOf(chatsCss, '.chats-page .room-messages').padding);
  assert.ok(
    clientWidth >= 308,
    'the sentence is not shown at a client width under the 308px its longest translation needs',
  );
  assert.ok(
    clientWidth < 326,
    'the sentence is shown at 326px of client width, which a 360px phone has with an overlay scrollbar',
  );
  const full = declarationsOf(narrow.body, '.chats-page .messages-loading-older.failed > .older-failure-full');
  assert.equal(full.display, 'none', 'the whole sentence is hidden in a narrow thread');
  const shown = declarationsOf(narrow.body, '.chats-page .messages-loading-older.failed > .older-failure-hint');
  assert.equal(
    shown.display,
    '-webkit-box',
    'the retry instruction is shown in a narrow thread, clamped as the sentence is',
  );
});

// The loading label is one line while the pill fits it, and at 18rem of content or less it may wrap onto a
// second line, at the size of the failure text. The pill is taller there whether or not it wraps, and its
// margins take the height back all the same.
test('the loading label may take two lines in a thread of 18rem or less, and no more room', () => {
  const blocks = containerBlocks(chatsCss);
  const wrapped = blocks.find(block => block.body.includes(':not(.failed)'));
  assert.ok(wrapped, 'the loading label has a width at which it wraps');
  const limit = /^\(max-width:\s*([\d.]+)rem\)$/.exec(wrapped.condition);
  assert.ok(limit, `the width is a number of rem, not of px or of the viewport: ${wrapped.condition}`);
  const contentPx = Number(limit[1]) * 16;
  // The French label, the longest of the translations, is 285px wide with its icon, padding and border.
  assert.ok(contentPx >= 285, 'a thread too narrow for the longest label on one line is wrapped');
  assert.ok(contentPx - 285 < 16, 'the label is not wrapped in a thread with more than a rem to spare');

  const thread = declarationsOf(chatsCss, '.chats-page .room-messages');
  const gap = lengthPx(thread.gap);
  const padding = lengthPx(thread.padding);
  const base = declarationsOf(chatsCss, '.chats-page .messages-loading-older');
  const pill = declarationsOf(wrapped.body, '.chats-page .messages-loading-older:not(.failed)');
  const own = { '--older-row-height': pill['--older-row-height'] };
  assert.equal(
    lengthPx(base['margin-top'], own) + lengthPx(base.height, own) + lengthPx(base['margin-bottom'], own),
    -gap,
    'the taller pill still adds nothing to the thread: its margins and height add up to minus the gap',
  );

  const text = declarationsOf(wrapped.body, '.chats-page .messages-loading-older:not(.failed) > span');
  assert.equal(text['white-space'], 'normal', 'the label wraps (white-space: normal)');
  const lines = Number(text['-webkit-line-clamp']);
  assert.equal(lines, 2, 'the label is limited to two lines (-webkit-line-clamp: 2)');
  const line = lengthPx(pill['font-size'], own) * Number(base['line-height']);
  const border = lengthPx(base.border.split(' ')[0], own);
  const height = lengthPx(base.height, own);
  assert.ok(lines * line + 2 * border <= height, 'the two lines fit inside the height of the pill');
  const top = padding + lengthPx(base['margin-top'], own);
  assert.ok(top + height <= firstTextStartsPx(), "the wrapped pill ends above the thread's first text");
});

test('a failed older page renders the whole sentence and the retry instruction as two texts', () => {
  const { container } = renderThread('operator', [PROMPT], CHAT, { messagesError: true });
  const pill = container.querySelector<HTMLElement>('.messages-loading-older.failed');
  assert.ok(pill, 'the failure is shown above a loaded thread');
  const full = pill.querySelector<HTMLElement>('.older-failure-full');
  const hint = pill.querySelector<HTMLElement>('.older-failure-hint');
  assert.equal(full?.textContent, "Couldn't load older messages. Scroll up to retry.");
  assert.equal(hint?.textContent, 'Scroll up to retry.');
});

// The failed older page is retried by scrolling up, and a reader parked at scrollTop 0 has nowhere to scroll:
// a wheel turn, PageUp or Home there raises no scroll event. jsdom has no layout, so the thread is given a
// position that clamps as a browser's does and raises its scroll event the way one does: later, once, and
// only when the position changed. `writes` is what the page assigned, `deliver` is the frame that dispatches.
function scrollerOf(thread: HTMLElement, start: number) {
  const height = 2000;
  const viewport = 400;
  let top = start;
  let pending = false;
  const writes: number[] = [];
  Object.defineProperties(thread, {
    scrollHeight: { value: height, configurable: true },
    clientHeight: { value: viewport, configurable: true },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        writes.push(value);
        const next = Math.max(0, Math.min(value, height - viewport));
        if (next === top) return;
        top = next;
        pending = true;
      },
    },
  });
  return {
    writes,
    top: () => top,
    // The reader moves the thread: the same position change, not counted among the page's writes.
    scrollTo(value: number) {
      top = Math.max(0, Math.min(value, height - viewport));
      pending = true;
    },
    deliver() {
      if (!pending) return;
      pending = false;
      rtl.fireEvent.scroll(thread);
    },
  };
}

// A page that is out, then fails: the thread is mounted loading, given its geometry, and the failure lands.
function threadWithOlderPageOut(start: number, props: Partial<ComponentProps<typeof ChatThread>> = {}) {
  const requests = { count: 0 };
  const rendered = renderThread('operator', [PROMPT], CHAT, {
    hasMoreMessages: true,
    loadingOlderMessages: true,
    messagesError: false,
    onLoadOlderMessages: () => {
      requests.count += 1;
    },
    ...props,
  });
  const thread = rendered.container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const scroller = scrollerOf(thread, start);
  const fail = () => rendered.rerenderProps({ loadingOlderMessages: false, messagesError: true });
  return { ...rendered, requests, scroller, fail };
}

test('a failure that lands with the reader at the top moves the thread one pixel, and asks for no page', () => {
  const { requests, scroller, fail } = threadWithOlderPageOut(0);
  fail();
  assert.deepEqual(scroller.writes, [1]);
  assert.equal(scroller.top(), 1);
  // The scroll event of that write is the page's own: it is not the reader asking again, and a request
  // from it would fail again and nudge again without anyone touching the thread.
  scroller.deliver();
  assert.equal(requests.count, 0);
});

test('scrolling up from the nudged position retries the page, and a second failure can be retried again', () => {
  const { requests, scroller, fail, rerenderProps } = threadWithOlderPageOut(0);
  fail();
  scroller.deliver();

  scroller.scrollTo(0);
  scroller.deliver();
  assert.equal(requests.count, 1);

  // The request is out, then fails like the first: the reader is at the top again and is moved again.
  rerenderProps({ loadingOlderMessages: true });
  assert.deepEqual(scroller.writes, [1]);
  fail();
  assert.deepEqual(scroller.writes, [1, 1]);
  scroller.deliver();
  assert.equal(requests.count, 1);

  scroller.scrollTo(0);
  scroller.deliver();
  assert.equal(requests.count, 2);
});

// The echo of the page's own write and a scroll of the reader's are told apart by the position they leave: a
// reader's scroll that reaches the top in the same frame as the echo is one scroll event, and it is not the echo.
test('a scroll to the top that arrives with the echo of the nudge is the reader asking again', () => {
  const { requests, scroller, fail } = threadWithOlderPageOut(0);
  fail();
  scroller.scrollTo(0);
  scroller.deliver();
  assert.equal(requests.count, 1);
});

// The echo is skipped once. A scroll of the reader's that comes after it and happens to land on the nudged
// position is a request like any other.
test('only the echo of the nudge is skipped: a later scroll that lands on the same position retries', () => {
  const { requests, scroller, fail } = threadWithOlderPageOut(0);
  fail();
  scroller.deliver();
  assert.equal(requests.count, 0);

  scroller.scrollTo(50);
  scroller.deliver();
  assert.equal(requests.count, 1);
  scroller.scrollTo(1);
  scroller.deliver();
  assert.equal(requests.count, 2);
});

test('a reader who has scrolled away from the top is not moved by a failure', () => {
  // Under the threshold the next scroll retries as it is, so there is nothing to make room for.
  for (const { start, next, retries } of [
    { start: 400, next: 150, retries: 0 },
    { start: 30, next: 10, retries: 1 },
    // Any position above zero is a position to scroll up from, whole pixels or not.
    { start: 1, next: 0, retries: 1 },
    { start: 0.5, next: 0, retries: 1 },
  ]) {
    const { requests, scroller, fail } = threadWithOlderPageOut(start);
    fail();
    assert.deepEqual(scroller.writes, [], `a reader at ${start} was written to`);
    assert.equal(scroller.top(), start);
    scroller.scrollTo(next);
    scroller.deliver();
    assert.equal(requests.count, retries, `a scroll from ${start} to ${next}`);
    rtl.cleanup();
  }
});

test('the reader is moved once for a failure, not at every later render of it', () => {
  const { scroller, fail, rerenderWith } = threadWithOlderPageOut(0);
  fail();
  scroller.deliver();
  scroller.scrollTo(0);
  rerenderWith([PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  assert.deepEqual(scroller.writes, [1]);
});

test('a page that is still loading, or that has no older page behind it, does not move the reader', () => {
  // The error is set while the page is still out: the spinner is what is shown, not the failure.
  const loading = threadWithOlderPageOut(0);
  loading.rerenderProps({ messagesError: true });
  assert.deepEqual(loading.scroller.writes, []);
  rtl.cleanup();

  const nothingOlder = threadWithOlderPageOut(0, { hasMoreMessages: false });
  nothingOlder.fail();
  assert.deepEqual(nothingOlder.scroller.writes, []);
});

// An own bubble is at the end of the pane, and the react icon of its pill is a few pixels from that end: a
// popover centred on it runs past the pane, so the last emoji is clipped and the thread scrolls sideways.
test('the reaction popover of an own message grows from the end of its icon, not from its centre', () => {
  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  const rule =
    /\.chats-page \.message-bubble-wrapper\.outgoing \.reaction-quick-popover \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /inset-inline-end:\s*0;/);
  assert.match(rule, /left:\s*auto;/);
  // No centring on the icon: whatever shift it carries is the one set when it opens.
  assert.doesNotMatch(rule, /-50%/);
});

// jsdom has no layout, so the rectangles are given: a popover that opens 30 px past the start edge of the
// thread is shifted back by 30 px, one inside it is left alone, and the shift is measured again each time.
test('the reaction popover is shifted back inside the thread when it opens past an edge', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const wrapper = bubblesOf(container)[0].querySelector<HTMLElement>('.reaction-trigger-wrapper');
  const popover = wrapper?.querySelector<HTMLElement>('.reaction-quick-popover');
  assert.ok(wrapper && popover);
  const rect = (left: number, right: number) => () =>
    ({ left, right, top: 0, bottom: 0, width: right - left }) as DOMRect;
  thread.getBoundingClientRect = rect(100, 700);

  popover.getBoundingClientRect = rect(70, 278);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.style.getPropertyValue('--popover-shift'), '30px');

  popover.getBoundingClientRect = rect(500, 708);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.style.getPropertyValue('--popover-shift'), '-8px');

  popover.getBoundingClientRect = rect(300, 508);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.style.getPropertyValue('--popover-shift'), '');
  assert.equal(popover.hasAttribute('data-below'), false);
});

// A message at the top of the pane has no room above its icon: the popover opens below it, and is measured
// again each time, so scrolling the message down puts it back above.
test('the reaction popover opens below its icon when it would lie above the thread', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const wrapper = bubblesOf(container)[0].querySelector<HTMLElement>('.reaction-trigger-wrapper');
  const popover = wrapper?.querySelector<HTMLElement>('.reaction-quick-popover');
  assert.ok(wrapper && popover);
  const rect = (top: number) => () => ({ left: 300, right: 508, top, bottom: top + 44, width: 208 }) as DOMRect;
  thread.getBoundingClientRect = () => ({ left: 100, right: 700, top: 200, bottom: 600, width: 600 }) as DOMRect;

  popover.getBoundingClientRect = rect(170);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.hasAttribute('data-below'), true);

  popover.getBoundingClientRect = rect(260);
  rtl.fireEvent.mouseEnter(wrapper);
  assert.equal(popover.hasAttribute('data-below'), false);

  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  assert.match(css, /\.reaction-quick-popover\[data-below\] \{[^}]*top:\s*100%;/);
});

test('the scroll-to-bottom button is the last child of the scroller and jumps without animating', async () => {
  const messages: ChatMessageView[] = ['1', '2'].map(n => ({
    ...PROMPT,
    id: `db-${n}`,
    waMessageId: `wamid.${n}`,
    metadata: undefined,
  }));
  const { container } = renderThread('operator', messages);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  Object.defineProperty(thread, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(thread, 'clientHeight', { value: 400, configurable: true });
  const jumps: ScrollToOptions[] = [];
  thread.scrollTo = ((options: ScrollToOptions) => void jumps.push(options)) as typeof thread.scrollTo;
  rtl.fireEvent.scroll(thread);

  const button = await rtl.waitFor(() => {
    const found = thread.querySelector<HTMLElement>('.scroll-to-bottom-btn');
    assert.ok(found, 'the jump button did not show');
    return found;
  });
  assert.equal(thread.lastElementChild, button);
  rtl.fireEvent.click(button);
  // A smooth jump is cancelled by an older page that lands during the animation.
  assert.deepEqual(jumps, [{ top: 2000 }]);
});

// A Tab from the sidebar into the thread is a key press the thread never sees, so a click made in the thread
// earlier left the pointer mark on, and the focused bubble showed no actions until the next key. A focus
// the browser calls keyboard focus (:focus-visible) clears the mark; the focus a click brings does not match.
test('focus that arrives by keyboard clears the pointer mark a click left, and a mouse focus does not', () => {
  const { container } = renderThread('operator', [PROMPT, { ...PROMPT, id: 'db-2', waMessageId: 'wamid.2' }]);
  const thread = container.querySelector<HTMLElement>('.room-messages');
  assert.ok(thread);
  const bubble = bubblesOf(container)[0];

  rtl.fireEvent.pointerDown(bubble);
  // A focus event on an element that is not the focused one has no :focus-visible, as a click's does not.
  rtl.fireEvent.focusIn(bubble);
  assert.equal(thread.hasAttribute('data-pointer'), true);

  bubble.focus();
  assert.equal(thread.hasAttribute('data-pointer'), false);
});

// Two messages one day apart, and a reply on the second day from the other side.
const DAY = 86_400;
const dayThread = (): ChatMessageView[] => [
  { ...PROMPT, id: 'd1', waMessageId: 'wamid.d1', body: 'first day', metadata: undefined },
  {
    ...PROMPT,
    id: 'd2',
    waMessageId: 'wamid.d2',
    body: 'second day',
    timestamp: PROMPT.timestamp! + DAY,
    metadata: undefined,
  },
  {
    ...PROMPT,
    id: 'd3',
    waMessageId: 'wamid.d3',
    body: 'reply',
    direction: 'outgoing',
    status: 'read',
    timestamp: PROMPT.timestamp! + DAY + 60,
    metadata: undefined,
  },
];

// The older-page indicator is measured against the first text of the thread, which this pill is: a thread
// always opens with the day of its first message.
test('a thread opens with the day of its first message, and each new day gets a pill of its own', () => {
  const { container } = renderThread('operator', dayThread());
  const children = Array.from(container.querySelector('.room-messages')!.children);
  assert.ok(children[0].classList.contains('day-separator'), 'the thread opens with a day pill');
  assert.equal(container.querySelectorAll('.day-separator').length, 2, 'one pill per day');
  // A pill is never an anchor the scroll hook holds the reader by: only messages are.
  assert.ok(!children[0].hasAttribute('data-scroll-anchor'), 'the day pill is not a scroll anchor');
});

test('the first bubble of a run from one side starts a run, and a new day starts one too', () => {
  const { container } = renderThread('operator', dayThread());
  const starts = Array.from(container.querySelectorAll('.message-bubble-wrapper')).map(wrapper =>
    wrapper.classList.contains('run-start'),
  );
  assert.deepEqual(starts, [true, true, true]);

  rtl.cleanup();
  const sameDay = dayThread().map(message => ({ ...message, direction: 'incoming' as const }));
  sameDay[0] = { ...sameDay[0], timestamp: sameDay[1].timestamp };
  const { container: oneRun } = renderThread('operator', sameDay);
  const runStarts = Array.from(oneRun.querySelectorAll('.message-bubble-wrapper')).map(wrapper =>
    wrapper.classList.contains('run-start'),
  );
  assert.deepEqual(runStarts, [true, false, false], 'one side on one day is a single run');
});
