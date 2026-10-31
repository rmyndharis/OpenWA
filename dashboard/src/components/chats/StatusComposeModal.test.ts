// An image status is posted as base64 JSON, so a file past the upload cap is refused only after the whole
// inflated body went up. The picker rejects it before reading, like the chat composer does.
import '../../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let render: (engineType?: string) => ReturnType<typeof import('@testing-library/react').render>;
let queryClient: import('@tanstack/react-query').QueryClient;

let reads = 0;
// While set, a read starts but never finishes, standing in for a large file still being read.
let holdReads = false;
// Reads count, then finish on the next microtask with a data URL carrying the file's type.
class CountingFileReader {
  onload: ((event: { target: { result: string } }) => void) | null = null;
  readAsDataURL(file: Blob): void {
    reads += 1;
    if (holdReads) return;
    queueMicrotask(() => this.onload?.({ target: { result: `data:${file.type};base64,eA==` } }));
  }
}

// Bodies the modal posted, in order.
const posted: unknown[] = [];
// Contact-list reads, each answered with a 429.
let contactReads = 0;
// While set, a contact read is answered with an empty list, so a test that only looks at the form leaves no retry
// or request timer behind.
let emptyContacts = false;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).FileReader = CountingFileReader;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/contacts')) {
      contactReads += 1;
      if (emptyContacts)
        return Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
      return Promise.resolve(
        new Response(JSON.stringify({ statusCode: 429, message: 'Too Many Requests' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    posted.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'status-1' }), { headers: { 'Content-Type': 'application/json' } }),
    );
  }) as typeof fetch;
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ToastProvider } = await import('../Toast.tsx');
  const { RoleContext } = await import('../../hooks/useRole.tsx');
  const { default: StatusComposeModal } = await import('./StatusComposeModal.tsx');
  queryClient = new QueryClient();
  const role = (engineType: string) => ({
    role: 'operator' as const,
    setRole: () => undefined,
    isAdmin: false,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType,
    setEngineType: () => undefined,
    scoped: false,
    setScoped: () => undefined,
  });
  render = (engineType = 'whatsapp-web.js') =>
    rtl.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          RoleContext.Provider,
          { value: role(engineType) },
          createElement(
            ToastProvider,
            null,
            createElement(StatusComposeModal, { sessionId: 's1', onClose: () => undefined, onPosted: () => undefined }),
          ),
        ),
      ),
    );
});

afterEach(() => {
  rtl.cleanup();
  reads = 0;
  holdReads = false;
  posted.length = 0;
  contactReads = 0;
  emptyContacts = false;
  queryClient.clear();
});

after(() => {
  rtl.cleanup();
  // Drops the unmounted query's five-minute garbage-collection timer, which would hold the runner open.
  queryClient.clear();
});

test('an image past the upload cap is refused before it is read', async () => {
  const { screen, fireEvent } = rtl;
  render();
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  const file = new window.File(['x'], 'huge.jpg', { type: 'image/jpeg' });
  Object.defineProperty(file, 'size', { value: 18 * 1024 * 1024 + 1 });
  fireEvent.change(screen.getByLabelText('Status image'), { target: { files: [file] } });

  await screen.findByText('File is too large (max 18 MB)');
  assert.equal(reads, 0, 'the oversized file was read');
});

test('an oversized pick also drops the earlier pick it was meant to replace', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  render();
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  const input = screen.getByLabelText('Status image');
  fireEvent.change(input, { target: { files: [new window.File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
  const post = screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(post.disabled, false));

  const huge = new window.File(['x'], 'huge.jpg', { type: 'image/jpeg' });
  Object.defineProperty(huge, 'size', { value: 18 * 1024 * 1024 + 1 });
  fireEvent.change(input, { target: { files: [huge] } });
  await screen.findByText('File is too large (max 18 MB)');
  // The input now reads "No file chosen", so nothing on screen shows the earlier image any more.
  assert.equal(post.disabled, true, 'the hidden earlier pick can still be posted');
});

test('a new pick still being read holds Post instead of sending the image it replaced', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  render();
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  const input = screen.getByLabelText('Status image');
  fireEvent.change(input, { target: { files: [new window.File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
  const post = screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(post.disabled, false));

  holdReads = true;
  fireEvent.change(input, { target: { files: [new window.File(['x'], 'b.png', { type: 'image/png' })] } });
  assert.equal(post.disabled, true, 'the replaced image can still be posted');
});

test('a picked image is posted with its own type', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  render();
  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  fireEvent.change(screen.getByLabelText('Status image'), {
    target: { files: [new window.File(['x'], 'chart.png', { type: 'image/png' })] },
  });
  const post = screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement;
  await waitFor(() => assert.equal(post.disabled, false));
  fireEvent.click(post);

  await waitFor(() => assert.equal(posted.length, 1));
  assert.deepEqual((posted[0] as { image: unknown }).image, {
    base64: 'data:image/png;base64,eA==',
    mimetype: 'image/png',
  });
});

test('a contact list that stays throttled reads as a failure, not an empty address book', async () => {
  const { screen } = rtl;
  render('baileys');

  // Two throttle retries wait one and then two seconds; a further query retry would page through again.
  await screen.findByText('Failed to load data', undefined, { timeout: 6000 });
  assert.equal(screen.queryByText('No contacts found') === null, true);
  assert.equal(contactReads, 3);
});

// A native maxlength counts a surrogate pair as two and cuts pasted text the gateway would accept, so
// Post alone holds an over-limit field, counting characters the way the gateway does.
test('status text and caption are bounded by Post, not truncated by UTF-16 units', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  render();
  const post = screen.getByRole('button', { name: 'Post' }) as HTMLButtonElement;
  const text = document.getElementById('scm-1') as HTMLTextAreaElement;
  assert.equal(text.hasAttribute('maxlength'), false);
  fireEvent.change(text, { target: { value: '\u{1F600}'.repeat(4096) } });
  assert.equal(post.disabled, false, 'text the gateway accepts is held');
  assert.equal(screen.queryByText('Limited to 4096 characters (4096 now).'), null);
  // A live region mounted together with its text is often not announced, so each hint fills one already there.
  let regions = screen.queryAllByRole('status');
  fireEvent.change(text, { target: { value: '\u{1F600}'.repeat(4097) } });
  assert.equal(post.disabled, true, 'text over 4096 characters can be posted');
  assert.ok(regions.includes(screen.getByText('Limited to 4096 characters (4097 now).')));

  fireEvent.click(screen.getByRole('button', { name: 'Image' }));
  fireEvent.change(screen.getByLabelText('Status image'), {
    target: { files: [new window.File(['x'], 'a.jpg', { type: 'image/jpeg' })] },
  });
  await waitFor(() => assert.equal(post.disabled, false));
  const caption = document.getElementById('scm-5') as HTMLInputElement;
  assert.equal(caption.hasAttribute('maxlength'), false);
  fireEvent.change(caption, { target: { value: '\u{1F600}'.repeat(1024) } });
  assert.equal(post.disabled, false, 'a caption the gateway accepts is held');
  regions = screen.queryAllByRole('status');
  fireEvent.change(caption, { target: { value: '\u{1F600}'.repeat(1025) } });
  assert.equal(post.disabled, true, 'a caption over 1024 characters can be posted');
  assert.ok(regions.includes(screen.getByText('Limited to 1024 characters (1025 now).')));
});

// The recipient search matches a number against the ASCII digits of a contact, whatever script it is typed in.
test('a number typed in native digits finds a recipient by its number', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  const stubbed = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify([
          { id: '628123456789@c.us', name: 'Ben', number: '628123456789', isMyContact: true, isBlocked: false },
          { id: '491701234567@c.us', name: 'Anna', number: '491701234567', isMyContact: true, isBlocked: false },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    )) as typeof fetch;
  try {
    render('baileys');
    await screen.findByText('Anna');
    const search = document.getElementById('scm-6') as HTMLInputElement;
    fireEvent.change(search, { target: { value: '٦٢٨١٢٣' } });
    await waitFor(() => assert.equal(screen.queryByText('Anna'), null));
    assert.ok(screen.getByText('Ben'));
  } finally {
    globalThis.fetch = stubbed;
  }
});

// The ids are the protocol's FontType enum; the picker names them as the protocol does instead of showing bare numbers.
const fontOptions = () =>
  [...(document.getElementById('scm-3') as HTMLSelectElement).options].map(o => [o.value, o.textContent]);

test('the font picker names every id after the protocol, on Baileys', async () => {
  emptyContacts = true;
  render('baileys');
  // Let the contact read land first: an answer arriving after the next test's cache clear leaves a timer behind.
  await rtl.screen.findByText('No contacts found');
  assert.deepEqual(fontOptions(), [
    ['', 'Default'],
    ['0', 'System'],
    ['1', 'System text'],
    ['2', 'Script'],
    ['6', 'Bold'],
    ['7', 'Morning Breeze'],
    ['8', 'Calistoga'],
    ['9', 'Exo 2'],
    ['10', 'Courier Prime'],
  ]);
});

test('whatsapp-web.js is not offered the ids it posts in the default font', () => {
  render('whatsapp-web.js');
  assert.deepEqual(
    fontOptions().map(([value]) => value),
    ['', '0', '1', '2', '6', '7'],
  );
});

test('a picked font is posted under its own id', async () => {
  const { screen, fireEvent, waitFor } = rtl;
  render();
  fireEvent.change(document.getElementById('scm-1') as HTMLTextAreaElement, { target: { value: 'hello' } });
  fireEvent.change(document.getElementById('scm-3') as HTMLSelectElement, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Post' }));
  await waitFor(() => assert.equal(posted.length, 1));
  assert.equal((posted[0] as { font?: number }).font, 2);
});

// Text or Image is a choice between two toggle buttons; which one is chosen is exposed, not only drawn.
test('the status kind toggle says which kind is chosen', () => {
  const { screen, fireEvent } = rtl;
  render();
  const text = screen.getByRole('button', { name: 'Text' });
  const image = screen.getByRole('button', { name: 'Image' });
  assert.equal(text.getAttribute('aria-pressed'), 'true', 'the chosen kind is not exposed as pressed');
  assert.equal(image.getAttribute('aria-pressed'), 'false');
  fireEvent.click(image);
  assert.equal(image.getAttribute('aria-pressed'), 'true');
  assert.equal(text.getAttribute('aria-pressed'), 'false');
});
