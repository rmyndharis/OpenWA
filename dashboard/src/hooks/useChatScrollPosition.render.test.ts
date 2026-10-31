// The scroll-position hook mounted on a real container. jsdom has no layout and fires no scroll event
// when a shrinking thread clamps scrollTop, so the container below models both: scrollTop is clamped
// to the content height, and the test dispatches the scroll event a browser would.
import '../test-helpers/register-hooks.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useEffect, type MutableRefObject } from 'react';

let rtl: typeof import('@testing-library/react');
let useChatScrollPosition: (typeof import('./useChatScrollPosition.ts'))['useChatScrollPosition'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ useChatScrollPosition } = await import('./useChatScrollPosition.ts'));
});

after(() => rtl.cleanup());

const CLIENT_HEIGHT = 400;
// A loaded thread is 100 rows; a chat still loading shows one spinner row.
const LOADED_HEIGHT = 4600;
const SPINNER_HEIGHT = 400;

function Thread({ chatId, isLoaded }: { chatId: string; isLoaded: boolean }) {
  const { containerRef } = useChatScrollPosition(chatId, isLoaded, false);
  return createElement('div', { ref: containerRef, 'data-testid': 'thread' });
}

test('switching to a chat that is still loading does not save the clamped top as its position', async () => {
  const { render, screen, fireEvent } = rtl;
  let height = LOADED_HEIGHT;
  let top = 0;
  const maxTop = () => Math.max(0, height - CLIENT_HEIGHT);
  // Defined before the first commit, so the restore effects already see this geometry.
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => Math.min(top, maxTop()),
      set: (v: number) => {
        top = Math.max(0, Math.min(v, maxTop()));
      },
    },
  });
  try {
    const { rerender } = render(createElement(Thread, { chatId: 'A', isLoaded: true }));
    const el = screen.getByTestId('thread');
    assert.equal(el.scrollTop, maxTop(), 'chat A did not open at the bottom');
    fireEvent.scroll(el); // the event a browser fires for that write
    el.scrollTop = 3000; // the operator reads a little way up
    fireEvent.scroll(el);

    // Chat B is not cached: the same container swaps A's thread for the spinner, and the browser
    // clamps scrollTop to 0 and reports it as a scroll on the next frame.
    height = SPINNER_HEIGHT;
    rerender(createElement(Thread, { chatId: 'B', isLoaded: false }));
    fireEvent.scroll(el);

    height = LOADED_HEIGHT;
    rerender(createElement(Thread, { chatId: 'B', isLoaded: true }));
    assert.equal(el.scrollTop, maxTop(), 'chat B opened at its oldest message instead of the newest');
  } finally {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  }
});

// An older page lands above the reader. Previews that swap in BELOW the reader while it is in flight grow
// the thread but move nothing on screen, so holding the reader by the thread's height delta dragged them
// down the thread by those pixels. The reader is held by the message they were on.
test('an older page holds the reader by their message, not by every pixel the thread grew', async () => {
  const { render, screen, cleanup } = rtl;
  cleanup();
  const top = { value: 0 };
  // Content-coordinate tops of the three messages the thread holds; the viewport shows 400px of them.
  const messageTops = new Map<string, number>([
    ['m1', 100],
    ['m2', 500],
    ['m3', 900],
  ]);
  let height = 1300;
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  const rectSaved = window.Element.prototype.getBoundingClientRect;
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => top.value,
      set: (v: number) => {
        top.value = Math.max(0, Math.min(v, height - CLIENT_HEIGHT));
      },
    },
  });
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const content = messageTops.get(this.getAttribute('data-id') ?? '');
    const y = content === undefined ? 0 : content - top.value;
    return { top: y, bottom: y + 300, left: 0, right: 0, width: 0, height: 300, x: 0, y } as DOMRect;
  };

  const request: MutableRefObject<(() => void) | null> = { current: null };
  function Older({ fetching }: { fetching: boolean }) {
    const { containerRef, onOlderMessagesRequested } = useChatScrollPosition('A', true, fetching);
    useEffect(() => {
      request.current = onOlderMessagesRequested;
    });
    return createElement(
      'div',
      { ref: containerRef, 'data-testid': 'thread' },
      ['m1', 'm2', 'm3'].map(id => createElement('div', { key: id, 'data-id': id, 'data-scroll-anchor': '' })),
    );
  }

  try {
    const { rerender } = render(createElement(Older, { fetching: false }));
    const el = screen.getByTestId('thread');
    // The reader is on m2 (500..800 in content, the viewport 400..800), 100px below the container's top.
    top.value = 400;
    request.current?.();
    rerender(createElement(Older, { fetching: true }));

    // A 230px preview swaps in below m3 while the page is out, on a commit of its own before the page lands.
    // Nothing is applied for it, and it must not use up what is owed to the page.
    height += 230;
    rerender(createElement(Older, { fetching: true }));
    assert.equal(el.scrollTop, 400, 'a commit while the page was out moved the reader');

    // The page lands: 2000px of history above.
    for (const [id, y] of [...messageTops]) messageTops.set(id, y + 2000);
    height += 2000;
    rerender(createElement(Older, { fetching: false }));

    assert.equal(el.scrollTop, 400 + 2000, 'the reader moved by more or less than the history above them');
  } finally {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
    window.Element.prototype.getBoundingClientRect = rectSaved;
  }
});

// The reader's own scrolling while a page is in flight is not the content moving: it must survive the
// landing, and a reader who jumped to the bottom must still be at the bottom, now of the taller thread.
for (const scenario of [
  { name: 'scrolls down 300px', scrollTo: 700, expected: 700 + 2000 },
  { name: 'is carried to the top by momentum', scrollTo: 0, expected: 0 + 2000 },
  { name: 'jumps to the bottom', scrollTo: 900, expected: 900 + 2000 },
]) {
  test(`an older page keeps a position the reader moved to while it was in flight: ${scenario.name}`, async () => {
    const { render, screen, cleanup } = rtl;
    cleanup();
    const top = { value: 0 };
    const messageTops = new Map<string, number>([
      ['m1', 100],
      ['m2', 500],
      ['m3', 900],
    ]);
    let height = 1300;
    const proto = window.HTMLDivElement.prototype;
    const saved = Object.getOwnPropertyDescriptors(proto);
    const rectSaved = window.Element.prototype.getBoundingClientRect;
    Object.defineProperties(proto, {
      scrollHeight: { configurable: true, get: () => height },
      clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
      scrollTop: {
        configurable: true,
        get: () => top.value,
        set: (v: number) => {
          top.value = Math.max(0, Math.min(v, height - CLIENT_HEIGHT));
        },
      },
    });
    window.Element.prototype.getBoundingClientRect = function (this: Element) {
      const content = messageTops.get(this.getAttribute('data-id') ?? '');
      const y = content === undefined ? 0 : content - top.value;
      return { top: y, bottom: y + 300, left: 0, right: 0, width: 0, height: 300, x: 0, y } as DOMRect;
    };
    const request: MutableRefObject<(() => void) | null> = { current: null };
    function Older({ fetching }: { fetching: boolean }) {
      const { containerRef, onOlderMessagesRequested } = useChatScrollPosition('A', true, fetching);
      useEffect(() => {
        request.current = onOlderMessagesRequested;
      });
      return createElement(
        'div',
        { ref: containerRef, 'data-testid': 'thread' },
        ['m1', 'm2', 'm3'].map(id => createElement('div', { key: id, 'data-id': id, 'data-scroll-anchor': '' })),
      );
    }
    try {
      const { rerender } = render(createElement(Older, { fetching: false }));
      const el = screen.getByTestId('thread');
      top.value = 80; // near the top, where an older page is requested
      request.current?.();
      rerender(createElement(Older, { fetching: true }));

      // The reader moves while the page is out, then it lands with 2000px of history above.
      top.value = scenario.scrollTo;
      for (const [id, y] of [...messageTops]) messageTops.set(id, y + 2000);
      height += 2000;
      rerender(createElement(Older, { fetching: false }));

      assert.equal(el.scrollTop, scenario.expected, `the reader ended at ${el.scrollTop}`);
    } finally {
      for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
        if (saved[key]) Object.defineProperty(proto, key, saved[key]);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
      window.Element.prototype.getBoundingClientRect = rectSaved;
    }
  });
}

// ── Live messages and the per-chat position memory ───────────────────────────
// One container whose geometry the test drives: `height` is what its content measures and `top` what a
// browser would report, clamped to the content.

type Geometry = { height: number; top: number };

function installGeometry(state: Geometry): () => void {
  const maxTop = () => Math.max(0, state.height - CLIENT_HEIGHT);
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => state.height },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => Math.min(state.top, maxTop()),
      set: (v: number) => {
        state.top = Math.max(0, Math.min(v, maxTop()));
      },
    },
  });
  return () => {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
  };
}

// What the last commit's hook call returned: the callbacks a page would hand to its components.
const hookRef: MutableRefObject<ReturnType<typeof useChatScrollPosition> | null> = { current: null };
const hook = (): ReturnType<typeof useChatScrollPosition> =>
  hookRef.current as ReturnType<typeof useChatScrollPosition>;

function Probe({
  chatId,
  loaded = chatId !== null,
  fetching = false,
}: {
  chatId: string | null;
  loaded?: boolean;
  fetching?: boolean;
}) {
  const result = useChatScrollPosition(chatId, loaded, fetching);
  useEffect(() => {
    hookRef.current = result;
  });
  return createElement('div', { ref: result.containerRef, 'data-testid': 'thread' });
}

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** The reader moves the thread: the position changes, then the browser reports it. */
function readerScrollsTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  rtl.fireEvent.scroll(el);
}

/**
 * A live message of `rowPx` the way the Chats page delivers one: announced to the hook while the thread
 * still has the height it had, then committed, then a frame.
 */
async function liveMessage(
  state: Geometry,
  rerender: (ui: ReturnType<typeof createElement>) => void,
  direction: 'incoming' | 'outgoing',
  rowPx: number,
  chatId = 'A',
): Promise<void> {
  hook().onMessageAppended(direction);
  state.height += rowPx;
  rerender(createElement(Probe, { chatId }));
  await nextFrame();
}

test('a chat left at the bottom comes back at its newest message when more arrived while the reader was elsewhere', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000);
    readerScrollsTo(el, g.height - CLIENT_HEIGHT); // the reader leaves A at its bottom

    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    g.height = 5200; // while they read B, two messages reached A's cached thread
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'chat A came back above the messages that arrived');
  } finally {
    restore();
  }
});

test('a chat left at the bottom comes back at the bottom after live messages followed it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el); // the event for the write that opened the chat at its bottom
    // The reader goes up a little and back down, so the position is remembered by genuine scrolls.
    readerScrollsTo(el, 3000);
    readerScrollsTo(el, g.height - CLIENT_HEIGHT);

    await liveMessage(g, rerender, 'incoming', 300);
    await liveMessage(g, rerender, 'incoming', 300);
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the thread did not follow the live messages');

    g.height = 4600; // chat B has a thread of its own
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    g.height = 5200; // chat A again, its cached thread holding both messages
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'chat A came back above its newest messages');
  } finally {
    restore();
  }
});

// Between the pin threshold (24px) and the follow threshold (100px) the reader is not pinned but a live message
// still scrolls the thread, and the position remembered for the chat is then the one before the message.
test('a chat left just above the bottom comes back at the bottom after a live message followed it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, g.height - CLIENT_HEIGHT - 60);

    await liveMessage(g, rerender, 'incoming', 300);
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the thread did not follow the live message');

    g.height = 4600;
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    g.height = 4900;
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'chat A came back above its newest message');
  } finally {
    restore();
  }
});

test('a chat left mid-thread comes back where the reader left it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000);

    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, 3000);
  } finally {
    restore();
  }
});

// ── Which scroll events are the reader's ─────────────────────────────────────
// A browser reports at most one scroll event per frame, however many writes the frame held, and reports the
// clamp a content swap causes as one too. None of that is the reader moving the thread.

test('a restore keeps its pending position through the scroll event the content swap raised', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000); // the reader's spot in A
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    readerScrollsTo(el, 4200); // B is left at its bottom

    // Back to A, whose images have not decoded: the cached thread is short, so the browser clamps the offset B
    // left and reports it. The restore write finds the thread already there and moves nothing.
    g.height = 2000;
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);

    g.height = 4600; // the images decode
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'the saved spot was lost to the clamp');
  } finally {
    restore();
  }
});

test('decodes that share a frame do not turn their one scroll event into the reader scrolling', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000);
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    readerScrollsTo(el, 300);

    g.height = 2000; // A again, its images not decoded
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);

    // Two images decode in one frame. The first write moves the thread; the second finds it where the first
    // left it. The browser reports the frame as a single event.
    g.height = 3200;
    hook().onMediaLoad();
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 2800);
    fireEvent.scroll(el);

    g.height = 4600; // the rest decode
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000, "the saved spot was lost to the frame's scroll event");
  } finally {
    restore();
  }
});

test('a reader scrolling back to where a pin left the thread is still the reader', async () => {
  const { render, screen, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 4200 }; // already at the bottom, so the opening pin moves nothing
  const restore = installGeometry(g);
  try {
    render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    readerScrollsTo(el, 3000);
    readerScrollsTo(el, 4200); // exactly where the pin left it: the reader's scroll, which pins the thread again

    g.height = 4900; // an image decodes below
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 4500, 'a reader at the bottom was not kept there');
  } finally {
    restore();
  }
});

// ── Following a live message ─────────────────────────────────────────────────
// The Chats page announces a message when it writes it to the cache, and the row reaches the DOM after the cache
// notifies its observers and React renders, which a frame can overtake.

test('a live message is followed by the commit that adds its row, even when a frame ran first', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);

    hook().onMessageAppended('incoming');
    await nextFrame(); // a frame lands before the commit: the thread has not grown yet
    rerender(createElement(Probe, { chatId: 'A' })); // so does a commit of something else, the sidebar
    g.height += 300;
    rerender(createElement(Probe, { chatId: 'A' })); // the row
    await nextFrame();
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the newest message was left below the fold');
  } finally {
    restore();
  }
});

test('a reader who scrolled away before the row was committed is not pulled back down', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);

    hook().onMessageAppended('incoming');
    readerScrollsTo(el, 3000);
    await nextFrame();
    g.height += 300;
    rerender(createElement(Probe, { chatId: 'A' }));
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'the reader was taken to the bottom');
  } finally {
    restore();
  }
});

test('a message announced in a chat that was left before its row committed pins nothing in the next chat', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    readerScrollsTo(el, 4140); // the spot the reader left in B, just above its bottom
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);

    hook().onMessageAppended('incoming');
    rerender(createElement(Probe, { chatId: 'B' })); // the reader goes back to B before the row lands
    fireEvent.scroll(el);
    g.height += 300; // B's thread grows for a reason of its own
    rerender(createElement(Probe, { chatId: 'B' }));
    await nextFrame();
    assert.equal(el.scrollTop, 4140, "the other chat's message moved the reader's spot in B");
  } finally {
    restore();
  }
});

test('a message the reader is far from the bottom of leaves their position alone', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 1000);

    await liveMessage(g, rerender, 'incoming', 300);
    assert.equal(el.scrollTop, 1000);
  } finally {
    restore();
  }
});

test('a message the reader sent always scrolls the thread to it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 1000);

    await liveMessage(g, rerender, 'outgoing', 300);
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT);
  } finally {
    restore();
  }
});

test('a message announced while its chat is still loading does not override where the chat opens', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000); // the spot the reader left in A
    rerender(createElement(Probe, { chatId: null }));

    // A is opened again from a cold cache: a spinner, then the thread. The message arrives in between.
    g.height = CLIENT_HEIGHT;
    rerender(createElement(Probe, { chatId: 'A', loaded: false }));
    hook().onMessageAppended('incoming');
    g.height = 4900;
    rerender(createElement(Probe, { chatId: 'A', loaded: true }));
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'the message took the reader from the spot they left');
  } finally {
    restore();
  }
});

// A chat dropped from the cache reopens with a spinner, and the composer is live meanwhile: what the reader sends then
// lands with the first page, and the chat opens on it rather than on the spot they left.
test('a message the reader sends while a chat with a saved spot loads opens the chat at it', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000); // the spot the reader left in A
    rerender(createElement(Probe, { chatId: null }));

    g.height = CLIENT_HEIGHT;
    rerender(createElement(Probe, { chatId: 'A', loaded: false }));
    hook().onMessageAppended('outgoing');
    g.height = 4900; // the first page, with the message sent meanwhile
    rerender(createElement(Probe, { chatId: 'A', loaded: true }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the message the reader sent was left below the fold');

    rerender(createElement(Probe, { chatId: 'B' })); // the reader leaves A at its bottom
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'A reopened at the old spot instead of at the bottom');
  } finally {
    restore();
  }
});

test('a message sent in a loading chat the reader then left does not move the next chat', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'B' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 1000); // the spot the reader left in B
    rerender(createElement(Probe, { chatId: null }));

    g.height = CLIENT_HEIGHT;
    rerender(createElement(Probe, { chatId: 'A', loaded: false }));
    hook().onMessageAppended('outgoing');
    g.height = 4600;
    rerender(createElement(Probe, { chatId: 'B' })); // the reader opens B before A has loaded
    assert.equal(el.scrollTop, 1000, 'B did not open at the spot the reader left');
  } finally {
    restore();
  }
});

// ── Media decoding ───────────────────────────────────────────────────────────
// Media has no box before it decodes, so a thread grows after it was positioned.

test('a saved position is applied again on each decode until the reader scrolls', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000);
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);

    g.height = 2000; // back to A before its media has decoded: the thread is short, and the spot out of reach
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 1600);

    g.height = 2600; // the first decodes: the spot is still out of reach
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 2200);
    fireEvent.scroll(el);

    g.height = 4600; // the rest: the spot is reached
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000);
    fireEvent.scroll(el);

    readerScrollsTo(el, 2000); // the reader moves: the spot is theirs to leave
    g.height = 4900;
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 2000, 'a decode took the reader back to the spot they left');
  } finally {
    restore();
  }
});

test('a thread pinned to the bottom stays there as media decodes, until the reader scrolls away', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 4200);

    g.height = 5000;
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 4600, 'a decode left the newest message below the fold');
    fireEvent.scroll(el);

    readerScrollsTo(el, 3000);
    g.height = 5400;
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'a decode pulled a reader who scrolled up back to the bottom');
  } finally {
    restore();
  }
});

// The echo of a send can add its row before the answer replaces the placeholder, and the thread then shrinks under a
// reader pinned to its bottom: the browser clamps scrollTop and reports the clamp as a scroll. An image that decodes in
// that frame grows the thread before the event is handled, so the clamp reads as a position above the bottom.
for (const scenario of [
  { name: 'in the frame of the echo', frameAfterEcho: false },
  { name: 'a frame after the echo', frameAfterEcho: true },
]) {
  test(`a send whose placeholder is dropped ${scenario.name} keeps the reader pinned through a decode`, async () => {
    const { render, screen, fireEvent, cleanup } = rtl;
    cleanup();
    const g: Geometry = { height: 4600, top: 0 };
    const restore = installGeometry(g);
    try {
      const { rerender } = render(createElement(Probe, { chatId: 'A' }));
      const el = screen.getByTestId('thread');
      fireEvent.scroll(el);

      await liveMessage(g, rerender, 'outgoing', 300); // the placeholder
      fireEvent.scroll(el);
      hook().onMessageAppended('incoming'); // the echo, under the id the answer will bring
      g.height += 300;
      rerender(createElement(Probe, { chatId: 'A' }));
      if (scenario.frameAfterEcho) {
        fireEvent.scroll(el);
        await nextFrame();
      }
      g.height -= 300; // the answer drops the placeholder, and the browser clamps
      g.top = Math.min(g.top, g.height - CLIENT_HEIGHT);
      rerender(createElement(Probe, { chatId: 'A' }));
      g.height += 500; // an image near the bottom decodes in the same frame
      hook().onMediaLoad();
      fireEvent.scroll(el); // the frame: its one scroll event, then the decode's re-pin
      await nextFrame();
      assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the reader who sent was left above the bottom');
    } finally {
      restore();
    }
  });
}

// Only a clamp is the thread's own: a commit can also land between the reader moving the thread and the event that
// reports it, and that event is still the reader's.
for (const scenario of [
  { name: 'up from the bottom', from: 'bottom', to: 3000 },
  { name: 'down to the bottom', from: 3000, to: 'bottom' },
] as const) {
  test(`a scroll ${scenario.name} that a commit overtakes is still the reader's`, async () => {
    const { render, screen, fireEvent, cleanup } = rtl;
    cleanup();
    const g: Geometry = { height: 4600, top: 0 };
    const restore = installGeometry(g);
    try {
      const { rerender } = render(createElement(Probe, { chatId: 'A' }));
      const el = screen.getByTestId('thread');
      fireEvent.scroll(el);
      readerScrollsTo(el, scenario.from === 'bottom' ? g.height - CLIENT_HEIGHT : scenario.from);

      el.scrollTop = scenario.to === 'bottom' ? g.height - CLIENT_HEIGHT : scenario.to; // the reader moves
      rerender(createElement(Probe, { chatId: 'A' })); // something else commits before the frame
      fireEvent.scroll(el); // the frame reports the move
      const reader = el.scrollTop;
      g.height += 400; // an image decodes below
      hook().onMediaLoad();
      await nextFrame();
      const expected = scenario.to === 'bottom' ? g.height - CLIENT_HEIGHT : reader;
      assert.equal(el.scrollTop, expected, `the reader ended at ${el.scrollTop}`);
    } finally {
      restore();
    }
  });
}

// The container is reused across chats, so a decode's frame that runs after a switch must not act on the chat entered.
test('a decode in the chat being left does not put the chat entered in the same frame at the spot of the one left', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000); // the reader's spot in A
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    readerScrollsTo(el, 1000); // and in B
    rerender(createElement(Probe, { chatId: 'A' })); // back in A, its restore pending
    fireEvent.scroll(el);

    hook().onMediaLoad(); // an image of A decodes; its re-apply waits for the frame
    rerender(createElement(Probe, { chatId: 'B' })); // the reader opens B before that frame
    await nextFrame();
    assert.equal(el.scrollTop, 1000, 'B was put at the spot saved for A');
  } finally {
    restore();
  }
});

test('a decode in a chat pinned to its bottom does not erase the saved spot of the chat entered in the same frame', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    readerScrollsTo(el, 1000); // the reader's spot in B
    rerender(createElement(Probe, { chatId: 'A' })); // A opens at its bottom, pinned
    fireEvent.scroll(el);

    hook().onMediaLoad(); // an image of A decodes; its re-pin waits for the frame
    g.height = CLIENT_HEIGHT; // B was dropped from the cache: a spinner while it loads
    rerender(createElement(Probe, { chatId: 'B', loaded: false }));
    await nextFrame();
    g.height = 4600;
    rerender(createElement(Probe, { chatId: 'B', loaded: true }));
    assert.equal(el.scrollTop, 1000, `B opened at ${el.scrollTop}, not at the reader's spot`);
  } finally {
    restore();
  }
});

// A chat comes back at its saved spot while its media has not decoded: the short thread clamps the write, so it reads
// as at the bottom. A live message announced in that window is not the reader following the conversation.
test('a live message in the decode window of a restored chat does not erase the saved spot', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000); // the reader's spot in A
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);

    g.height = 2000; // back to A before its media has decoded: the write clamps
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 1600);

    hook().onMessageAppended('incoming');
    g.height = 2070;
    rerender(createElement(Probe, { chatId: 'A' })); // its row commits

    g.height = 4670; // the media decodes and the saved spot is reached
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'the decode did not return the reader to the saved spot');
    fireEvent.scroll(el);

    rerender(createElement(Probe, { chatId: 'B' })); // the reader leaves again without scrolling
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, 3000, `A reopened at ${el.scrollTop}, not at the spot the reader was reading`);
  } finally {
    restore();
  }
});

// The reader's own send is an explicit act: it scrolls to the new row even in a chat that came back at its saved spot
// and is still waiting for its media. The row is where they are now, so the spot is not theirs to be put back on.
test('a message the reader sends in a chat reopened at its saved spot scrolls to it, and no decode takes them back', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 3000); // the reader's spot in A
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'A' })); // back at the spot, the restore still pending
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 3000);

    await liveMessage(g, rerender, 'outgoing', 300);
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the sent message was left below the fold');
    fireEvent.scroll(el);

    g.height += 400; // an image decodes
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'a decode took the reader back to the saved spot');
    fireEvent.scroll(el);

    rerender(createElement(Probe, { chatId: 'B' })); // the reader leaves A at its bottom
    fireEvent.scroll(el);
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'A reopened at the old spot instead of at the bottom');
  } finally {
    restore();
  }
});

// ── Older pages landing under a position the memory holds ────────────────────

// The echo of a send from the page can reach it after the composer reconciled its placeholder: the cache write
// merges into the existing row, the thread does not grow, and the follow the announcement armed has no commit to
// meet. The page that lands next is not that message.
test('a message announced without growing the thread does not pin the reader when an older page lands', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);

    hook().onMessageAppended('incoming');
    rerender(createElement(Probe, { chatId: 'A' })); // its commit: the thread did not grow
    await nextFrame();

    readerScrollsTo(el, 50); // the reader goes to the top to read back
    hook().onOlderMessagesRequested();
    rerender(createElement(Probe, { chatId: 'A', fetching: true }));
    g.height += 4600; // the page lands above them
    rerender(createElement(Probe, { chatId: 'A', fetching: false }));
    await nextFrame();
    assert.equal(el.scrollTop, 50 + 4600, 'the landing page took the reader to the bottom');
  } finally {
    restore();
  }
});

// An older page lands under a reader who jumped to the bottom while it was in flight. The landing holds them there,
// and where it leaves them is the bottom only until something arrives below.
test('a chat left at the bottom after an older page landed under the reader comes back at the bottom', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 50); // near the top: an older page is asked for
    hook().onOlderMessagesRequested();
    rerender(createElement(Probe, { chatId: 'A', fetching: true }));
    readerScrollsTo(el, g.height - CLIENT_HEIGHT); // the reader jumps to the bottom while it is out
    g.height += 4600; // the page lands above them
    rerender(createElement(Probe, { chatId: 'A', fetching: false }));
    await nextFrame();
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'the landing did not hold the reader at the bottom');
    fireEvent.scroll(el);

    rerender(createElement(Probe, { chatId: 'B' })); // the reader leaves A at its bottom
    fireEvent.scroll(el);
    g.height += 200; // two messages reach A's cached thread meanwhile
    rerender(createElement(Probe, { chatId: 'A' }));
    assert.equal(el.scrollTop, g.height - CLIENT_HEIGHT, 'A reopened above the messages that arrived');
  } finally {
    restore();
  }
});

// A chat comes back at a saved spot near the top of its loaded history. The restore stays pending until the reader
// scrolls. An older page lands and holds the reader on their message, and a decode after it must not take them back
// to the offset from before the page, which is now the top of what landed.
test('a decode after an older page landed does not apply the saved spot from before the page', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const g: Geometry = { height: 4600, top: 0 };
  const restore = installGeometry(g);
  try {
    const { rerender } = render(createElement(Probe, { chatId: 'A' }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 0); // the reader leaves A at the top of its loaded history
    rerender(createElement(Probe, { chatId: 'B' }));
    fireEvent.scroll(el);

    g.height = 2000; // back to A, its media not decoded
    rerender(createElement(Probe, { chatId: 'A' }));
    fireEvent.scroll(el); // the restore wrote 0
    hook().onOlderMessagesRequested(); // the thread asks for an older page by itself
    rerender(createElement(Probe, { chatId: 'A', fetching: true }));
    g.height += 3000; // the page lands
    rerender(createElement(Probe, { chatId: 'A', fetching: false }));
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'the landing did not hold the reader on their message');
    fireEvent.scroll(el);

    g.height += 600; // the media decodes
    hook().onMediaLoad();
    await nextFrame();
    assert.equal(el.scrollTop, 3000, 'a decode took the reader above the page they were held on');
  } finally {
    restore();
  }
});

// ── A thread of message rows ─────────────────────────────────────────────────
// Rows laid out top to bottom in the container, each an anchor; a row may hold an image, which the test grows as it
// decodes, under its text or (imgFirst) above it. Positions are what a browser would report for them at the current
// scrollTop.

type Row = { id: string; h: number; img?: number; anchor?: false; imgFirst?: true };
type Thread = { rows: Row[]; top: number };

const rowsHeight = (t: Thread) => t.rows.reduce((sum, r) => sum + r.h + (r.img ?? 0), 0);
const rowsMax = (t: Thread) => Math.max(0, rowsHeight(t) - CLIENT_HEIGHT);
const textRows = (prefix: string, n: number, h = 100): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, h }));

function installRows(t: Thread): () => void {
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  const rectSaved = window.Element.prototype.getBoundingClientRect;
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => rowsHeight(t) },
    clientHeight: { configurable: true, get: () => CLIENT_HEIGHT },
    scrollTop: {
      configurable: true,
      get: () => Math.min(t.top, rowsMax(t)),
      set: (v: number) => {
        t.top = Math.max(0, Math.min(v, rowsMax(t)));
      },
    },
  });
  const box = (y: number, h: number) =>
    ({ top: y, bottom: y + h, left: 0, right: 0, width: 0, height: h, x: 0, y }) as DOMRect;
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const id = this.getAttribute('data-id') ?? this.getAttribute('data-img');
    let y = -Math.min(t.top, rowsMax(t));
    for (const r of t.rows) {
      if (r.id === id)
        return this.hasAttribute('data-img') ? box(y + (r.imgFirst ? 0 : r.h), r.img ?? 0) : box(y, r.h + (r.img ?? 0));
      y += r.h + (r.img ?? 0);
    }
    return box(0, CLIENT_HEIGHT); // the container
  };
  return () => {
    for (const key of ['scrollHeight', 'clientHeight', 'scrollTop'] as const) {
      if (saved[key]) Object.defineProperty(proto, key, saved[key]);
      else delete (proto as unknown as Record<string, unknown>)[key];
    }
    window.Element.prototype.getBoundingClientRect = rectSaved;
  };
}

function RowsProbe({ chatId, rows, fetching = false }: { chatId: string; rows: Row[]; fetching?: boolean }) {
  const result = useChatScrollPosition(chatId, true, fetching);
  useEffect(() => {
    hookRef.current = result;
  });
  return createElement(
    'div',
    { ref: result.containerRef, 'data-testid': 'thread' },
    rows.map(r =>
      createElement(
        'div',
        { key: r.id, 'data-id': r.id, ...(r.anchor === false ? {} : { 'data-scroll-anchor': r.id }) },
        r.img === undefined ? null : createElement('img', { ref: result.measureMedia, 'data-img': r.id }),
      ),
    ),
  );
}

// The reader sends while an older page is out, and the page lands in the commit that adds their row: what they sent
// is where they are taken, not the message the page holds them on.
test('a message the reader sends while an older page is out is followed when the page lands with its row', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  const restore = installRows(t);
  try {
    const { rerender } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 50); // near the top: an older page is asked for
    hook().onOlderMessagesRequested();
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));

    hook().onMessageAppended('outgoing');
    t.rows = [...textRows('p', 10), ...t.rows, { id: 'own', h: 100 }];
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: false }));
    assert.equal(el.scrollTop, rowsMax(t), 'the message the reader sent was left below the fold');
  } finally {
    restore();
  }
});

// A follow the thread never consumed (the message was announced but added no row) is not the reader's: it must not
// take them to the bottom when a page lands under them later, whichever way the message went.
test('a message announced before the reader went back for history does not pin them when the page lands', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  const restore = installRows(t);
  try {
    const { rerender } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    hook().onMessageAppended('outgoing');
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows })); // no row was added
    await nextFrame();

    readerScrollsTo(el, 50);
    hook().onOlderMessagesRequested();
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));
    t.rows = [...textRows('p', 10), ...t.rows];
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: false }));
    assert.equal(el.scrollTop, 50 + 1000, 'the landing page took the reader to the bottom');
  } finally {
    restore();
  }
});

// The thread is reused across chats, and a page asked for in one chat is not cancelled when the reader leaves it: it
// lands after they come back, above the message the restore put them on.
for (const scenario of [
  { name: 'from a chat with no page out', otherFetching: false },
  { name: 'from a chat whose own page is out', otherFetching: true },
]) {
  test(`an older page that lands after the reader came back ${scenario.name} holds them on their message`, async () => {
    const { render, screen, fireEvent, cleanup } = rtl;
    cleanup();
    const t: Thread = { rows: textRows('a', 46), top: 0 };
    const restore = installRows(t);
    try {
      const { rerender } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
      const el = screen.getByTestId('thread');
      fireEvent.scroll(el);
      readerScrollsTo(el, 50); // near the top: an older page is asked for
      hook().onOlderMessagesRequested();
      rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));

      const rowsOfA = t.rows;
      t.rows = textRows('b', 30); // the reader opens B before the page lands
      rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows, fetching: scenario.otherFetching }));
      fireEvent.scroll(el);
      t.rows = rowsOfA; // and comes back to A, its page still out
      rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));
      fireEvent.scroll(el);
      assert.equal(el.scrollTop, 50, 'A did not reopen where the reader left it');
      t.rows = [...rowsOfA, { id: 'live', h: 100 }]; // a message far below the reader while the page is out
      rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));

      t.rows = [...textRows('p', 10), ...t.rows]; // the page lands: 1000px above the reader
      rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: false }));
      assert.equal(el.scrollTop, 50 + 1000, 'the reader was left on the top of the page that landed');
    } finally {
      restore();
    }
  });
}

// The page can also land while the reader is still in the other chat, so it is never seen landing: it is above the
// offset saved for the chat when they come back, and so is everything that offset was measured against.
test('an older page that lands while the reader is in another chat reopens the chat on the message they left', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  const restore = installRows(t);
  try {
    const { rerender } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 50); // near the top: an older page is asked for
    hook().onOlderMessagesRequested();
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));

    const rowsOfA = [...textRows('p', 10), ...t.rows]; // the page lands while the reader is in B: 1000px above
    t.rows = textRows('b', 30);
    rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows }));
    fireEvent.scroll(el);
    t.rows = rowsOfA;
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 50 + 1000, 'A reopened on the page that landed instead of the message the reader left');

    // Out and back again without scrolling: the same message, not the offset from before the page.
    t.rows = textRows('b', 30);
    rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows }));
    fireEvent.scroll(el);
    t.rows = rowsOfA;
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 50 + 1000, 'the second return went back to the offset from before the page');
  } finally {
    restore();
  }
});

// The rows of that page mount when the chat is shown again, so their images decode after the restore: each one is above
// the reader, and the restore waiting for media holds them through it.
test('an image in a page that landed while the reader was away decodes after they came back without moving them', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  const restore = installRows(t);
  try {
    const { rerender, container } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 50);
    hook().onOlderMessagesRequested();
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));

    const page = textRows('p', 10);
    page[2] = { id: 'p2', h: 100, img: 0 };
    const rowsOfA = [...page, ...t.rows];
    t.rows = textRows('b', 30);
    rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows }));
    fireEvent.scroll(el);
    t.rows = rowsOfA;
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    fireEvent.scroll(el);

    t.rows[2] = { id: 'p2', h: 100, img: 300 }; // the page's image decodes
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="p2"]') });
    await nextFrame();
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 50 + 1000 + 300, 'the image in the page pushed the reader off their message');
  } finally {
    restore();
  }
});

// A saved spot whose first row is gone from the thread (the chat's history was fetched again from its newest page) has
// nothing to be moved by: the offset is written as it was saved.
test('a chat whose first row is gone when the reader comes back reopens at the saved offset', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  const restore = installRows(t);
  try {
    const { rerender } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 2000);
    t.rows = textRows('b', 30);
    rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows }));
    fireEvent.scroll(el);
    t.rows = textRows('a', 46).slice(10);
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    assert.equal(el.scrollTop, 2000);
  } finally {
    restore();
  }
});

// While a page is out, an image that decodes above the reader is left to the landing, which holds them by the message
// they were on: a commit in between (a message far below) must not take that measure again from the moved message.
test('an image that decodes above the reader while an older page is out is counted when the page lands', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  t.rows[2] = { id: 'a2', h: 100, img: 0 };
  const restore = installRows(t);
  try {
    const { rerender, container } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 450); // the reader is on a4, 50px under the top edge
    hook().onOlderMessagesRequested();
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));

    t.rows[2] = { id: 'a2', h: 100, img: 300 }; // the image in a2 decodes
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a2"]') });
    await nextFrame();
    t.rows = [...t.rows, { id: 'live', h: 100 }]; // a message far below commits while the page is out
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));

    t.rows = [...textRows('p', 10), ...t.rows]; // the page lands: 1000px above
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: false }));
    assert.equal(el.scrollTop, 450 + 300 + 1000, 'the reader was not held on the message they were on');
  } finally {
    restore();
  }
});

// The reader goes on reading while a page is out, and an image above where they went decodes: the landing holds them on
// the row they are on now, the image included, not on the row they were on when the page was asked for.
test('an image that decodes above where the reader scrolled while an older page is out is counted when it lands', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  t.rows[20] = { id: 'a20', h: 100, img: 0 };
  const restore = installRows(t);
  try {
    const { rerender, container } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 50); // near the top: an older page is asked for
    hook().onOlderMessagesRequested();
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));
    readerScrollsTo(el, 2550); // the reader reads on, to a25, while it is out

    t.rows[20] = { id: 'a20', h: 100, img: 300 }; // the image in a20, above them, decodes
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a20"]') });
    await nextFrame();
    t.rows = [...textRows('p', 10), ...t.rows]; // the page lands: 1000px above
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: false }));
    assert.equal(el.scrollTop, 2550 + 300 + 1000, 'the reader was left displaced by the image');
  } finally {
    restore();
  }
});

// An image above the reader that decodes while a page is out holds them in its frame, as it does with no page out, and
// the landing then counts it once: whichever comes first of its load, the request, a scroll of the reader, the frame
// and the landing. The reader is on a4, 50px under the top edge; the page is 1000px. The image grows by 30px, so the row
// the reader is on stays below it however the thread is read.
for (const scenario of [
  { name: 'in its frame', order: ['request', 'decode', 'frame', 'land'] },
  { name: 'when its load came just before the page was asked for', order: ['decode', 'request', 'frame', 'land'] },
  { name: 'when the page lands before its frame', order: ['request', 'decode', 'land', 'frame'] },
  { name: 'when the reader scrolls before its frame', order: ['request', 'decode', 'scroll', 'frame', 'land'] },
  { name: 'when the image is in the row the reader is on', order: ['request', 'decode', 'frame', 'land'], inRow: true },
  { name: 'when no message row is in view', order: ['request', 'decode', 'frame', 'land'], noAnchors: true },
]) {
  test(`an image that decodes above the reader while an older page is out holds them ${scenario.name}`, async () => {
    const { render, screen, fireEvent, cleanup } = rtl;
    cleanup();
    const t: Thread = { rows: textRows('a', 46), top: 0 };
    // In the row the reader is on, the image is above its text and above the top edge: a4 is still the first row.
    const imageRow = scenario.inRow ? 4 : 2;
    t.rows[imageRow] = { id: `a${imageRow}`, h: 100, img: 0, ...(scenario.inRow ? { imgFirst: true as const } : {}) };
    if (scenario.noAnchors) t.rows = t.rows.map(r => ({ ...r, anchor: false as const }));
    const restore = installRows(t);
    try {
      const { rerender, container } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
      const el = screen.getByTestId('thread');
      fireEvent.scroll(el);
      const start = scenario.inRow ? 420 : 450;
      readerScrollsTo(el, start);
      let fetching = false;
      let scrolled = 0;
      for (const step of scenario.order) {
        if (step === 'request') {
          hook().onOlderMessagesRequested();
          fetching = true;
          rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching }));
        } else if (step === 'decode') {
          t.rows[imageRow] = { ...t.rows[imageRow], img: 30 };
          hook().onMediaLoad({ currentTarget: container.querySelector(`img[data-img="a${imageRow}"]`) });
        } else if (step === 'scroll') {
          scrolled = 10; // the reader moves on by 10px from where they saw the thread
          readerScrollsTo(el, start + scrolled);
        } else if (step === 'frame') {
          await nextFrame();
          if (scenario.order.indexOf('land') > scenario.order.indexOf('frame'))
            assert.equal(el.scrollTop, start + scrolled + 30, 'the image moved the reader while the page was out');
        } else {
          t.rows = [
            ...(scenario.noAnchors
              ? textRows('p', 10).map(r => ({ ...r, anchor: false as const }))
              : textRows('p', 10)),
            ...t.rows,
          ];
          fetching = false;
          rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching }));
        }
      }
      assert.equal(el.scrollTop, start + scrolled + 30 + 1000, 'the image was counted more or less than once');
    } finally {
      restore();
    }
  });
}

// A chat shown again with its page still out is held against where the restore put the reader, before the images of
// the thread, mounted again, have decoded. One above the saved spot that decodes while the restore waits is absorbed
// by the restore putting them back on it, so the page that lands after must not count it a second time.
for (const scenario of [{ name: 'by the row they are on' }, { name: 'with no message row in view', noAnchors: true }]) {
  test(`a page still out when the reader comes back lands after an image above their spot decoded ${scenario.name}`, async () => {
    const { render, screen, fireEvent, cleanup } = rtl;
    cleanup();
    const plain = (rows: Row[]) => (scenario.noAnchors ? rows.map(r => ({ ...r, anchor: false as const })) : rows);
    const t: Thread = { rows: plain(textRows('a', 46)), top: 0 };
    t.rows[2] = { ...t.rows[2], img: 300 }; // decoded while the reader was here
    const restore = installRows(t);
    try {
      const { rerender, container } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
      const el = screen.getByTestId('thread');
      fireEvent.scroll(el);
      readerScrollsTo(el, 1000); // a7 at the top edge
      hook().onOlderMessagesRequested();
      rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));

      const rowsOfA = t.rows;
      t.rows = textRows('b', 30);
      rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows }));
      fireEvent.scroll(el);
      t.rows = rowsOfA.map((r, i) => (i === 2 ? { ...r, img: 0 } : r)); // mounted again, not decoded yet
      rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));
      fireEvent.scroll(el);

      t.rows[2] = { ...t.rows[2], img: 300 };
      hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a2"]') });
      await nextFrame();
      fireEvent.scroll(el);
      assert.equal(el.scrollTop, 1000, 'the restore did not put the reader back on their spot');

      t.rows = [...plain(textRows('p', 10)), ...t.rows]; // the page lands: 1000px above
      rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: false }));
      assert.equal(el.scrollTop, 1000 + 1000, 'the image the restore absorbed was counted again by the page');
    } finally {
      restore();
    }
  });
}

// A reader can stop where no row is in view (a tall element that is not a message): the landing then holds them by the
// row they were on before, not by every pixel the thread grew, growth below them included.
test('a reader who scrolls to where no message is in view while an older page is out is held by the row before', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: [...textRows('a', 46), { id: 'tail', h: 600, anchor: false }], top: 0 };
  const restore = installRows(t);
  try {
    const { rerender } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 50); // near the top: an older page is asked for
    hook().onOlderMessagesRequested();
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));
    readerScrollsTo(el, 4700); // down to where only the tail is in view

    t.rows = [...t.rows.slice(0, -1), { id: 'tail', h: 700, anchor: false }]; // it grows below the reader
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: true }));
    t.rows = [...textRows('p', 10), ...t.rows]; // the page lands: 1000px above
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows, fetching: false }));
    assert.equal(el.scrollTop, 4700 + 1000, 'the growth below the reader moved them');
  } finally {
    restore();
  }
});

// Images above the reader that decode in one frame each push them down by their own growth, whatever order their load
// events come in: a later event reads its element after an earlier one grew above it.
for (const scenario of [
  { name: 'one after the other, the upper first', order: ['a10', 'a11'], together: false },
  { name: 'together, the upper reported first', order: ['a10', 'a11'], together: true },
  { name: 'together, the lower reported first', order: ['a11', 'a10'], together: true },
  { name: 'one after the other, the lower first', order: ['a11', 'a10'], together: false },
]) {
  test(`two images above the reader that decode in one frame hold them: ${scenario.name}`, async () => {
    const { render, screen, fireEvent, cleanup } = rtl;
    cleanup();
    const t: Thread = { rows: textRows('a', 46), top: 0 };
    t.rows[10] = { id: 'a10', h: 100, img: 0 };
    t.rows[11] = { id: 'a11', h: 100, img: 0 };
    const restore = installRows(t);
    try {
      const { container } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
      const el = screen.getByTestId('thread');
      fireEvent.scroll(el);
      readerScrollsTo(el, 1210); // a12 is the first row the reader sees, both images just above it

      const decode = (id: string) => {
        const i = t.rows.findIndex(r => r.id === id);
        t.rows[i] = { ...t.rows[i], img: 300 };
      };
      const loaded = (id: string) =>
        hook().onMediaLoad({ currentTarget: container.querySelector(`img[data-img="${id}"]`) });
      if (scenario.together) {
        for (const id of scenario.order) decode(id);
        for (const id of scenario.order) loaded(id);
      } else {
        for (const id of scenario.order) {
          decode(id);
          loaded(id);
        }
      }
      await nextFrame();
      assert.equal(el.scrollTop, 1210 + 600, 'the reader was moved off the row they were on');
    } finally {
      restore();
    }
  });
}

// The frame of a decode that finds its chat left drops the batch it was asked for: the queue is shared by every chat
// the container shows, and one that kept the element of the chat left would make each later decode queue behind it
// without asking for a frame, so the reader would no longer be held.
test('a decode whose frame runs after a chat switch does not stop the next chat from holding its reader', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  t.rows[10] = { id: 'a10', h: 100, img: 0 };
  const restore = installRows(t);
  try {
    const { rerender, container } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 1210); // the reader reads back in A, a12 the first row they see
    t.rows[10] = { id: 'a10', h: 100, img: 300 };
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a10"]') });
    const rowsOfB = textRows('b', 46);
    rowsOfB[10] = { id: 'b10', h: 100, img: 0 };
    t.rows = rowsOfB;
    rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows })); // B is opened before that decode's frame
    await nextFrame(); // the frame finds A left
    fireEvent.scroll(el); // the restore's own event (B opened at its bottom)
    readerScrollsTo(el, 1210); // the reader reads back in B

    t.rows[10] = { id: 'b10', h: 100, img: 300 };
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="b10"]') });
    await nextFrame();
    assert.equal(el.scrollTop, 1210 + 300, 'the image above the reader in B moved them off their message');
  } finally {
    restore();
  }
});

// A correction raises a scroll event of its own, which the hook skips as its write: the correction is what records
// the spot it moved the reader to, so a chat left without scrolling again reopens on the message they were on.
test('a chat left right after a correction for an image above the reader reopens on the message they were on', async () => {
  const { render, screen, fireEvent, cleanup } = rtl;
  cleanup();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  t.rows[10] = { id: 'a10', h: 100, img: 0 };
  const restore = installRows(t);
  try {
    const { rerender, container } = render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = screen.getByTestId('thread');
    fireEvent.scroll(el);
    readerScrollsTo(el, 1210); // the reader reads back in A, a12 the first row they see
    t.rows[10] = { id: 'a10', h: 100, img: 300 };
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a10"]') });
    await nextFrame();
    fireEvent.scroll(el); // the correction's own event
    assert.equal(el.scrollTop, 1510, 'the image above the reader moved them');

    const rowsOfA = t.rows;
    t.rows = textRows('b', 46);
    rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows })); // the reader opens B without scrolling
    fireEvent.scroll(el);
    t.rows = rowsOfA;
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows })); // and comes back
    fireEvent.scroll(el);
    assert.equal(el.scrollTop, 1510, 'A reopened at the spot from before the image grew');
  } finally {
    restore();
  }
});

function queuedMediaFrames() {
  const original = { raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const canceled = new Set<number>();
  const ran: number[] = [];
  globalThis.requestAnimationFrame = callback => {
    const id = ++nextId;
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    pending.delete(id);
    canceled.add(id);
  };
  return {
    pending,
    canceled,
    ran,
    flush() {
      for (const id of [...pending.keys()]) {
        if (!pending.has(id)) continue;
        const callback = pending.get(id)!;
        pending.delete(id);
        assert.equal(canceled.has(id), false);
        ran.push(id);
        callback(0);
      }
    },
    restore() {
      pending.clear();
      globalThis.requestAnimationFrame = original.raf;
      globalThis.cancelAnimationFrame = original.cancel;
    },
  };
}

test('a decode in the next chat is corrected when it arrives before the retired frame', () => {
  rtl.cleanup();
  const frames = queuedMediaFrames();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  t.rows[10].img = 0;
  const restore = installRows(t);
  try {
    const { rerender, container } = rtl.render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = rtl.screen.getByTestId('thread');
    rtl.fireEvent.scroll(el);
    readerScrollsTo(el, 1210);
    t.rows[10].img = 300;
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a10"]') });
    assert.equal(frames.pending.size, 1);

    t.rows = textRows('b', 46);
    t.rows[10].img = 0;
    rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows }));
    rtl.fireEvent.scroll(el);
    readerScrollsTo(el, 1210);
    assert.equal(el.scrollTop, 1210);
    t.rows[10].img = 300;
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="b10"]') });
    frames.flush();
    assert.equal(el.scrollTop, 1510);
    frames.flush();
    assert.equal(el.scrollTop, 1510);
    assert.equal(
      frames.ran.some(id => frames.canceled.has(id)),
      false,
    );
  } finally {
    rtl.cleanup();
    restore();
    frames.restore();
  }
});

test('unmount cancels a pending media frame', () => {
  rtl.cleanup();
  const frames = queuedMediaFrames();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  t.rows[10].img = 0;
  const restore = installRows(t);
  try {
    const { container, unmount } = rtl.render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = rtl.screen.getByTestId('thread');
    rtl.fireEvent.scroll(el);
    readerScrollsTo(el, 1210);
    t.rows[10].img = 300;
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a10"]') });
    assert.equal(frames.pending.size, 1);
    unmount();
    assert.equal(frames.pending.size, 0);
    frames.flush();
    assert.equal(frames.ran.length, 0);
  } finally {
    rtl.cleanup();
    restore();
    frames.restore();
  }
});

test('returning to the same chat starts a new media-frame visit', () => {
  rtl.cleanup();
  const frames = queuedMediaFrames();
  const t: Thread = { rows: textRows('a', 46), top: 0 };
  t.rows[10].img = 0;
  const restore = installRows(t);
  try {
    const { rerender, container } = rtl.render(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    const el = rtl.screen.getByTestId('thread');
    rtl.fireEvent.scroll(el);
    readerScrollsTo(el, 1210);
    t.rows[10].img = 300;
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a10"]') });
    const retired = [...frames.pending.keys()][0];
    assert.ok(retired !== undefined);
    const retiredLoad = hook().onMediaLoad;
    const retiredMedia = container.querySelector('img[data-img="a10"]');
    assert.ok(retiredMedia);
    const rowsOfA = t.rows;
    t.rows = textRows('b', 46);
    rerender(createElement(RowsProbe, { chatId: 'B', rows: t.rows }));
    rtl.fireEvent.scroll(el);
    t.rows = rowsOfA.map((row, i) => (i === 10 ? { ...row, img: 0 } : row));
    rerender(createElement(RowsProbe, { chatId: 'A', rows: t.rows }));
    rtl.fireEvent.scroll(el);
    readerScrollsTo(el, 1220);
    assert.equal(retiredMedia.isConnected, false);
    retiredLoad({ currentTarget: retiredMedia });
    assert.equal(frames.pending.size, 0);
    t.rows[10].img = 300;
    hook().onMediaLoad({ currentTarget: container.querySelector('img[data-img="a10"]') });
    assert.ok(frames.canceled.has(retired));
    frames.flush();
    assert.equal(frames.ran.includes(retired), false);
    assert.equal(el.scrollTop, 1520);
    frames.flush();
    assert.equal(el.scrollTop, 1520);
  } finally {
    rtl.cleanup();
    restore();
    frames.restore();
  }
});
