import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let ErrorBoundary: (typeof import('./ErrorBoundary.tsx'))['ErrorBoundary'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ ErrorBoundary } = await import('./ErrorBoundary.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

test('ErrorBoundary clears a caught render failure when resetKey changes', () => {
  let shouldThrow = true;
  function ProblemView() {
    if (shouldThrow) throw new Error('boom');
    return createElement('div', null, 'Recovered page');
  }

  const origError = console.error;
  console.error = () => {};
  try {
    const view = rtl.render(
      createElement(ErrorBoundary, { resetKey: '/broken', children: createElement(ProblemView) }),
    );
    assert.ok(rtl.screen.getByRole('button', { name: /reload/i }));
    const container = view.container.firstElementChild as HTMLElement;
    assert.equal(container.style.minHeight, '60vh');

    shouldThrow = false;
    view.rerender(createElement(ErrorBoundary, { resetKey: '/healthy', children: createElement(ProblemView) }));
    assert.ok(rtl.screen.getByText('Recovered page'));
    assert.equal(rtl.screen.queryByRole('button', { name: /reload/i }), null);
  } finally {
    console.error = origError;
  }
});
