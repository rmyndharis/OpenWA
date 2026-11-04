// Render test for the archive-only media preview: an `{ omitted: true, archived: true }` marker must
// still show its image/video/audio inline (fetched from the media route), release the object URL it
// made, and fall back to the download button when the bytes cannot be fetched.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let ArchivedMediaPreview: typeof import('./ArchivedMediaPreview.tsx').default;

const created: string[] = [];
const revoked: string[] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ default: ArchivedMediaPreview } = await import('./ArchivedMediaPreview.tsx'));
  // jsdom implements neither.
  URL.createObjectURL = (): string => {
    const url = `blob:mock-${created.length}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => void revoked.push(url);
});

afterEach(() => {
  rtl.cleanup();
  created.length = 0;
  revoked.length = 0;
});

const fallback = createElement('button', { type: 'button', className: 'message-media-omitted' }, 'Media');

test('an archived image loads once from the media route and renders from an object URL', async () => {
  let calls = 0;
  const { container, unmount } = rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'image',
      alt: 'photo.jpg',
      fallback,
      load: async () => {
        calls += 1;
        return new Blob(['x'], { type: 'image/jpeg' });
      },
    }),
  );
  const img = await rtl.waitFor(() => {
    const found = container.querySelector('img.chat-image-media');
    assert.ok(found, 'the archived image did not render');
    return found as HTMLImageElement;
  });
  assert.equal(img.getAttribute('src'), 'blob:mock-0');
  assert.equal(calls, 1, 'the bytes are fetched exactly once');
  assert.deepEqual(revoked, [], 'the URL stays valid while the image is on screen');
  rtl.fireEvent.click(img);
  const dialog = await rtl.screen.findByRole('dialog');
  assert.ok(dialog.querySelector('img[src="blob:mock-0"]'), 'the viewer uses the already loaded bytes');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Close' }));
  await rtl.act(() => new Promise(resolve => setTimeout(resolve, 500)));
  assert.equal(rtl.screen.queryByRole('dialog'), null);
  assert.equal(calls, 1, 'opening the viewer does not fetch the image again');
  assert.deepEqual(revoked, [], 'closing the viewer keeps the preview URL valid');
  rtl.fireEvent.keyDown(img, { key: 'Enter' });
  assert.ok(rtl.screen.getByRole('dialog'), 'the viewer opens from the keyboard');
  unmount();
  assert.deepEqual(revoked, ['blob:mock-0'], 'unmounting releases the object URL');
});

test('video and audio render their own elements', async () => {
  for (const [kind, selector] of [
    ['video', 'video.chat-video-media'],
    ['audio', 'audio.chat-audio-media'],
  ] as const) {
    const { container } = rtl.render(
      createElement(ArchivedMediaPreview, { kind, fallback, load: async () => new Blob(['x']) }),
    );
    await rtl.waitFor(() => assert.ok(container.querySelector(selector), `${kind} did not render`));
    rtl.cleanup();
  }
});

test('a failed fetch falls back to the download button instead of a broken preview', async () => {
  const { container } = rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'image',
      fallback,
      load: async () => {
        throw new Error('404');
      },
    }),
  );
  await rtl.waitFor(() => assert.ok(container.querySelector('button.message-media-omitted')));
  assert.equal(container.querySelectorAll('img').length, 0);
  assert.deepEqual(created, [], 'no object URL is made for a failed fetch');
});

test('a response landing after unmount makes no object URL', async () => {
  let resolve!: (blob: Blob) => void;
  const { unmount } = rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'image',
      fallback,
      load: () => new Promise<Blob>(r => (resolve = r)),
    }),
  );
  await rtl.waitFor(() => assert.ok(resolve, 'the fetch did not start'));
  unmount();
  resolve(new Blob(['x']));
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(created, [], 'a late response must not leak a URL nothing will revoke');
});

test('unmount aborts an archived media request still waiting for its bytes', async () => {
  let signal: AbortSignal | undefined;
  const { unmount } = rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'image',
      fallback,
      load: received => {
        signal = received;
        return new Promise<Blob>(() => undefined);
      },
    }),
  );
  await rtl.waitFor(() => assert.ok(signal, 'the loader did not receive an abort signal'));
  assert.equal(signal!.aborted, false);
  unmount();
  assert.equal(signal!.aborted, true);
  assert.deepEqual(created, []);
});

test('the lazy-load observer measures against the thread scroll container, so its lead is not clipped', async () => {
  const seen: Array<{ root: unknown; rootMargin: string | undefined }> = [];
  class FakeObserver {
    constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      seen.push({ root: options?.root, rootMargin: options?.rootMargin });
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  const scroller = document.createElement('div');
  const target = globalThis as { IntersectionObserver?: unknown };
  target.IntersectionObserver = FakeObserver;
  try {
    rtl.render(
      createElement(ArchivedMediaPreview, {
        kind: 'image',
        fallback,
        load: () => new Promise<Blob>(() => undefined),
        scrollRootRef: { current: scroller },
      }),
    );
    // Without the scroller as root, the implicit viewport root clips the margin to the scroller's box.
    assert.deepEqual(seen, [{ root: scroller, rootMargin: '600px 0px' }]);
  } finally {
    delete target.IntersectionObserver;
  }
});

test('the viewer downloads under the media file name, or one unique to the message when it has none', async () => {
  const downloads: string[] = [];
  // The library saves through a detached <a download> it clicks with dispatchEvent, never in the DOM.
  // jsdom elements inherit from jsdom's own EventTarget, so the spy goes on the element prototype.
  const anchorProto = HTMLAnchorElement.prototype as { dispatchEvent?: unknown };
  anchorProto.dispatchEvent = function (this: HTMLAnchorElement, event: Event): boolean {
    if (event.type === 'click') downloads.push(this.download);
    return true;
  };
  try {
    for (const props of [
      { id: 'msg-1', filename: 'holiday.jpg', alt: 'The sea at dusk' },
      { id: 'msg-2', alt: 'Image' },
    ]) {
      const { container } = rtl.render(
        createElement(ArchivedMediaPreview, {
          kind: 'image',
          fallback,
          load: async () => new Blob(['x'], { type: 'image/jpeg' }),
          ...props,
        }),
      );
      const img = await rtl.waitFor(() => {
        const found = container.querySelector('img.chat-image-media');
        assert.ok(found, 'the archived image did not render');
        return found as HTMLImageElement;
      });
      rtl.fireEvent.click(img);
      rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Download' }));
      // The library clicks its link from a timer once the blob is fetched.
      await rtl.act(() => new Promise(resolve => setTimeout(resolve, 50)));
      rtl.cleanup();
    }
    // A caption in the alt text must never become the saved name: every photo would save as the same word.
    assert.deepEqual(downloads, ['holiday.jpg', 'image-msg-2.jpg']);
  } finally {
    delete anchorProto.dispatchEvent;
  }
});

test('an archived audio placeholder reserves the height of the player that replaces it', async () => {
  const { container } = rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'audio',
      fallback,
      load: () => new Promise<Blob>(() => undefined),
    }),
  );
  const placeholder = container.querySelector('.message-media-archived-loading');
  assert.ok(placeholder, 'the placeholder did not render');
  assert.ok(placeholder.classList.contains('message-media-archived-loading-audio'));
  // The player has a fixed height, so a placeholder of that height means the bubble never grows when
  // the bytes land (a reader scrolled up, or pinned to the bottom, would otherwise be moved by it). The
  // player's bottom margin is 0.25rem larger than the placeholder's, which the box makes up.
  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  assert.match(css, /\.message-media-archived-loading-audio\s*\{[^}]*min-height:\s*calc\(54px \+ 0\.25rem\)/);
});

test('an archived video placeholder reserves the box a video element has before its metadata loads', async () => {
  const { container } = rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'video',
      fallback,
      load: () => new Promise<Blob>(() => undefined),
    }),
  );
  const placeholder = container.querySelector('.message-media-archived-loading');
  assert.ok(placeholder, 'the placeholder did not render');
  assert.ok(placeholder.classList.contains('message-media-archived-loading-video'));
  // A video element is 150px tall until it knows its size. An 18px placeholder swapped for it pushed the
  // text a reader was on down by 140px for every video above them.
  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  assert.match(css, /\.message-media-archived-loading-video\s*\{[^}]*min-height:\s*calc\(150px \+ 0\.25rem\)/);
});

test('an archived audio player reports its arrival so a bottom-pinned thread stays pinned', async () => {
  let reports = 0;
  const { container } = rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'audio',
      fallback,
      load: async () => new Blob(['x']),
      onMediaLoad: () => void (reports += 1),
    }),
  );
  await rtl.waitFor(() => assert.ok(container.querySelector('audio.chat-audio-media'), 'audio did not render'));
  await rtl.waitFor(() => assert.equal(reports, 1, 'the thread is told once that the placeholder became a player'));
});

test('previews mounted together start their fetches apart, so a burst stays under the gateway throttle', async () => {
  const starts: number[] = [];
  const preview = (key: number) =>
    createElement(ArchivedMediaPreview, {
      key,
      kind: 'audio',
      fallback,
      load: async () => {
        starts.push(Date.now());
        return new Blob(['x']);
      },
    });
  const { container } = rtl.render(createElement('div', null, [0, 1, 2, 3].map(preview)));
  await rtl.waitFor(() => assert.equal(container.querySelectorAll('audio.chat-audio-media').length, 4), {
    timeout: 3000,
  });
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(
      starts[i] - starts[i - 1] >= 100,
      `fetches ${i - 1} and ${i} started ${starts[i] - starts[i - 1]} ms apart`,
    );
  }
});

test('an archived placeholder is announced as loading, not left as an unnamed element', () => {
  rtl.render(
    createElement(ArchivedMediaPreview, { kind: 'image', fallback, load: () => new Promise<Blob>(() => undefined) }),
  );
  assert.ok(rtl.screen.getByRole('status', { name: 'Loading...' }));
});

test('an archived image is a named button that says it opens a dialog', async () => {
  rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'image',
      alt: 'photo.jpg',
      fallback,
      load: async () => new Blob(['x'], { type: 'image/jpeg' }),
    }),
  );
  const button = await rtl.screen.findByRole('button', { name: 'photo.jpg' });
  // The viewer is a dialog; without this a screen reader announces a bare "photo.jpg, button".
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
});

test('an archived image holds the height of the placeholder it replaces, so the swap never shortens the thread', async () => {
  const { container } = rtl.render(
    createElement(ArchivedMediaPreview, {
      kind: 'image',
      fallback,
      load: async () => new Blob(['x'], { type: 'image/jpeg' }),
    }),
  );
  const img = await rtl.waitFor(() => {
    const found = container.querySelector('img.chat-image-media');
    assert.ok(found, 'the archived image did not render');
    return found;
  });
  assert.ok(img.classList.contains('chat-image-media-archived'));
  // The placeholder is a 14px spinner plus .25rem of margin; an image has no box until it decodes and
  // brings .5rem of its own. A shorter thread clamps a scroll position pinned to the bottom, and the
  // browser reports the clamp as the reader scrolling away.
  const css = readFileSync(new URL('../../pages/Chats.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-image-media-archived\s*\{[^}]*min-height:\s*calc\(14px - 0\.25rem\)/);
});
