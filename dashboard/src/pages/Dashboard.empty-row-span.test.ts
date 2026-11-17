// The sessions table lays every row out as a five-track grid. The row that says there are no sessions holds only text,
// which becomes an anonymous grid item in the first track (140px) and wraps inside it ("No sessions found. / Create
// one to get / started.") on the first screen of a fresh install. The text has to get the width of the row: the row
// stops being a grid, has a single track, or the item that holds the text spans every track.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { decl, readRules } from '../test-helpers/css-rules.ts';

let rtl: typeof import('@testing-library/react');
let Dashboard: (typeof import('./Dashboard.tsx'))['Dashboard'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const ok = path === '/api/sessions';
    return Promise.resolve(
      new Response(JSON.stringify(ok ? [] : { message: 'refused' }), {
        status: ok ? 200 : 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  window.sessionStorage.setItem('openwa_user_role', 'viewer');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Dashboard } = await import('./Dashboard.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

// What the cascade gives `el` for `prop`: its inline style, else the top-level rule of Dashboard.css with the highest
// specificity (the later one on a tie) whose last compound selector names only classes the element has.
const rules = readRules(new URL('./Dashboard.css', import.meta.url)).filter(r => r.media === '');
const weight = (selector: string): number =>
  (selector.match(/#[\w-]+/g) ?? []).length * 10_000 +
  (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length * 100 +
  (selector.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
const applies = (selector: string, el: Element): boolean => {
  const last =
    selector
      .trim()
      .split(/\s+|>|\+|~/)
      .filter(Boolean)
      .pop() ?? '';
  if (last.includes(':')) return false;
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
  return classes.length > 0 && classes.every(c => el.classList.contains(c));
};
const effective = (el: Element, prop: string): string | undefined => {
  const inline = decl(el.getAttribute('style') ?? '', prop);
  if (inline !== undefined) return inline;
  let best: { w: number; value: string } | undefined;
  for (const rule of rules) {
    const value = decl(rule.body, prop);
    if (value === undefined) continue;
    for (const selector of rule.selectors) {
      if (applies(selector, el) && (best === undefined || weight(selector) >= best.w)) {
        best = { w: weight(selector), value };
      }
    }
  }
  return best?.value;
};

const isGrid = (el: Element): boolean => /^(inline-)?grid$/.test(effective(el, 'display') ?? '');
const tracks = (el: Element): number => {
  const value = effective(el, 'grid-template-columns');
  if (value === undefined) return 1;
  const repeat = /^repeat\(\s*(\d+|[a-z-]+)\s*,/.exec(value);
  if (repeat) return /^\d+$/.test(repeat[1]) ? Number(repeat[1]) : 2;
  return value.split(/\s+(?![^(]*\))/).length;
};
const spansAll = (item: Element, grid: Element): boolean => {
  const n = tracks(grid);
  const start = effective(item, 'grid-column-start');
  const end = effective(item, 'grid-column-end');
  const placed = (effective(item, 'grid-column') ?? (start && end ? `${start} / ${end}` : ''))
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
  return ['1 / -1', `1 / ${n + 1}`, `1 / span ${n}`, `span ${n}`].includes(placed);
};

// Does the text get the width of the row? A text node that is a direct child of a grid is an anonymous item and cannot
// take a grid-column; otherwise the nearest grid ancestor inside the table places the element that holds the text.
function textFillsRow(host: Element, boundary: Element): boolean {
  const ownText = [...host.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim() !== '');
  if (ownText && isGrid(host)) return tracks(host) === 1;
  for (let node = host; node !== boundary && node.parentElement; node = node.parentElement) {
    if (isGrid(node.parentElement)) return tracks(node.parentElement) === 1 || spansAll(node, node.parentElement);
  }
  return true;
}

// The first element in the sessions section, outside its headings, that carries text of its own.
function messageHost(section: Element): Element | undefined {
  const walker = document.createTreeWalker(section, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && (node.textContent ?? '').trim() !== '' && !parent.closest('.section-header, .table-header')) {
      return parent;
    }
  }
  return undefined;
}

test('the text of the empty sessions row gets the width of the row, not the first 140px track', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleProvider,
        null,
        createElement(ToastProvider, null, createElement(MemoryRouter, null, createElement(Dashboard))),
      ),
    ),
  );
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching(), 0));
  const section = container.querySelector('.sessions-section')!;
  assert.ok(section, 'the sessions section moved');
  const host = messageHost(section);
  assert.ok(host, 'a gateway with no session shows no message');
  assert.ok(
    textFillsRow(host, host.closest('.sessions-table') ?? section),
    'the row is a grid of several tracks and its text sits in the first one',
  );
});
