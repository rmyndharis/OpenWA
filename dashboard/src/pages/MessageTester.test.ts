// Render test for the Message Tester's bulk recipients file picker, on the Logs.test.ts harness
// (jsdom loader hooks, providers, a fetch stub). The picker refuses an oversized file BEFORE reading
// it: FileReader would otherwise materialize a mistaken multi-hundred-MB pick as one JS string.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let MessageTester: typeof import('./MessageTester.tsx').MessageTester;
let RoleProvider: typeof import('../components/RoleProvider.tsx').RoleProvider;
let maxBytes: number;
let inlineMediaBudgetBytes: (recipientCount: number) => number;
let textReads = 0;
let emptyFetch: typeof fetch;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // The only request the page makes on mount is the session list; none of it matters here.
  emptyFetch = ((): Promise<Response> =>
    Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))) as typeof fetch;
  globalThis.fetch = emptyFetch;
  // Count reads at the source: the page names the global FileReader when it reads a pick.
  const Reader = globalThis.FileReader;
  globalThis.FileReader = class extends Reader {
    readAsText(blob: Blob, encoding?: string): void {
      textReads += 1;
      super.readAsText(blob, encoding);
    }
  };
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ MessageTester } = await import('./MessageTester.tsx'));
  ({ BULK_RECIPIENTS_FILE_MAX_BYTES: maxBytes } = await import('../utils/bulkRecipients.ts'));
  ({ inlineMediaBudgetBytes } = await import('../utils/bulkMedia.ts'));
});

afterEach(() => {
  rtl.cleanup();
  textReads = 0;
  globalThis.fetch = emptyFetch;
  window.localStorage.removeItem('openwa_user_role');
});

interface BulkItem {
  chatId: string;
  type: string;
  content: { caption?: string; image?: { base64?: string; mimetype?: string } };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubGateway(): { bulkBodies: { messages: BulkItem[] }[] } {
  const bulkBodies: { messages: BulkItem[] }[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/sessions')) {
      return Promise.resolve(jsonResponse([{ id: 's1', name: 'Main', status: 'ready', phone: '15550000000' }]));
    }
    if (url.endsWith('/messages/send-bulk')) {
      const body = JSON.parse(String(init?.body)) as { messages: BulkItem[] };
      bulkBodies.push(body);
      return Promise.resolve(
        jsonResponse({ batchId: 'b1', status: 'pending', totalMessages: body.messages.length }, 202),
      );
    }
    if (url.includes('/messages/batch/')) {
      return Promise.resolve(
        jsonResponse({
          batchId: 'b1',
          status: 'completed',
          progress: { total: 0, sent: 0, failed: 0, pending: 0, cancelled: 0 },
          results: [],
        }),
      );
    }
    return Promise.resolve(jsonResponse([]));
  }) as typeof fetch;
  return { bulkBodies };
}

async function renderBulkAsWriter(): Promise<HTMLElement> {
  window.localStorage.setItem('openwa_user_role', 'admin');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(QueryClientProvider, { client }, createElement(RoleProvider, null, createElement(MessageTester))),
  );
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Bulk' }));
  await rtl.screen.findByRole('option', { name: /Main/ });
  return container;
}

function field(container: HTMLElement, selector: string): HTMLInputElement | HTMLTextAreaElement {
  const element = container.querySelector(selector);
  assert.ok(element, `expected ${selector}`);
  return element as HTMLInputElement | HTMLTextAreaElement;
}

function type(container: HTMLElement, selector: string, value: string): void {
  rtl.fireEvent.change(field(container, selector), { target: { value } });
}

function pickMedia(container: HTMLElement, file: File): void {
  rtl.fireEvent.change(field(container, 'input[type="file"][accept="*/*"]'), { target: { files: [file] } });
}

function sendButton(): HTMLButtonElement {
  return rtl.screen.getByRole('button', { name: 'Send Message' }) as HTMLButtonElement;
}

/** Render the page, switch to Bulk, and pick a recipients file of `size` bytes. */
async function pickRecipientsFile(size: number): Promise<{ container: HTMLElement }> {
  const { screen, fireEvent } = rtl;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(QueryClientProvider, { client }, createElement(RoleProvider, null, createElement(MessageTester))),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Bulk' }));
  const input = container.querySelector('input[type="file"][accept=".txt,.csv"]');
  assert.ok(input, 'expected the recipients file input');
  // jsdom's File, not Node's: jsdom's FileReader only reads its own Blob implementation.
  const file = new window.File(['6'.repeat(size)], 'recipients.txt', { type: 'text/plain' });
  fireEvent.change(input, { target: { files: [file] } });
  return { container };
}

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  window.localStorage.removeItem('openwa_user_role');
});

function groupJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubGroupGateway(groups: { id: string; name?: string }[], refuseFirstWith?: number): { textSends: string[] } {
  const previousFetch = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = previousFetch;
  };
  const textSends: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/sessions')) {
      return Promise.resolve(groupJsonResponse([{ id: 's1', name: 'Main', status: 'ready', phone: '15550000000' }]));
    }
    if (url.endsWith('/sessions/s1/groups')) return Promise.resolve(groupJsonResponse(groups));
    if (url.endsWith('/messages/send-text')) {
      const { chatId } = JSON.parse(String(init?.body)) as { chatId: string };
      textSends.push(chatId);
      if (refuseFirstWith && textSends.length === 1) {
        return Promise.resolve(groupJsonResponse({ message: 'Too many requests' }, refuseFirstWith));
      }
      return Promise.resolve(groupJsonResponse({ messageId: `m${textSends.length}`, timestamp: 1 }, 201));
    }
    return Promise.resolve(groupJsonResponse([]));
  }) as typeof fetch;
  return { textSends };
}

async function renderGroupsAsWriter(): Promise<void> {
  window.localStorage.setItem('openwa_user_role', 'admin');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  rtl.render(
    createElement(QueryClientProvider, { client }, createElement(RoleProvider, null, createElement(MessageTester))),
  );
  await rtl.screen.findByRole('option', { name: /Main/ });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Group' }));
}

function sendMessageButton(): HTMLButtonElement {
  return rtl.screen.getByRole('button', { name: 'Send Message' }) as HTMLButtonElement;
}

async function sendTextToAllGroups(): Promise<void> {
  await rtl.screen.findByRole('checkbox', { name: 'Work' });
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Select all' }));
  rtl.fireEvent.change(rtl.screen.getByPlaceholderText('Enter your message here...'), { target: { value: 'hi' } });
  await rtl.waitFor(() => assert.equal(sendMessageButton().disabled, false));
  rtl.fireEvent.click(sendMessageButton());
}

test('a group without a name is listed by its id', async () => {
  stubGroupGateway([{ id: 'nameless@g.us' }, { id: 'g2@g.us', name: 'Work' }]);
  await renderGroupsAsWriter();

  await rtl.screen.findByRole('checkbox', { name: 'nameless@g.us' });
  assert.ok(rtl.screen.getByRole('checkbox', { name: 'Work' }));
});

test('cancelling a group send stops the groups still waiting', async () => {
  const gateway = stubGroupGateway([
    { id: 'g1@g.us', name: 'Family' },
    { id: 'g2@g.us', name: 'Work' },
  ]);
  await renderGroupsAsWriter();
  await sendTextToAllGroups();

  await rtl.waitFor(() => assert.equal(gateway.textSends.length, 1));
  // The run sends what was on screen when it started, so the composer is locked while it runs.
  assert.equal(window.document.getElementById('mt-2')?.matches(':disabled'), true);
  rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Cancel' }));

  await rtl.screen.findByText('1, cancelled');
  assert.deepEqual(gateway.textSends, ['g1@g.us']);
  assert.ok(rtl.screen.getByText('1/2 sent'));
  // One of two groups sent is not a success.
  assert.ok(rtl.screen.getByText('Failed'));
  assert.equal(rtl.screen.queryByText('Success'), null);
  assert.equal(window.document.getElementById('mt-2')?.matches(':disabled'), false);
});

test('a 429 from the gateway stops the run instead of trying the rest', async () => {
  const gateway = stubGroupGateway(
    [
      { id: 'g1@g.us', name: 'Family' },
      { id: 'g2@g.us', name: 'Work' },
    ],
    429,
  );
  await renderGroupsAsWriter();
  await sendTextToAllGroups();

  await rtl.screen.findByText('1, stopped after HTTP 429');
  assert.deepEqual(gateway.textSends, ['g1@g.us']);
  assert.ok(rtl.screen.getByText('Failed'));
});

test('a recipients file over the cap is refused without being read', async () => {
  const { container } = await pickRecipientsFile(maxBytes + 1);

  await rtl.screen.findByText('The recipients file is too large (max 2 MB)');
  assert.equal(textReads, 0);
  assert.equal((container.querySelector('#mt-11') as HTMLTextAreaElement).value, '');
});

test('a recipients file at the cap is read into the recipients box', async () => {
  const { container } = await pickRecipientsFile(maxBytes);

  const box = container.querySelector('#mt-11') as HTMLTextAreaElement;
  await rtl.waitFor(() => assert.equal(box.value.length, maxBytes));
  assert.equal(textReads, 1);
  assert.equal(
    rtl.screen.queryByText('The recipients file is too large (max 2 MB)') === null,
    true,
    'at-cap file refused',
  );
});

test('a bulk send with a picked image carries it in every item', async () => {
  const gateway = stubGateway();
  const container = await renderBulkAsWriter();
  type(container, '#mt-11', '15550000001\n15550000002');
  pickMedia(container, new window.File([new Uint8Array(32)], 'promo.png', { type: 'image/png' }));
  await rtl.screen.findByText('promo.png');
  await rtl.waitFor(() => assert.equal(sendButton().disabled, false));

  rtl.fireEvent.click(sendButton());

  await rtl.waitFor(() => assert.equal(gateway.bulkBodies.length, 1));
  const { messages } = gateway.bulkBodies[0];
  assert.deepEqual(
    messages.map(item => item.chatId),
    ['15550000001@c.us', '15550000002@c.us'],
  );
  for (const item of messages) {
    assert.equal(item.type, 'image');
    assert.equal(item.content.image?.mimetype, 'image/png');
    assert.ok(item.content.image?.base64, 'expected the file inline');
  }
});

test('an inline file too large for the recipient count keeps Send disabled', async () => {
  stubGateway();
  const container = await renderBulkAsWriter();
  const recipients = Array.from({ length: 100 }, (_, index) => String(15550000100 + index)).join('\n');
  type(container, '#mt-11', recipients);
  const size = inlineMediaBudgetBytes(100) + 3 * 1024;
  pickMedia(container, new window.File([new Uint8Array(size)], 'catalog.pdf', { type: 'application/pdf' }));

  await rtl.screen.findByText(/too large to send inline to 100 recipients/);
  assert.equal(sendButton().disabled, true);

  type(container, '#mt-11', '15550000100');
  await rtl.waitFor(() => assert.equal(sendButton().disabled, false));
});

test('a media URL without http(s) keeps Send disabled', async () => {
  stubGateway();
  const container = await renderBulkAsWriter();
  type(container, '#mt-11', '15550000001');
  // With text present the form is otherwise valid, so only the URL guard can hold Send.
  type(container, '#mt-12', 'Price list attached');
  type(container, '#mt-3', 'https:/cdn.example.com/pricelist.pdf');

  await rtl.screen.findByText('Use a full http:// or https:// address, like https://example.com/file.pdf.');
  assert.equal(sendButton().disabled, true);

  type(container, '#mt-3', 'https://cdn.example.com/pricelist.pdf');
  await rtl.waitFor(() => assert.equal(sendButton().disabled, false));
});

test('attaching a file holds the message to the caption limit', async () => {
  stubGateway();
  const container = await renderBulkAsWriter();
  type(container, '#mt-11', '15550000001');
  type(container, '#mt-12', 'x'.repeat(1025));
  await rtl.waitFor(() => assert.equal(sendButton().disabled, false));

  type(container, '#mt-3', 'https://cdn.example.com/logo.png');

  await rtl.screen.findByText(/limited to 1024 characters \(1025 now\)/);
  assert.equal(sendButton().disabled, true);
});

test('text next to an audio attachment keeps Send disabled, since audio carries no caption', async () => {
  stubGateway();
  const container = await renderBulkAsWriter();
  type(container, '#mt-11', '15550000001');
  type(container, '#mt-3', 'https://cdn.example.com/jingle.mp3');
  await rtl.waitFor(() => assert.equal(sendButton().disabled, false));

  type(container, '#mt-12', 'Listen to our new jingle');

  await rtl.screen.findByText(/Audio goes out without a caption/);
  assert.equal(sendButton().disabled, true);
});

test('a media file that cannot be read is reported and not attached', async () => {
  stubGateway();
  const readAsDataURL = globalThis.FileReader.prototype.readAsDataURL;
  globalThis.FileReader.prototype.readAsDataURL = function (this: FileReader): void {
    queueMicrotask(() => this.onerror?.(new window.ProgressEvent('error') as ProgressEvent<FileReader>));
  };
  try {
    const container = await renderBulkAsWriter();
    pickMedia(container, new window.File(['x'], 'broken.png', { type: 'image/png' }));

    await rtl.screen.findByText('File read failed');
    assert.equal(rtl.screen.queryByText('broken.png'), null);
  } finally {
    globalThis.FileReader.prototype.readAsDataURL = readAsDataURL;
  }
});
