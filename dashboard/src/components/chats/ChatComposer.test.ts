// A picked file is staged only once FileReader has read it. Sending text in that window must not throw the
// file away: the operator saw no banner, so nothing would tell them it was dropped.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, createRef, useState, type ReactNode, type RefObject } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';
import type { ChatComposerHandle, StagedAttachment } from './ChatComposer.tsx';

let rtl: typeof import('@testing-library/react');
let ChatComposer: (typeof import('./ChatComposer.tsx'))['default'];
let wrap: (children: ReactNode) => ReactNode;
let queryClient: import('@tanstack/react-query').QueryClient;

// Reads held until the test finishes them, so a send can land while one is still in flight.
const heldReads: Array<() => void> = [];
class HeldFileReader {
  onload: ((event: { target: { result: string } }) => void) | null = null;
  readAsDataURL(): void {
    heldReads.push(() => this.onload?.({ target: { result: 'data:application/pdf;base64,JVBERi0=' } }));
  }
}

// Request paths the composer sent, in order.
const sentPaths: string[] = [];

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

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).FileReader = HeldFileReader;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname;
    // Composer also loads session templates for `/name` shortcuts; keep that off the send path log.
    if (path.includes('/templates')) {
      return Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
    }
    sentPaths.push(path);
    return Promise.resolve(
      new Response(JSON.stringify({ messageId: 'sent-1' }), { headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ToastProvider } = await import('../Toast.tsx');
  const { RoleContext } = await import('../../hooks/useRole.tsx');
  // Short GC so the templates query from `/name` does not keep the suite alive past --test-timeout.
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

afterEach(() => {
  rtl.cleanup();
  queryClient.clear();
  heldReads.length = 0;
  sentPaths.length = 0;
});

after(() => {
  rtl.cleanup();
  queryClient.clear();
});

function Harness({ reply = null }: { reply?: ChatMessageView | null }) {
  const [messageInput, setMessageInput] = useState('');
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(reply);
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

test('sending text while a picked file is still being read keeps the file', async () => {
  const { screen, fireEvent, act, waitFor } = rtl;
  const { container } = rtl.render(wrap(createElement(Harness)));

  fireEvent.change(screen.getByPlaceholderText('Type a message...'), { target: { value: 'see attached' } });
  const file = new window.File(['%PDF-1.4 stub'], 'contract.pdf', { type: 'application/pdf' });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  assert.equal(heldReads.length, 1);

  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.equal((screen.getByPlaceholderText('Type a message...') as HTMLInputElement).value, ''));
  await act(async () => heldReads[0]());

  assert.equal(
    container.querySelector('.preview-filename')?.textContent,
    'contract.pdf',
    'the picked file was dropped',
  );
});

test('sending while a replacement pick is still being read sends neither file and stages the new one', async () => {
  const { screen, fireEvent, act, waitFor } = rtl;
  const { container } = rtl.render(wrap(createElement(Harness)));
  const fileInput = container.querySelector('input[type="file"]')!;

  const first = new window.File(['%PDF-1.4 old'], 'old.pdf', { type: 'application/pdf' });
  fireEvent.change(fileInput, { target: { files: [first] } });
  await act(async () => heldReads[0]());
  assert.equal(container.querySelector('.preview-filename')?.textContent, 'old.pdf');

  // The replacement is still being read when the operator sends: the file it replaces must not go out.
  const second = new window.File(['%PDF-1.4 new'], 'new.pdf', { type: 'application/pdf' });
  fireEvent.change(fileInput, { target: { files: [second] } });
  fireEvent.change(container.querySelector('.message-text-input')!, { target: { value: 'see attached' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.equal(sentPaths.length, 1));
  assert.deepEqual(sentPaths, ['/api/sessions/sess-1/messages/send-text'], 'the replaced file was sent');
  await act(async () => heldReads[1]());

  assert.equal(
    container.querySelector('.preview-filename')?.textContent,
    'new.pdf',
    'the replacement pick was dropped',
  );
});

test('Enter sends the draft and Shift+Enter does not', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  rtl.render(wrap(createElement(Harness)));
  const field = screen.getByPlaceholderText('Type a message...');
  fireEvent.change(field, { target: { value: 'hello' } });
  fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
  assert.equal(sentPaths.length, 0, 'Shift+Enter sent the draft');
  fireEvent.keyDown(field, { key: 'Enter' });
  await waitFor(() => assert.deepEqual(sentPaths, ['/api/sessions/sess-1/messages/send-text']));
});

test('the attachment and reply banners name the buttons that close them', async () => {
  const { screen, fireEvent, act } = rtl;
  const reply = {
    id: 'm1',
    waMessageId: 'wamid.1',
    chatId: chat.id,
    body: 'see you at noon',
    type: 'text',
    direction: 'incoming',
    status: 'read',
    timestamp: 1_700_000_000,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as ChatMessageView;
  const { container } = rtl.render(wrap(createElement(Harness, { reply })));
  const file = new window.File(['%PDF-1.4 stub'], 'contract.pdf', { type: 'application/pdf' });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await act(async () => heldReads[0]());

  fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
  assert.equal(container.querySelector('.attachment-preview-banner') === null, true, 'the file stayed staged');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  assert.equal(container.querySelector('.replying-preview-banner') === null, true, 'the reply stayed open');
});

test('uncontrolled draftsRef mode syncs across chat switches without flash and supports restoreDraftIfEmpty', async () => {
  const { screen, fireEvent, act } = rtl;
  const chat2: Chat = { ...chat, id: 'bob@c.us', name: 'Bob' };
  const draftsRef: RefObject<Map<string, string>> = { current: new Map<string, string>() };
  const composerHandleRef = createRef<ChatComposerHandle | null>();

  function UncontrolledHarness({ active, initialDraft }: { active: Chat; initialDraft?: string }) {
    const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
    return createElement(ChatComposer, {
      selectedSessionId: 'sess-1',
      activeChat: active,
      replyingTo,
      setReplyingTo,
      onMessageAppended: () => undefined,
      onSent: () => undefined,
      initialDraft,
      draftsRef,
      composerHandleRef,
      attachment,
      setAttachment,
      previewUrl,
      setPreviewUrl,
    });
  }

  const { rerender } = rtl.render(wrap(createElement(UncontrolledHarness, { active: chat, initialDraft: '' })));
  const field = () => screen.getByPlaceholderText('Type a message...') as HTMLTextAreaElement;

  fireEvent.change(field(), { target: { value: 'hello alice' } });
  assert.equal(draftsRef.current.get('sess-1\u0000alice@c.us'), 'hello alice');

  rerender(wrap(createElement(UncontrolledHarness, { active: chat2, initialDraft: '' })));
  assert.equal(field().value, '');

  // restoreDraftIfEmpty ignores mismatched thread and restores active empty thread.
  assert.ok(composerHandleRef.current);
  assert.equal(composerHandleRef.current.restoreDraftIfEmpty('sess-1\u0000alice@c.us', 'wrong'), false);
  act(() => {
    assert.equal(composerHandleRef.current?.restoreDraftIfEmpty('sess-1\u0000bob@c.us', 'restored bob'), true);
  });
  assert.equal(field().value, 'restored bob');
  assert.equal(draftsRef.current.get('sess-1\u0000bob@c.us'), 'restored bob');

  // Does not overwrite non-empty input.
  assert.equal(composerHandleRef.current.restoreDraftIfEmpty('sess-1\u0000bob@c.us', 'should not overwrite'), false);
  assert.equal(field().value, 'restored bob');

  rerender(wrap(createElement(UncontrolledHarness, { active: chat })));
  assert.equal(field().value, 'hello alice');
});

test('a refused dismissed slash send does not suppress the template picker if the user already typed a new draft', async () => {
  const { fireEvent, waitFor } = rtl;
  const fetchOriginal = globalThis.fetch;
  let rejectSend!: () => void;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname;
    if (path.includes('/templates')) {
      return Promise.resolve(
        new Response(JSON.stringify([{ id: 't1', name: 'start', body: 'Welcome aboard!' }]), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    sentPaths.push(path);
    return new Promise<Response>(resolve => {
      rejectSend = () =>
        resolve(
          new Response(JSON.stringify({ message: 'refused' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
    });
  }) as typeof fetch;

  try {
    const draftsRef: RefObject<Map<string, string>> = { current: new Map<string, string>() };
    const composerHandleRef = createRef<ChatComposerHandle | null>();
    function SlashHarness() {
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
        onSendFailed: (sessionId, chatId, text) => {
          const key = `${sessionId}\u0000${chatId}`;
          composerHandleRef.current?.restoreDraftIfEmpty(key, text);
        },
        initialDraft: '',
        draftsRef,
        composerHandleRef,
        attachment,
        setAttachment,
        previewUrl,
        setPreviewUrl,
      });
    }

    const { container } = rtl.render(wrap(createElement(SlashHarness)));
    const field = () => container.querySelector('.message-text-input') as HTMLTextAreaElement;
    const picker = () => container.querySelector('.slash-template-picker');

    field().focus();
    fireEvent.change(field(), { target: { value: '/start' } });
    await waitFor(() => assert.ok(picker(), 'template picker did not open for /start'));

    // Dismiss the picker for /start and send it as literal text.
    fireEvent.keyDown(field(), { key: 'Escape' });
    assert.equal(picker(), null);
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => assert.equal(sentPaths.length, 1));
    assert.equal(field().value, '');

    // Type a new draft while the dismissed /start send is still in flight, then fail the send.
    fireEvent.change(field(), { target: { value: 'typed while in flight' } });
    rejectSend();
    await waitFor(() => assert.ok(container.querySelector('.toast-error') || document.querySelector('.toast')));
    assert.equal(field().value, 'typed while in flight');

    // Pasting /start directly over the new draft must still open the template picker.
    fireEvent.change(field(), { target: { value: '/start' } });
    await waitFor(() => assert.ok(picker(), 'slashClosedFor was poisoned by the earlier refused send'));
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
