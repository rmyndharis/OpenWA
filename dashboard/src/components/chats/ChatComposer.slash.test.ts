// `/name` inserts the highlighted session template. A draft that does not resolve is sent as typed.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState, type ReactNode } from 'react';
import type { Chat } from '../../services/api.ts';
import type { ChatMessageView } from '../../utils/chatMessages.ts';
import type { StagedAttachment } from './ChatComposer.tsx';

let rtl: typeof import('@testing-library/react');
let ChatComposer: (typeof import('./ChatComposer.tsx'))['default'];
let wrap: (children: ReactNode, canWrite?: boolean) => ReactNode;
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

type TemplateRow = { id: string; name: string; body: string; header?: string | null; footer?: string | null };

let templates: TemplateRow[] = [];
let templatesMode: 'ok' | 'hang' | 'fail' = 'ok';
const sent: Array<{ path: string; body: { text?: string; quotedMessageId?: string } }> = [];
const heldReads: Array<() => void> = [];

class HeldFileReader {
  onload: ((event: { target: { result: string } }) => void) | null = null;
  readAsDataURL(): void {
    heldReads.push(() => this.onload?.({ target: { result: 'data:application/pdf;base64,JVBERi0=' } }));
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).FileReader = HeldFileReader;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname;
    if (path.includes('/templates')) {
      if (templatesMode === 'hang') {
        return new Promise<Response>(() => {});
      }
      if (templatesMode === 'fail') return Promise.resolve(json({ message: 'nope' }, 500));
      return Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string; quotedMessageId?: string }) : {};
    sent.push({ path, body });
    return Promise.resolve(json({ messageId: 'sent-1', timestamp: 1_700_000_000 }));
  }) as typeof fetch;
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ToastProvider } = await import('../Toast.tsx');
  const { RoleContext } = await import('../../hooks/useRole.tsx');
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const roleFor = (canWrite: boolean) => ({
    role: (canWrite ? 'admin' : 'viewer') as 'admin' | 'viewer',
    setRole: () => undefined,
    isAdmin: canWrite,
    isOperator: false,
    isViewer: !canWrite,
    canWrite,
    engineType: null,
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
  });
  wrap = (children, canWrite = true) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RoleContext.Provider, { value: roleFor(canWrite) }, createElement(ToastProvider, null, children)),
    );
  ({ default: ChatComposer } = await import('./ChatComposer.tsx'));
});

afterEach(() => {
  templatesMode = 'ok';
  rtl.cleanup();
  queryClient.clear();
  templates = [];
  sent.length = 0;
  heldReads.length = 0;
});

after(() => {
  rtl?.cleanup();
  queryClient?.clear();
});

function Harness({ initial = '', reply = null }: { initial?: string; reply?: ChatMessageView | null }) {
  const [messageInput, setMessageInput] = useState(initial);
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

function field(): HTMLTextAreaElement {
  return rtl.screen.getByRole('combobox');
}

function seedTemplates(): void {
  queryClient.setQueryData(['sessions', 'sess-1', 'templates'], templates);
}

function renderComposer(
  props?: { initial?: string; reply?: ChatMessageView | null },
  canWrite = true,
): ReturnType<typeof rtl.render> {
  seedTemplates();
  return rtl.render(wrap(createElement(Harness, props), canWrite));
}

async function typeSlash(value: string, option?: RegExp): Promise<void> {
  rtl.fireEvent.change(field(), { target: { value } });
  if (option) await rtl.screen.findByRole('option', { name: option });
  else await rtl.screen.findByText('No template matches');
}

test('Enter on an exact name inserts that template and the next Enter sends it', async () => {
  templates = [{ id: '1', name: 'hola', body: '¡Hola!' }];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  const box = field();
  assert.equal(box.getAttribute('aria-expanded'), 'true');
  assert.ok(box.getAttribute('aria-activedescendant'));
  rtl.fireEvent.keyDown(box, { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, '¡Hola!'));
  assert.equal(sent.length, 0, 'the template was sent before the operator did');
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].body.text, '¡Hola!');
  assert.match(sent[0].path, /\/messages\/send-text$/);
});

test('an unknown /word is sent as typed', async () => {
  templates = [{ id: '1', name: 'hola', body: '¡Hola!' }];
  renderComposer();
  await typeSlash('/start');
  assert.equal(rtl.screen.getByText('No template matches').textContent, 'No template matches');
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].body.text, '/start');
});

test('Enter inserts the highlighted template, not the name that equals the draft', async () => {
  templates = [
    { id: '1', name: 'promo', body: 'the promo' },
    { id: '2', name: 'promo2', body: 'the other promo' },
  ];
  renderComposer();
  await typeSlash('/promo', /\/promo2/);
  rtl.fireEvent.keyDown(field(), { key: 'ArrowDown' });
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, 'the other promo'));
  assert.equal(sent.length, 0);
});

test('a bare / inserts the highlighted template', async () => {
  templates = [
    { id: '1', name: 'hola', body: '¡Hola!' },
    { id: '2', name: 'aviso', body: 'corte' },
  ];
  renderComposer();
  await typeSlash('/', /\/aviso/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, 'corte'));
  assert.equal(sent.length, 0);
});

test('two names that differ only by case insert the highlighted row', async () => {
  templates = [
    { id: 'a', name: 'Hola', body: 'first' },
    { id: 'b', name: 'hola', body: 'second' },
  ];
  renderComposer();
  rtl.fireEvent.change(field(), { target: { value: '/hola' } });
  await rtl.waitFor(() => assert.equal(rtl.screen.getAllByRole('option').length, 2));
  rtl.fireEvent.keyDown(field(), { key: 'ArrowDown' });
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, 'second'));
});

test('a template with gateway placeholders is inserted, not sent raw', async () => {
  templates = [
    {
      id: 'p',
      name: 'pedido',
      header: 'Nucleo',
      body: 'Hi {{customer.name}} {{order-id}} {otp}',
    },
  ];
  renderComposer();
  await typeSlash('/pedido', /\/pedido/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, 'Nucleo\n\nHi {{customer.name}} {{order-id}} {otp}'));
  assert.equal(sent.length, 0, 'placeholders went out unfilled');
});

test('Tab does not take the highlighted template', async () => {
  templates = [{ id: '1', name: 'hola', body: '¡Hola!' }];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  assert.equal(rtl.fireEvent.keyDown(field(), { key: 'Tab' }), true, 'Tab was captured');
  assert.equal(field().value, '/hola');
  assert.equal(sent.length, 0);
});

test('Escape dismisses the picker and keeps the draft', async () => {
  templates = [{ id: '1', name: 'hola', body: '¡Hola!' }];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  assert.equal(rtl.fireEvent.keyDown(field(), { key: 'Escape' }), false, 'Escape was not taken');
  assert.equal(field().value, '/hola');
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByRole('listbox'), null));
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent[0]?.body.text, '/hola'));
});

test('a list that is still loading sends the draft and does not say the name is missing', async () => {
  templatesMode = 'hang';
  rtl.render(wrap(createElement(Harness)));
  rtl.fireEvent.change(field(), { target: { value: '/start' } });
  await rtl.screen.findByText('Loading templates…');
  assert.equal(rtl.screen.queryByText(/No template named/), null);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent[0]?.body.text, '/start'));
});

test('a list that failed to load sends the draft', async () => {
  templatesMode = 'fail';
  rtl.render(wrap(createElement(Harness)));
  rtl.fireEvent.change(field(), { target: { value: '/menu' } });
  await rtl.screen.findByText('Templates could not be loaded');
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent[0]?.body.text, '/menu'));
});

test('a viewer gets no template picker', async () => {
  templates = [{ id: '1', name: 'hola', body: '¡Hola!' }];
  rtl.render(wrap(createElement(Harness, { initial: '/hola' }), false));
  assert.equal(rtl.screen.queryByRole('listbox'), null);
  assert.equal(field().value, '/hola');
});

test('a staged attachment hides the template picker', async () => {
  templates = [{ id: '1', name: 'hola', body: '¡Hola!' }];
  const { container } = renderComposer();
  await rtl.screen.findByRole('combobox');
  const file = new window.File(['%PDF-1.4 stub'], 'contract.pdf', { type: 'application/pdf' });
  rtl.fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await rtl.act(async () => heldReads[0]());
  rtl.fireEvent.change(field(), { target: { value: '/hola' } });
  assert.equal(rtl.screen.queryByRole('listbox'), null);
});

test('sending an inserted template keeps the reply quote', async () => {
  templates = [{ id: '1', name: 'hola', body: '¡Hola!' }];
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
  renderComposer({ reply });
  assert.ok(rtl.screen.getByText('see you at noon'));
  await typeSlash('/hola', /\/hola/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, '¡Hola!'));
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.match(sent[0].path, /\/messages\/reply$/);
  assert.equal(sent[0].body.text, '¡Hola!');
  assert.equal(sent[0].body.quotedMessageId, 'wamid.1');
  assert.equal(rtl.screen.queryByText('see you at noon'), null, 'the quote stayed after send');
});
