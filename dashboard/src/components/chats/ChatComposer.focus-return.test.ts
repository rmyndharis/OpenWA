// A button of the composer that closes with the focus on it (an emoji of the panel, the remove button of a staged file,
// the close button of the reply banner) leaves the focus on the page unless the composer puts it back: what is typed
// next goes nowhere. A tap never moves focus: a focused field raises a phone's keyboard.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState, type ReactNode } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';
import type { StagedAttachment } from './ChatComposer.tsx';

let rtl: typeof import('@testing-library/react');
let ChatComposer: (typeof import('./ChatComposer.tsx'))['default'];
let wrap: (children: ReactNode) => ReactNode;
let queryClient: import('@tanstack/react-query').QueryClient;

const chat: Chat = {
  id: 'alice@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 0,
  archived: false,
  pinned: false,
  muted: false,
};
const quoted: ChatMessageView = {
  id: 'm1',
  waMessageId: 'wamid.m1',
  chatId: chat.id,
  from: chat.id,
  to: 'me',
  body: 'the message that is answered',
  type: 'text',
  direction: 'incoming',
  status: 'delivered',
  createdAt: new Date(1_700_000_000_000).toISOString(),
};
const staged: StagedAttachment = {
  file: new File(['x'], 'report.pdf', { type: 'application/pdf' }),
  base64: 'eA==',
  mimetype: 'application/pdf',
  filename: 'report.pdf',
};

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = (() =>
    Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))) as typeof fetch;
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ToastProvider } = await import('../Toast.tsx');
  const { RoleContext } = await import('../../hooks/useRole.tsx');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const role = {
    role: 'admin' as const,
    setRole: () => undefined,
    isAdmin: true,
    isOperator: false,
    isViewer: false,
    canWrite: true,
    engineType: null,
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
  };
  wrap = children =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleContext.Provider, { value: role }, createElement(ToastProvider, null, children)),
    );
  ({ default: ChatComposer } = await import('./ChatComposer.tsx'));
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient.isFetching(), 0));
  rtl.cleanup();
  queryClient.clear();
});

after(() => {
  rtl.cleanup();
  queryClient.clear();
});

function Harness({ withAttachment = false, withReply = false }: { withAttachment?: boolean; withReply?: boolean }) {
  const [messageInput, setMessageInput] = useState('hello ');
  const [attachment, setAttachment] = useState<StagedAttachment | null>(withAttachment ? staged : null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(withReply ? quoted : null);
  return createElement(ChatComposer, {
    selectedSessionId: 'sess-1',
    activeChat: chat,
    replyingTo,
    setReplyingTo,
    onMessageAppended: () => undefined,
    onSent: () => undefined,
    messageInput,
    setMessageInput,
    attachment,
    setAttachment,
    previewUrl,
    setPreviewUrl,
  });
}

/** What holds focus, by tag and accessible name: never two DOM nodes compared. */
function focused(): string {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return 'the page';
  return `${active.tagName.toLowerCase()} "${(active.getAttribute('aria-label') ?? active.getAttribute('placeholder') ?? active.textContent ?? '').trim().slice(0, 40)}"`;
}

const field = (): HTMLTextAreaElement => document.querySelector('.message-text-input') as HTMLTextAreaElement;

async function ready(): Promise<void> {
  await rtl.waitFor(() => assert.ok(field()));
}

/** A press the way a browser makes it: the pointer goes down on the button, which takes focus, and then the click. */
function press(button: HTMLElement, pointerType: 'mouse' | 'touch' | 'pen' | 'key'): void {
  if (pointerType === 'key') rtl.fireEvent.keyDown(button, { key: 'Enter' });
  else rtl.fireEvent.pointerDown(button, { pointerType });
  button.focus();
  rtl.fireEvent.click(button);
}

for (const pointerType of ['mouse', 'pen', 'key'] as const) {
  test(`picking an emoji by ${pointerType} keeps focus in the message field`, async () => {
    rtl.render(wrap(createElement(Harness)));
    await ready();
    field().focus();
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Pick emoji' }));
    press(document.querySelector('.chats-emoji-picker .emoji-btn') as HTMLElement, pointerType);
    assert.ok(document.querySelector('.chats-emoji-picker') === null, 'the panel stayed open');
    assert.equal(field().value, 'hello 😀', 'the emoji was not inserted');
    assert.match(focused(), /^textarea /, `focus is on ${focused()}, so what is typed next goes nowhere`);
  });
}

test('picking an emoji by a tap leaves focus alone, as a focused field raises a phone keyboard', async () => {
  rtl.render(wrap(createElement(Harness)));
  await ready();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Pick emoji' }));
  press(document.querySelector('.chats-emoji-picker .emoji-btn') as HTMLElement, 'touch');
  assert.ok(document.querySelector('.chats-emoji-picker') === null, 'the panel stayed open');
  assert.equal(field().value, 'hello 😀', 'the emoji was not inserted');
  assert.equal(focused(), 'the page');
});

test('a key on an emoji after an earlier tap on one puts the focus in the message field', async () => {
  rtl.render(wrap(createElement(Harness)));
  await ready();
  const toggle = rtl.screen.getByRole('button', { name: 'Pick emoji' });
  rtl.fireEvent.click(toggle);
  press(document.querySelector('.chats-emoji-picker .emoji-btn') as HTMLElement, 'touch');
  assert.equal(focused(), 'the page');
  rtl.fireEvent.click(toggle);
  press(document.querySelector('.chats-emoji-picker .emoji-btn') as HTMLElement, 'key');
  assert.match(focused(), /^textarea /, `focus is on ${focused()}, so the tap before is still taken for this press`);
});

test('Escape from an emoji button closes the panel and puts the focus in the field', async () => {
  rtl.render(wrap(createElement(Harness)));
  await ready();
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Pick emoji' }));
  const emoji = document.querySelector('.chats-emoji-picker .emoji-btn') as HTMLElement;
  emoji.focus();
  rtl.fireEvent.keyDown(emoji, { key: 'Escape' });
  assert.ok(document.querySelector('.chats-emoji-picker') === null, 'the panel stayed open');
  assert.match(focused(), /^textarea /, `focus is on ${focused()}, so the next Tab starts from the top of the page`);
});

test('Escape with the focus on the emoji toggle leaves it there', async () => {
  rtl.render(wrap(createElement(Harness)));
  await ready();
  const toggle = rtl.screen.getByRole('button', { name: 'Pick emoji' });
  rtl.fireEvent.click(toggle);
  toggle.focus();
  rtl.fireEvent.keyDown(toggle, { key: 'Escape' });
  assert.ok(document.querySelector('.chats-emoji-picker') === null, 'the panel stayed open');
  assert.equal(focused(), 'button "Pick emoji"');
});

for (const pointerType of ['mouse', 'key'] as const) {
  test(`removing the staged file by ${pointerType} puts the focus in the message field`, async () => {
    rtl.render(wrap(createElement(Harness, { withAttachment: true })));
    await ready();
    press(document.querySelector('.btn-remove-attachment') as HTMLElement, pointerType);
    assert.ok(document.querySelector('.attachment-preview-banner') === null, 'the file stayed staged');
    assert.match(focused(), /^textarea /, `focus is on ${focused()}`);
  });

  test(`closing the reply banner by ${pointerType} puts the focus in the message field`, async () => {
    rtl.render(wrap(createElement(Harness, { withReply: true })));
    await ready();
    press(document.querySelector('.btn-close-reply') as HTMLElement, pointerType);
    assert.ok(document.querySelector('.replying-preview-banner') === null, 'the reply stayed open');
    assert.match(focused(), /^textarea /, `focus is on ${focused()}`);
  });
}

test('a tap on the remove button or the reply close button leaves focus alone', async () => {
  rtl.render(wrap(createElement(Harness, { withAttachment: true, withReply: true })));
  await ready();
  press(document.querySelector('.btn-remove-attachment') as HTMLElement, 'touch');
  assert.equal(focused(), 'the page');
  press(document.querySelector('.btn-close-reply') as HTMLElement, 'touch');
  assert.equal(focused(), 'the page');
});
