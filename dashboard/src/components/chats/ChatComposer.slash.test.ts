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
// 'hang' never answers the list; 'held' answers it when the test calls releaseTemplates.
let templatesMode: 'ok' | 'hang' | 'held' | 'fail' = 'ok';
let releaseTemplates: (list: TemplateRow[]) => void = () => undefined;
const sent: Array<{ path: string; body: { text?: string; quotedMessageId?: string } }> = [];
// With `holdSends`, a send is answered when the test calls its entry here.
let holdSends = false;
const heldSends: Array<() => void> = [];
const heldReads: Array<() => void> = [];
// The id of every element scrolled into view, in order.
const scrolledTo: string[] = [];

class HeldFileReader {
  onload: ((event: { target: { result: string } }) => void) | null = null;
  readAsDataURL(): void {
    heldReads.push(() => this.onload?.({ target: { result: 'data:application/pdf;base64,JVBERi0=' } }));
  }
}

const NEEDS_VARIABLES = "Fill in the template's placeholders before sending.";
const PEDIDO: TemplateRow = {
  id: 'p',
  name: 'pedido',
  header: 'Nucleo',
  body: 'Hi {{customer.name}} {{order-id}} {otp}',
};
const PEDIDO_TEXT = 'Nucleo\n\nHi {{customer.name}} {{order-id}} {otp}';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).FileReader = HeldFileReader;
  // jsdom has no layout, and so no scrollIntoView.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this.id);
  };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost').pathname;
    if (path.includes('/templates')) {
      if (templatesMode === 'hang') {
        return new Promise<Response>(() => {});
      }
      if (templatesMode === 'held') {
        return new Promise<Response>(resolve => {
          releaseTemplates = list => resolve(json(list));
        });
      }
      if (templatesMode === 'fail') return Promise.resolve(json({ message: 'nope' }, 500));
      return Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string; quotedMessageId?: string }) : {};
    sent.push({ path, body });
    const answer = json({ messageId: `sent-${sent.length}`, timestamp: 1_700_000_000 });
    if (!holdSends) return Promise.resolve(answer);
    return new Promise<Response>(resolve => {
      heldSends.push(() => resolve(answer));
    });
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
  holdSends = false;
  while (heldSends.length > 0) heldSends.shift()?.();
  rtl.cleanup();
  queryClient.clear();
  templates = [];
  sent.length = 0;
  heldReads.length = 0;
  scrolledTo.length = 0;
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

// By its class: the field is a combobox only while a list is offered.
function field(): HTMLTextAreaElement {
  const found = document.querySelector<HTMLTextAreaElement>('.message-text-input');
  assert.ok(found, 'the composer has no message field');
  return found;
}

/** The picker is offered while the field has focus. */
function focusField(): void {
  rtl.act(() => field().focus());
}

const count = (selector: string): number => document.querySelectorAll(selector).length;
const fieldFocused = (): boolean => document.activeElement === field();
const sendButton = (): HTMLButtonElement => rtl.screen.getByRole('button', { name: 'Send' });
const pickerStatus = (): string | null | undefined =>
  document.querySelector('.slash-template-picker [role="status"]')?.textContent;
const composerStatus = (): string | null | undefined =>
  document.querySelector('.room-input-footer [role="status"]')?.textContent;

/** What the field tells assistive technology about the list, and how many lists are drawn. */
function semantics() {
  const box = field();
  return {
    role: box.getAttribute('role'),
    expanded: box.getAttribute('aria-expanded'),
    controls: box.getAttribute('aria-controls'),
    active: box.getAttribute('aria-activedescendant'),
    autocomplete: box.getAttribute('aria-autocomplete'),
    describedBy: box.getAttribute('aria-describedby'),
    lists: count('[role="listbox"]'),
  };
}
const NO_LIST = {
  role: null,
  expanded: null,
  controls: null,
  active: null,
  autocomplete: null,
  describedBy: null,
  lists: 0,
};

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
  focusField();
  rtl.fireEvent.change(field(), { target: { value } });
  if (option) await rtl.screen.findByRole('option', { name: option });
  else await rtl.screen.findByText('No template matches');
}

/** One turn of the event loop, so a send that was (wrongly) started has reached the fetch stub. */
const flush = () => rtl.act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));

const HOLA: TemplateRow = { id: '1', name: 'hola', body: '¡Hola!' };
const options = (): Element[] => [...document.querySelectorAll('[role="option"]')];
const selected = (): string =>
  options()
    .map(option => option.getAttribute('aria-selected'))
    .join(' ');

test('Enter on an exact name inserts that template and the next Enter sends it', async () => {
  templates = [HOLA];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, '¡Hola!'));
  assert.equal(sent.length, 0, 'the template was sent before the operator did');
  // A template without placeholders is not held.
  assert.equal(composerStatus(), '');
  assert.equal(sendButton().disabled, false);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].body.text, '¡Hola!');
  assert.match(sent[0].path, /\/messages\/send-text$/);
});

test('an unknown /word is sent as typed', async () => {
  templates = [HOLA];
  renderComposer();
  await typeSlash('/start');
  assert.equal(pickerStatus(), 'No template matches');
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].body.text, '/start');
});

test('the field is a combobox only while a list is offered, and the hint only where Enter inserts', async () => {
  templates = [HOLA, { id: '2', name: 'horario', body: '9 a 18' }];
  renderComposer();
  focusField();
  assert.deepEqual(semantics(), NO_LIST, 'an empty field');
  rtl.fireEvent.change(field(), { target: { value: 'hola' } });
  assert.deepEqual(semantics(), NO_LIST, 'a draft that is no slash word');

  await typeSlash('/ho', /\/hola/);
  const list = document.querySelector('[role="listbox"]');
  const hint = document.querySelector('.slash-template-hint');
  assert.ok(list?.id && hint?.id);
  assert.deepEqual(semantics(), {
    role: 'combobox',
    expanded: 'true',
    controls: list.id,
    active: options()[0].id,
    autocomplete: 'list',
    describedBy: hint.id,
    lists: 1,
  });
  assert.equal(hint.textContent, 'Enter inserts the highlighted template. Send it when it is ready.');
  assert.equal(selected(), 'true false');
  assert.equal(pickerStatus(), '');

  await typeSlash('/zzz');
  assert.deepEqual(semantics(), NO_LIST, 'a slash word no template matches');
  assert.equal(pickerStatus(), 'No template matches');
  assert.equal(count('.slash-template-hint'), 0, 'the hint promises an insert where Enter sends the draft');
});

test('the arrow keys move the highlight, which the field names and the list brings into view', async () => {
  templates = ['a', 'b', 'c'].map(name => ({ id: name, name, body: `body ${name}` }));
  renderComposer();
  await typeSlash('/', /\/a/);
  const ids = options().map(option => option.id);
  const active = () => field().getAttribute('aria-activedescendant');
  assert.equal(active(), ids[0]);
  assert.equal(selected(), 'true false false');

  assert.equal(rtl.fireEvent.keyDown(field(), { key: 'ArrowDown' }), false, 'the caret moved with the highlight');
  assert.equal(active(), ids[1]);
  assert.equal(selected(), 'false true false');
  rtl.fireEvent.keyDown(field(), { key: 'ArrowDown' });
  assert.equal(selected(), 'false false true');
  rtl.fireEvent.keyDown(field(), { key: 'ArrowDown' });
  assert.equal(selected(), 'true false false', 'the highlight does not wrap to the first row');
  rtl.fireEvent.keyDown(field(), { key: 'ArrowUp' });
  assert.equal(active(), ids[2]);
  assert.equal(selected(), 'false false true');
  assert.equal(document.querySelector('.slash-template-item.active')?.id, ids[2]);
  assert.deepEqual(scrolledTo, [ids[1], ids[2], ids[0], ids[2]]);
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
  templates = [HOLA, { id: '2', name: 'aviso', body: 'corte' }];
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
  focusField();
  rtl.fireEvent.change(field(), { target: { value: '/hola' } });
  await rtl.waitFor(() => assert.equal(options().length, 2));
  rtl.fireEvent.keyDown(field(), { key: 'ArrowDown' });
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, 'second'));
});

test('a press on a row inserts its template and leaves focus in the field', async () => {
  templates = [HOLA, { id: '2', name: 'aviso', body: 'corte' }];
  renderComposer();
  await typeSlash('/', /\/aviso/);
  const row = rtl.screen.getByRole('option', { name: /\/hola/ });
  assert.equal(row.getAttribute('aria-selected'), 'false');
  rtl.fireEvent.mouseMove(row);
  assert.equal(row.getAttribute('aria-selected'), 'true', 'the pointer does not move the highlight');

  // The secondary button opens the context menu, and inserts nothing.
  rtl.fireEvent.mouseDown(row, { button: 2 });
  assert.equal(field().value, '/');
  assert.equal(rtl.fireEvent.mouseDown(row, { button: 0 }), false, 'the press takes focus from the field');
  await rtl.waitFor(() => assert.equal(field().value, '¡Hola!'));
  assert.equal(fieldFocused(), true);
  assert.equal(sent.length, 0);
});

test('the picker is offered only while the field has focus, and a press in it leaves the focus there', async () => {
  templates = [HOLA];
  // A draft kept in a chat that opens with focus elsewhere (a key on its row, a tap).
  renderComposer({ initial: '/ho' });
  assert.equal(count('.slash-template-picker'), 0, 'the picker opened with focus outside the field');
  assert.deepEqual(semantics(), NO_LIST);

  focusField();
  await rtl.screen.findByRole('option', { name: /\/hola/ });
  const hint = document.querySelector('.slash-template-hint');
  assert.ok(hint);
  assert.equal(rtl.fireEvent.mouseDown(hint), false, 'a press on the hint takes focus from the field');

  rtl.act(() => field().blur());
  assert.equal(count('.slash-template-picker'), 0, 'the picker stayed open without the field');
  assert.deepEqual(semantics(), NO_LIST);
  focusField();
  assert.equal(options().length, 1);
});

test('the Send button inserts the highlighted template too, and hands the focus to the field', async () => {
  templates = [{ id: '1', name: 'stop-promo', body: 'Promo stopped.' }];
  renderComposer();
  await typeSlash('/stop', /\/stop-promo/);
  // A press on the button takes focus from the field, which closes the picker, before its click.
  rtl.act(() => sendButton().focus());
  assert.equal(count('.slash-template-picker'), 0);
  rtl.fireEvent.click(sendButton());
  await rtl.waitFor(() => assert.equal(field().value, 'Promo stopped.'));
  assert.equal(sent.length, 0, 'the slash word went out as typed');
  assert.equal(fieldFocused(), true);
});

test('the close button dismisses the picker as Escape does, so the draft can be sent as typed', async () => {
  templates = [{ id: '1', name: 'stop-promo', body: 'Promo stopped.' }];
  renderComposer();
  await typeSlash('/stop', /\/stop-promo/);
  const close = rtl.screen.getByRole('button', { name: 'Close the template list' });
  assert.equal(rtl.fireEvent.mouseDown(close), false, 'the press takes focus from the field');
  rtl.fireEvent.click(close);
  assert.equal(count('.slash-template-picker'), 0);
  assert.equal(field().value, '/stop');
  rtl.act(() => sendButton().focus());
  rtl.fireEvent.click(sendButton());
  await rtl.waitFor(() => assert.equal(sent[0]?.body.text, '/stop'));
});

test('a template with placeholders is held until the draft changes, and the composer says so', async () => {
  templates = [PEDIDO];
  renderComposer();
  await typeSlash('/pedido', /\/pedido/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, PEDIDO_TEXT));
  // Typing replaces the first placeholder.
  assert.equal(field().value.slice(field().selectionStart, field().selectionEnd), '{{customer.name}}');
  assert.equal(fieldFocused(), true);
  assert.equal(composerStatus(), NEEDS_VARIABLES);
  assert.equal(count('.toast'), 0, 'the notice is a toast, which covers the composer');
  assert.equal(sendButton().disabled, true);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  rtl.fireEvent.submit(document.querySelector('.input-form') as HTMLFormElement);
  await flush();
  assert.equal(sent.length, 0, 'placeholders went out unfilled');
  assert.equal(field().value, PEDIDO_TEXT);

  // An edited template is the operator's to send; the notice stays while one of its placeholders does.
  const partly = PEDIDO_TEXT.replace('{{customer.name}}', 'Ana');
  rtl.fireEvent.change(field(), { target: { value: partly } });
  assert.equal(composerStatus(), NEEDS_VARIABLES, 'two placeholders are still in the draft');
  assert.equal(sendButton().disabled, false);
  // Undone, the draft is the inserted text again.
  rtl.fireEvent.change(field(), { target: { value: PEDIDO_TEXT } });
  assert.equal(sendButton().disabled, true);
  const filled = 'Nucleo\n\nHi Ana 1042 7731';
  rtl.fireEvent.change(field(), { target: { value: filled } });
  assert.equal(composerStatus(), '');
  assert.equal(sendButton().disabled, false);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].body.text, filled);
});

// The hold stands for the text that would go out, and a send trims its text: a space or a line break around the
// inserted template edits nothing of it.
test('a template with whitespace around it is held like the template itself', async () => {
  templates = [PEDIDO];
  renderComposer();
  await typeSlash('/pedido', /\/pedido/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, PEDIDO_TEXT));
  for (const padded of [`${PEDIDO_TEXT} `, `${PEDIDO_TEXT}\n`, `  ${PEDIDO_TEXT}\n\n`]) {
    rtl.fireEvent.change(field(), { target: { value: padded } });
    assert.equal(composerStatus(), NEEDS_VARIABLES, JSON.stringify(padded));
    assert.equal(sendButton().disabled, true, JSON.stringify(padded));
    rtl.fireEvent.keyDown(field(), { key: 'Enter' });
    rtl.fireEvent.submit(document.querySelector('.input-form') as HTMLFormElement);
    await flush();
    assert.equal(sent.length, 0, `placeholders went out unfilled: ${JSON.stringify(sent[0]?.body.text)}`);
  }
  // A word added to the text is an edit again.
  rtl.fireEvent.change(field(), { target: { value: `${PEDIDO_TEXT} ok` } });
  assert.equal(sendButton().disabled, false);
});

// The hold is read from the draft: the composer is mounted anew when a room is opened again, with the draft the
// room kept, and that draft is as much an unfilled template as it was before the room closed.
test('a kept draft that is still a template with its placeholders is held when its room is opened again', async () => {
  templates = [PEDIDO];
  renderComposer({ initial: PEDIDO_TEXT });
  await rtl.waitFor(() => assert.equal(composerStatus(), NEEDS_VARIABLES));
  assert.equal(sendButton().disabled, true);
  focusField();
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await flush();
  assert.equal(sent.length, 0, 'placeholders went out unfilled');

  // Text with braces that is no template of the session is the operator's own, and goes out.
  rtl.fireEvent.change(field(), { target: { value: 'write {{name}} where the name goes' } });
  assert.equal(composerStatus(), '');
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
});

test('an unfilled template is held as a caption too, and does not hold an audio file', async () => {
  templates = [PEDIDO];
  const { container } = renderComposer();
  await typeSlash('/pedido', /\/pedido/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(composerStatus(), NEEDS_VARIABLES));
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

  rtl.fireEvent.change(fileInput, {
    target: { files: [new window.File(['%PDF'], 'a.pdf', { type: 'application/pdf' })] },
  });
  await rtl.act(async () => heldReads[0]());
  assert.equal(composerStatus(), NEEDS_VARIABLES);
  assert.equal(sendButton().disabled, true);

  // Audio carries no text: the field keeps it, and the file goes out.
  rtl.fireEvent.change(fileInput, {
    target: { files: [new window.File(['OggS'], 'note.ogg', { type: 'audio/ogg' })] },
  });
  await rtl.act(async () => heldReads[1]());
  assert.equal(composerStatus(), '');
  rtl.fireEvent.click(sendButton());
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.match(sent[0].path, /\/messages\/send-audio$/);
  assert.equal(field().value, PEDIDO_TEXT);
  await rtl.waitFor(() => assert.equal(composerStatus(), NEEDS_VARIABLES));
});

test('a template stored with carriage returns is inserted as the field holds it', async () => {
  templates = [{ id: 'c', name: 'crlf', body: 'one\r\ntwo {name}' }];
  renderComposer();
  await typeSlash('/crlf', /\/crlf/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, 'one\ntwo {name}'));
  assert.equal(field().value.slice(field().selectionStart, field().selectionEnd), '{name}');
  assert.equal(composerStatus(), NEEDS_VARIABLES);
});

test('a held Enter key inserts a template once and does not send it', async () => {
  templates = [HOLA];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, '¡Hola!'));
  assert.equal(rtl.fireEvent.keyDown(field(), { key: 'Enter', repeat: true }), false, 'the repeat broke the line');
  await flush();
  assert.equal(sent.length, 0, 'the repeat sent what the first press inserted');
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
});

test('the Enter and the Escape of an input method neither act on the picker nor send', async () => {
  templates = [HOLA];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
  rtl.fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });
  rtl.fireEvent.keyDown(field(), { key: 'Escape', keyCode: 229 });
  await flush();
  assert.equal(field().value, '/hola', 'the Enter that commits a composition inserted the template');
  assert.equal(options().length, 1, 'the Escape that cancels a composition closed the picker');

  rtl.fireEvent.change(field(), { target: { value: 'こんにちは' } });
  rtl.fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
  await flush();
  assert.equal(sent.length, 0, 'the Enter that commits a composition sent the draft');
});

test('Tab does not take the highlighted template', async () => {
  templates = [HOLA];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  assert.equal(rtl.fireEvent.keyDown(field(), { key: 'Tab' }), true, 'Tab was captured');
  assert.equal(field().value, '/hola');
  assert.equal(sent.length, 0);
});

test('Escape dismisses the picker and keeps the draft', async () => {
  templates = [HOLA];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  assert.equal(rtl.fireEvent.keyDown(field(), { key: 'Escape' }), false, 'Escape was not taken');
  assert.equal(field().value, '/hola');
  await rtl.waitFor(() => assert.equal(count('.slash-template-picker'), 0));
  assert.deepEqual(semantics(), NO_LIST);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent[0]?.body.text, '/hola'));
});

test('a dismissed picker is closed for that draft only: another draft opens it, and so does that one typed again', async () => {
  templates = [HOLA];
  renderComposer();
  await typeSlash('/hol', /\/hola/);
  rtl.fireEvent.keyDown(field(), { key: 'Escape' });
  assert.equal(count('.slash-template-picker'), 0);
  rtl.fireEvent.change(field(), { target: { value: '/hola' } });
  assert.equal(options().length, 1, 'the next edit did not bring the picker back');
  rtl.fireEvent.change(field(), { target: { value: '/hol' } });
  assert.equal(options().length, 1, 'the draft it was once closed for never offers the list again');
});

test('a template whose text is one slash word is inserted once and then sent', async () => {
  templates = [{ id: '1', name: 'start', body: '/start' }];
  renderComposer();
  await typeSlash('/sta', /\/start/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, '/start'));
  assert.equal(count('.slash-template-picker'), 0, 'the inserted text opened the picker again');
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].body.text, '/start');

  // Typed in full, the draft already is the template's text: Enter resolves it, and the next one sends.
  await typeSlash('/start', /\/start/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(count('.slash-template-picker'), 0));
  assert.equal(sent.length, 1);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 2));
  assert.equal(sent[1].body.text, '/start');
});

test('Escape closes the emoji panel first and leaves the picker for the next press', async () => {
  templates = [HOLA];
  renderComposer();
  await typeSlash('/hola', /\/hola/);
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Pick emoji' }));
  assert.equal(count('.chats-emoji-picker'), 1);
  rtl.fireEvent.keyDown(field(), { key: 'Escape' });
  assert.equal(count('.chats-emoji-picker'), 0);
  assert.equal(options().length, 1, 'one Escape closed the emoji panel and the picker');
  rtl.fireEvent.keyDown(field(), { key: 'Escape' });
  assert.equal(count('.slash-template-picker'), 0);
});

test('a slash draft is resolved while an earlier message is still being sent, and sent once that one is', async () => {
  templates = [HOLA];
  holdSends = true;
  renderComposer();
  focusField();
  rtl.fireEvent.change(field(), { target: { value: 'first' } });
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(heldSends.length, 1));

  await typeSlash('/hola', /\/hola/);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, '¡Hola!'));
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await flush();
  assert.equal(sent.length, 1, 'a second message went out beside the one in flight');
  assert.equal(field().value, '¡Hola!');

  await rtl.act(async () => heldSends.shift()?.());
  await rtl.waitFor(() => assert.equal(sendButton().disabled, false));
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 2));
  assert.equal(sent[1].body.text, '¡Hola!');
});

test('a draft goes out without the blank space around it, and one of line breaks alone does not go out', async () => {
  renderComposer();
  focusField();
  rtl.fireEvent.change(field(), { target: { value: '\n\n \n' } });
  assert.equal(sendButton().disabled, true);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await flush();
  assert.equal(sent.length, 0);

  rtl.fireEvent.change(field(), { target: { value: '\n  two\nlines \n\n' } });
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0].body.text, 'two\nlines');
});

test('while the list is loading a slash draft waits, and Enter acts on the list once it is there', async () => {
  templatesMode = 'held';
  rtl.render(wrap(createElement(Harness)));
  focusField();
  rtl.fireEvent.change(field(), { target: { value: '/hola' } });
  await rtl.waitFor(() => assert.equal(pickerStatus(), 'Loading templates… Enter waits for them.'));
  assert.deepEqual(semantics(), NO_LIST);
  assert.equal(count('.slash-template-hint'), 0);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await flush();
  assert.equal(sent.length, 0, 'the draft went out before anyone knew whether it names a template');
  assert.equal(field().value, '/hola');

  // The Send button waits as well, and hands the focus to the field, where the picker says why.
  rtl.act(() => sendButton().focus());
  rtl.fireEvent.click(sendButton());
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(fieldFocused(), true);
  assert.equal(pickerStatus(), 'Loading templates… Enter waits for them.');

  await rtl.act(async () => releaseTemplates([HOLA]));
  await rtl.screen.findByRole('option', { name: /\/hola/ });
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(field().value, '¡Hola!'));
  assert.equal(sent.length, 0);
});

test('a slash draft whose picker was dismissed is sent as typed while the list is still loading', async () => {
  templatesMode = 'hang';
  rtl.render(wrap(createElement(Harness)));
  focusField();
  rtl.fireEvent.change(field(), { target: { value: '/start' } });
  await rtl.waitFor(() => assert.equal(pickerStatus(), 'Loading templates… Enter waits for them.'));
  rtl.fireEvent.keyDown(field(), { key: 'Escape' });
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent[0]?.body.text, '/start'));
});

test('a list that failed to load sends the draft', async () => {
  templatesMode = 'fail';
  rtl.render(wrap(createElement(Harness)));
  focusField();
  rtl.fireEvent.change(field(), { target: { value: '/menu' } });
  await rtl.waitFor(() => assert.equal(pickerStatus(), 'Templates could not be loaded'));
  assert.deepEqual(semantics(), NO_LIST);
  rtl.fireEvent.keyDown(field(), { key: 'Enter' });
  await rtl.waitFor(() => assert.equal(sent[0]?.body.text, '/menu'));
});

test('a ninth match is not listed, and a line says that more match', async () => {
  templates = Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: `promo${i}`, body: `promo ${i}` }));
  renderComposer();
  await typeSlash('/promo', /\/promo0/);
  assert.equal(options().length, 8);
  assert.equal(
    document.querySelector('.slash-template-more')?.textContent,
    'More templates match. Keep typing to narrow the list.',
  );
  rtl.act(() => {
    queryClient.setQueryData(['sessions', 'sess-1', 'templates'], templates.slice(0, 8));
  });
  await rtl.waitFor(() => assert.equal(count('.slash-template-more'), 0, 'eight matches are all listed'));
  assert.equal(options().length, 8);
});

test('a viewer gets no template picker', async () => {
  templates = [HOLA];
  renderComposer({ initial: '/hola' }, false);
  assert.equal(count('.slash-template-picker'), 0);
  assert.deepEqual(semantics(), NO_LIST);
  assert.equal(field().value, '/hola');
});

test('a staged attachment hides the template picker, and the field stops offering /template', async () => {
  templates = [HOLA];
  const { container } = renderComposer();
  assert.equal(field().placeholder, 'Message or /template…');
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  rtl.fireEvent.change(fileInput, {
    target: { files: [new window.File(['%PDF'], 'a.pdf', { type: 'application/pdf' })] },
  });
  await rtl.act(async () => heldReads[0]());
  focusField();
  rtl.fireEvent.change(field(), { target: { value: '/hola' } });
  await flush();
  assert.equal(count('.slash-template-picker'), 0, 'the picker opened beside a staged file');
  assert.deepEqual(semantics(), NO_LIST);
  assert.equal(field().placeholder, 'Add a caption...');

  // Audio takes no caption, so the field keeps its message placeholder: the plain one, the picker being off.
  rtl.fireEvent.change(fileInput, {
    target: { files: [new window.File(['OggS'], 'note.ogg', { type: 'audio/ogg' })] },
  });
  await rtl.act(async () => heldReads[1]());
  assert.equal(field().placeholder, 'Type a message...');
});

test('a field mounted on a kept draft has its caret after the text, and takes no focus for it', () => {
  renderComposer({ initial: 'kept draft' });
  assert.equal(field().selectionStart, 'kept draft'.length);
  assert.equal(field().selectionEnd, 'kept draft'.length);
  assert.equal(fieldFocused(), false);
});

test('the field is as tall as its draft, and is measured again when its width changes', () => {
  const proto = window.HTMLTextAreaElement.prototype;
  let contentHeight = 44;
  let width = 300;
  const observers: Array<{ report: () => void; targets: Element[]; live: boolean }> = [];
  class Observer {
    private readonly entry: (typeof observers)[number];
    constructor(callback: () => void) {
      this.entry = { report: callback, targets: [], live: true };
      observers.push(this.entry);
    }
    observe(target: Element): void {
      this.entry.targets.push(target);
    }
    disconnect(): void {
      this.entry.live = false;
    }
  }
  // What the pill around the field is held at while the field is read, for each read.
  const pillHeldAt: string[] = [];
  const pillProto = window.HTMLDivElement.prototype;
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      pillHeldAt.push(`${this.style.height} in ${this.parentElement?.style.minHeight}`);
      return contentHeight;
    },
  });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(pillProto, 'offsetHeight', { configurable: true, get: () => 86 });
  (globalThis as Record<string, unknown>).ResizeObserver = Observer;
  try {
    renderComposer();
    assert.equal(field().style.height, '44px');
    contentHeight = 84;
    rtl.fireEvent.change(field(), { target: { value: 'one\ntwo\nthree' } });
    assert.equal(field().style.height, '84px');
    // The field is one line high while it is measured. The pill keeps its height for that moment, or the thread
    // above the composer would be laid out taller, and clamped off its bottom, on every key.
    assert.equal(pillHeldAt.at(-1), 'auto in 86px');
    assert.equal(field().parentElement?.style.minHeight, '', 'the pill kept the height it was held at');

    const box = field();
    const watching = observers.filter(observer => observer.live && observer.targets.includes(box));
    assert.equal(watching.length, 1, 'nothing watches the width of the field');
    // The field's own new height is reported too: with the width as it was, nothing is measured.
    contentHeight = 104;
    watching[0].report();
    assert.equal(field().style.height, '84px');
    width = 200;
    watching[0].report();
    assert.equal(field().style.height, '104px');
    rtl.cleanup();
    assert.equal(watching[0].live, false, 'the observer outlived the field');
  } finally {
    Reflect.deleteProperty(proto, 'scrollHeight');
    Reflect.deleteProperty(proto, 'clientWidth');
    Reflect.deleteProperty(pillProto, 'offsetHeight');
    Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});

test('sending an inserted template keeps the reply quote', async () => {
  templates = [HOLA];
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
  assert.equal(count('.replying-preview-banner'), 0, 'the quote stayed after send');
});
