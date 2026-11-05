import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const STATS = {
  timeSeries: [
    { timestamp: '2026-11-04 10:00:00', sent: 3, received: 5 },
    { timestamp: '2026-11-04 11:00:00', sent: 2, received: 1 },
  ],
  byType: { text: 6, image: 3, location: 2 },
  topChats: [{ chatId: '15551112222@c.us', chatName: 'Alice', messageCount: 4 }],
};

let rtl: typeof import('@testing-library/react');
let DashboardCharts: (typeof import('./DashboardCharts.tsx'))['DashboardCharts'];
let queryClient: QueryClient | undefined;

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      this.cb([{ target, contentRect: { width: 400, height: 260 } } as ResizeObserverEntry], this as never);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  globalThis.fetch = (() => Promise.resolve(jsonResponse(STATS))) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ DashboardCharts } = await import('./DashboardCharts.tsx'));
});

afterEach(async () => {
  await rtl.waitFor(() => assert.equal(queryClient?.isFetching() ?? 0, 0));
  rtl.cleanup();
  queryClient?.clear();
  queryClient = undefined;
});

test('every chart legend label uses the theme text color', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(DashboardCharts)),
  );
  await rtl.screen.findByText('Messages by type');
  await rtl.waitFor(() => assert.ok(container.querySelectorAll('.recharts-legend-item-text').length >= 5));

  for (const label of container.querySelectorAll<HTMLElement>('.recharts-legend-item-text')) {
    assert.equal(label.style.color, 'var(--text-secondary)', label.textContent ?? '');
  }
});

test('chart tooltip labels and items use theme text on the theme surface', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { container } = rtl.render(
    createElement(QueryClientProvider, { client: queryClient }, createElement(DashboardCharts)),
  );
  await rtl.screen.findByText('Messages by type');
  const wrapper = container.querySelector<HTMLElement>('.chart-wide .recharts-wrapper')!;
  Object.defineProperty(wrapper, 'offsetWidth', { value: 400 });
  Object.defineProperty(wrapper, 'offsetHeight', { value: 260 });
  wrapper.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 400,
    bottom: 260,
    width: 400,
    height: 260,
    toJSON() {},
  });
  rtl.fireEvent.mouseMove(wrapper, { clientX: 160, clientY: 100 });
  await rtl.waitFor(() => assert.ok(wrapper.querySelector('.recharts-tooltip-item')));
  const tooltip = wrapper.querySelector<HTMLElement>('.recharts-default-tooltip')!;
  assert.equal(tooltip.style.backgroundColor, 'var(--bg-card)');
  assert.equal(tooltip.style.border, '1px solid var(--border)');
  assert.equal(tooltip.querySelector<HTMLElement>('.recharts-tooltip-label')!.style.color, 'var(--text-primary)');
  for (const item of tooltip.querySelectorAll<HTMLElement>('.recharts-tooltip-item')) {
    assert.equal(item.style.color, 'var(--text-primary)');
  }
});
