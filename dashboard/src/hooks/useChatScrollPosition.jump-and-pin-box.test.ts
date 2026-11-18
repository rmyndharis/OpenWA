// The scroll-position hook mounted the way the Chats page mounts it: the hook lives in the page, the thread's container
// exists only while a room is open. jsdom has no layout and no ResizeObserver, so the container below models both:
// scrollTop is clamped to the content, the content is taller when the box is narrower (its text wraps anew), and the
// test dispatches the scroll event and hands the observer's report the way a browser does, in that order.
import '../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useEffect } from 'react';

let rtl: typeof import('@testing-library/react');
let useChatScrollPosition: (typeof import('./useChatScrollPosition.ts'))['useChatScrollPosition'];
type Api = ReturnType<(typeof import('./useChatScrollPosition.ts'))['useChatScrollPosition']>;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ useChatScrollPosition } = await import('./useChatScrollPosition.ts'));
});
after(() => rtl.cleanup());

const FULL_WIDTH = 640;
const SCROLLBAR = 6;
const BASE_HEIGHT = 4600;
const WRAPPED_EXTRA = 120; // the text wraps onto more lines when the thread loses the width of a scrollbar

let api: Api | undefined;
function Room({ chatId, open }: { chatId: string; open: boolean }) {
  const hook = useChatScrollPosition(open ? chatId : null, open, false);
  // After the render: the test reads the hook's functions once the commit and its effects are done.
  useEffect(() => {
    api = hook;
  });
  return open
    ? createElement(
        'div',
        { ref: hook.containerRef, 'data-testid': 'thread' },
        createElement('div', { 'data-scroll-anchor': 'row', 'data-testid': 'row' }),
      )
    : null;
}

type Geometry = { client: number; width: number; top: number; jumpTo: number; writes: number };
function install(): { g: Geometry; maxTop: () => number; restore: () => void; report: () => void; observers: number } {
  const g: Geometry = { client: 400, width: FULL_WIDTH, top: 0, jumpTo: 0, writes: 0 };
  const height = () => BASE_HEIGHT + (g.width < FULL_WIDTH ? WRAPPED_EXTRA : 0);
  const maxTop = () => Math.max(0, height() - g.client);
  const proto = window.HTMLDivElement.prototype;
  const saved = Object.getOwnPropertyDescriptors(proto);
  Object.defineProperties(proto, {
    scrollHeight: { configurable: true, get: () => height() },
    clientHeight: { configurable: true, get: () => g.client },
    clientWidth: { configurable: true, get: () => g.width },
    scrollTop: {
      configurable: true,
      get: () => Math.min(g.top, maxTop()),
      set: (v: number) => {
        g.writes += 1;
        g.top = Math.max(0, Math.min(v, maxTop()));
      },
    },
  });
  const sii = Element.prototype.scrollIntoView;
  // What the browser does with a row it is asked to centre: the thread ends up where the row is.
  Element.prototype.scrollIntoView = function () {
    g.top = Math.max(0, Math.min(g.jumpTo, maxTop()));
  };
  const live: Array<() => void> = [];
  class Observer {
    private cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe(): void {
      live.push(this.cb);
    }
    disconnect(): void {
      const i = live.indexOf(this.cb);
      if (i >= 0) live.splice(i, 1);
    }
  }
  (globalThis as Record<string, unknown>).ResizeObserver = Observer;
  return {
    g,
    maxTop,
    report: () => live.forEach(cb => cb()),
    get observers() {
      return live.length;
    },
    restore: () => {
      Reflect.deleteProperty(globalThis, 'ResizeObserver');
      Element.prototype.scrollIntoView = sii;
      for (const key of ['scrollHeight', 'clientHeight', 'clientWidth', 'scrollTop'] as const) {
        if (saved[key]) Object.defineProperty(proto, key, saved[key]);
        else delete (proto as unknown as Record<string, unknown>)[key];
      }
    },
  };
}

let env: ReturnType<typeof install> | undefined;
afterEach(() => {
  rtl.cleanup();
  env?.restore();
  env = undefined;
});

/** The jump the page makes to a search hit. */
const jump = (row: Element): void => {
  api!.showRow(row);
};

/** What a browser raises after a commit: the scroll event of a thread that moved, then the observer's report. */
const frame = (el: Element): void => {
  rtl.fireEvent.scroll(el);
  env!.report();
};

test('a row the page scrolls to stays on screen when the box changes before the scroll event of the jump', () => {
  env = install();
  const { render, screen } = rtl;
  render(createElement(Room, { chatId: 'A', open: true })); // the restore pins the thread at its bottom
  const el = screen.getByTestId('thread');
  assert.equal(el.scrollTop, env.maxTop(), 'the chat did not open at its bottom');
  frame(el); // the first frame: the pin's own event and the observer's first report

  env.g.jumpTo = 1000;
  jump(screen.getByTestId('row')); // a search hit: the thread is taken to the row
  assert.equal(el.scrollTop, 1000);
  env.g.client -= 40; // the draft of the chat entered takes two more lines, in the same task
  frame(el);
  assert.equal(el.scrollTop, 1000, `the thread was taken back to ${el.scrollTop}, away from the row`);
});

test('a row the page scrolls to stays on screen when the thread loses the width of a scrollbar', () => {
  env = install();
  const { render, screen } = rtl;
  render(createElement(Room, { chatId: 'A', open: true }));
  const el = screen.getByTestId('thread');
  frame(el);

  env.g.jumpTo = 1000;
  jump(screen.getByTestId('row'));
  env.g.width -= SCROLLBAR; // the browser lays the thread out with its scrollbar once the rows are there
  frame(el);
  assert.equal(el.scrollTop, 1000, `the thread was taken back to ${el.scrollTop}, away from the row`);
});

test('a thread the page scrolled to its last row follows its box from there', () => {
  env = install();
  const { render, screen } = rtl;
  render(createElement(Room, { chatId: 'A', open: true }));
  const el = screen.getByTestId('thread');
  frame(el);

  env.g.jumpTo = env.maxTop() - 10; // the newest message: within the distance that counts as the bottom
  jump(screen.getByTestId('row'));
  env.g.client -= 40;
  frame(el);
  assert.equal(el.scrollTop, env.maxTop(), 'a thread at its bottom did not follow its box after the jump');
});

test('a thread pinned in the commit that mounted its container follows a box change that comes before its first look', () => {
  env = install();
  const { render, screen } = rtl;
  const view = render(createElement(Room, { chatId: 'A', open: true }));
  const { rerender } = view;
  frame(screen.getByTestId('thread'));
  rerender(createElement(Room, { chatId: 'A', open: false })); // the room closes
  assert.ok(view.container.querySelector('[data-testid="thread"]') === null, 'the room is still open');

  rerender(createElement(Room, { chatId: 'A', open: true })); // opened again: a new container, pinned by the restore
  const el = screen.getByTestId('thread');
  assert.equal(el.scrollTop, env.maxTop());
  env.g.client -= 40; // the draft of the chat arrives in the next commit and grows the composer
  frame(el);
  assert.equal(el.scrollTop, env.maxTop(), 'the newest message went under the composer');
});

test('a thread pinned in the commit that mounted its container follows a width change that comes before its first look', () => {
  env = install();
  const { render, screen } = rtl;
  const { rerender } = render(createElement(Room, { chatId: 'A', open: true }));
  frame(screen.getByTestId('thread'));
  rerender(createElement(Room, { chatId: 'A', open: false }));
  rerender(createElement(Room, { chatId: 'A', open: true }));
  const el = screen.getByTestId('thread');
  env.g.width -= SCROLLBAR;
  frame(el);
  assert.equal(el.scrollTop, env.maxTop(), 'the newest message left the bottom of the thread');
});

test('a container looked at for the first time without a pin is only recorded, and a reader further back stays where they are', () => {
  env = install();
  const { render, screen, fireEvent } = rtl;
  const { rerender } = render(createElement(Room, { chatId: 'A', open: true }));
  let el = screen.getByTestId('thread');
  frame(el);
  el.scrollTop = 3000; // the reader goes back in the thread
  fireEvent.scroll(el);
  rerender(createElement(Room, { chatId: 'A', open: false }));
  rerender(createElement(Room, { chatId: 'A', open: true })); // the chat comes back at the spot the reader left
  el = screen.getByTestId('thread');
  assert.equal(el.scrollTop, 3000, 'the saved spot was not restored');
  env.g.client -= 40;
  frame(el);
  assert.equal(el.scrollTop, 3000, 'a reader further back was taken to the bottom');
});

test('a pinned thread follows a change of width alone, and a reader further back does not', () => {
  env = install();
  const { render, screen, fireEvent } = rtl;
  render(createElement(Room, { chatId: 'A', open: true }));
  const el = screen.getByTestId('thread');
  frame(el);
  env.g.width -= SCROLLBAR; // a scrollbar appears: the height does not change, the content wraps onto more lines
  frame(el);
  assert.equal(el.scrollTop, env.maxTop(), 'the thread did not follow a change of width');

  el.scrollTop = 3000;
  fireEvent.scroll(el);
  env.g.width += SCROLLBAR;
  frame(el);
  assert.equal(el.scrollTop, 3000, 'a reader further back was moved by a change of width');
});
