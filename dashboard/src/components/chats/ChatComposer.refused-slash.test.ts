// A slash word that a template matches is sent as typed once the operator has closed the picker for it. When the gateway
// refuses that send the text comes back, and it comes back as the operator had it: the picker stays closed for it, so
// the next Enter sends it again instead of putting the template in its place.
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
const sent: string[] = [];
let refuse = true;
// A condition is waited for up to this long, so a loaded machine makes the test slower and not wrong.
const DEADLINE = { timeout: 10_000 };
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  Element.prototype.scrollIntoView = () => undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname;
    if (path.includes('/templates'))
      return Promise.resolve(json([{ id: 't1', name: 'hola', body: 'Hola! En que te ayudo?' }]));
    sent.push((JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? '');
    return Promise.resolve(
      refuse ? json({ message: 'refused' }, 500) : json({ messageId: `sent-${sent.length}`, timestamp: 1 }),
    );
  }) as typeof fetch;
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
  sent.length = 0;
  refuse = true;
});
after(() => {
  rtl.cleanup();
  queryClient.clear();
});

function Harness() {
  const [messageInput, setMessageInput] = useState('');
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  return createElement(ChatComposer, {
    selectedSessionId: 'sess-1',
    activeChat: chat,
    replyingTo,
    setReplyingTo,
    onMessageAppended: () => undefined,
    onSent: () => undefined,
    // As the page gives a refused text back: into the field, unless something was typed there since.
    onSendFailed: (_session: string, _chat: string, text: string) =>
      setMessageInput(current => (current === '' ? text : current)),
    messageInput,
    setMessageInput,
    attachment,
    setAttachment,
    previewUrl,
    setPreviewUrl,
  });
}

const field = (): HTMLTextAreaElement => document.querySelector('.message-text-input') as HTMLTextAreaElement;
const picker = (): Element | null => document.querySelector('.slash-template-picker');

test('a refused send of a slash word the picker was closed for gives the text back with the picker closed', async () => {
  const { fireEvent, waitFor, screen } = rtl;
  rtl.render(wrap(createElement(Harness)));
  await waitFor(() => assert.ok(field()), DEADLINE);
  field().focus();
  fireEvent.change(field(), { target: { value: '/hola' } });
  await waitFor(() => assert.ok(picker(), 'the picker did not open'), DEADLINE);
  fireEvent.keyDown(field(), { key: 'Escape' });
  assert.ok(picker() === null, 'Escape did not close the picker');

  fireEvent.keyDown(field(), { key: 'Enter' });
  await waitFor(() => assert.equal(field().value, '/hola', 'the refused text was not given back'), DEADLINE);
  assert.deepEqual(sent, ['/hola']);
  assert.ok(picker() === null, 'the picker opened again on the text the operator had sent as typed');

  refuse = false;
  fireEvent.keyDown(field(), { key: 'Enter' });
  await waitFor(
    () => assert.deepEqual(sent, ['/hola', '/hola'], 'the next Enter did not send the text again'),
    DEADLINE,
  );
  assert.ok(screen.queryByText('Hola! En que te ayudo?') === null);
});

test('a refused send of a slash word the picker was open for gives the text back with the picker open', async () => {
  const { fireEvent, waitFor, screen } = rtl;
  rtl.render(wrap(createElement(Harness)));
  await waitFor(() => assert.ok(field()), DEADLINE);
  field().focus();
  // `/zzz` names no template, so the picker has nothing to insert and the draft goes out as typed. The list is waited
  // for: while it loads, Enter waits for it.
  fireEvent.change(field(), { target: { value: '/zzz' } });
  await waitFor(() => assert.ok(screen.getByText('No template matches')), DEADLINE);
  fireEvent.keyDown(field(), { key: 'Enter' });
  await waitFor(() => assert.deepEqual(sent, ['/zzz']), DEADLINE);
  await waitFor(() => assert.equal(field().value, '/zzz'), DEADLINE);
  assert.ok(picker(), 'the picker the operator had not closed was closed for the restored text');
});
