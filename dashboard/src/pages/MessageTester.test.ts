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
let textReads = 0;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  // The only request the page makes on mount is the session list; none of it matters here.
  globalThis.fetch = ((): Promise<Response> =>
    Promise.resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))) as typeof fetch;
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
});

afterEach(() => {
  rtl.cleanup();
  textReads = 0;
});

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
