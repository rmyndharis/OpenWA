import '../../test-helpers/register-hooks.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

type RTL = typeof import('@testing-library/react');
let rtl: RTL;
let PdfPreviewPane: typeof import('./PdfPreviewPane.tsx').default;

let ChatThread: typeof import('./ChatThread.tsx').default;
let RoleProvider: typeof import('../RoleProvider.tsx').RoleProvider;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ default: PdfPreviewPane } = await import('./PdfPreviewPane.tsx'));
  ({ default: ChatThread } = await import('./ChatThread.tsx'));
  ({ RoleProvider } = await import('../RoleProvider.tsx'));
});

test('PdfPreviewPane renders title, size, iframe and controls', () => {
  let closed = false;
  const { container } = rtl.render(
    createElement(PdfPreviewPane, {
      preview: {
        url: 'blob:http://localhost/sample.pdf',
        filename: 'Invoice-2026.pdf',
        sizeBytes: 1024 * 1024 * 1.5,
      },
      onClose: () => {
        closed = true;
      },
    }),
  );

  const title = container.querySelector('.pdf-preview-filename');
  assert.ok(title);
  assert.equal(title.textContent, 'Invoice-2026.pdf');

  const size = container.querySelector('.pdf-preview-size');
  assert.ok(size);
  assert.equal(size.textContent, '1.5 MB');

  const iframe = container.querySelector('iframe.pdf-preview-frame');
  assert.ok(iframe);
  assert.equal(iframe.getAttribute('src'), 'blob:http://localhost/sample.pdf#toolbar=1&navpanes=0');

  // Maximize toggle
  const maximizeBtn = container.querySelector('button[aria-label="Maximize"]');
  assert.ok(maximizeBtn);
  rtl.fireEvent.click(maximizeBtn);

  const panel = container.querySelector('.pdf-preview-panel.maximized');
  assert.ok(panel, 'panel did not enter maximized mode');
  const backdrop = container.querySelector('.pdf-modal-backdrop');
  assert.ok(backdrop, 'backdrop did not render in maximized mode');

  // Close button
  const closeBtn = container.querySelector('button.close-btn');
  assert.ok(closeBtn);
  rtl.fireEvent.click(closeBtn);
  assert.equal(closed, true);
});

test('PdfPreviewPane closes on Escape key', () => {
  let closed = false;
  rtl.render(
    createElement(PdfPreviewPane, {
      preview: {
        url: 'blob:http://localhost/doc.pdf',
        filename: 'doc.pdf',
      },
      onClose: () => {
        closed = true;
      },
    }),
  );

  rtl.fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(closed, true);
});

test('ChatThread calls onOpenPdf when clicking a loaded PDF document card', () => {
  window.sessionStorage.setItem('openwa_user_role', 'operator');
  let openedPdf: { url: string; filename: string; sizeBytes?: number } | null = null;
  const noop = () => {};
  const containerRef = { current: null };

  const message = {
    id: 'msg-doc-1',
    waMessageId: 'wamid.doc-1',
    timestamp: 1700000000,
    from: '12345@c.us',
    fromMe: false,
    to: 'me',
    body: '',
    type: 'document' as const,
    status: 'delivered' as const,
    ack: 2,
    hasMedia: true,
    metadata: {
      media: {
        mimetype: 'application/pdf',
        filename: 'contract.pdf',
        data: 'https://example.com/contract.pdf',
        sizeBytes: 1024 * 500,
      },
    },
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z',
  };

  const { container } = rtl.render(
    createElement(
      RoleProvider,
      null,
      createElement(ChatThread, {
        sessionId: 'session-1',
        activeChat: { id: '12345@c.us', name: 'Alice', isGroup: false } as any,
        messages: [message],
        loadingMessages: false,
        messagesError: false,
        messagesContainerRef: containerRef,
        hasMoreMessages: false,
        loadingOlderMessages: false,
        onLoadOlderMessages: noop,
        onMediaLoad: noop,
        measureMedia: noop,
        onOpenImage: noop,
        onOpenPdf: pdf => {
          openedPdf = pdf;
        },
        onReply: noop,
        onReact: noop,
        onDelete: noop,
        onClickButton: async () => {},
      }),
    ),
  );

  const docLink = container.querySelector<HTMLAnchorElement>('a.chat-document-media');
  assert.ok(docLink, 'PDF document card link not rendered');

  // Verify preview cover elements
  const previewCover = docLink.querySelector('.chat-document-preview-cover');
  assert.ok(previewCover, 'preview cover watermark not rendered');
  const previewTag = docLink.querySelector('.chat-document-preview-hover-tag');
  assert.ok(previewTag, 'hover preview tag not rendered');

  // Click card
  rtl.fireEvent.click(docLink);
  assert.ok(openedPdf, 'onOpenPdf callback was not triggered');
  assert.equal((openedPdf as any).filename, 'contract.pdf');
  assert.equal((openedPdf as any).url, 'https://example.com/contract.pdf');
  assert.equal((openedPdf as any).sizeBytes, 1024 * 500);
});
