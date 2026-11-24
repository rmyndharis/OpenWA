import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let rtl: typeof import('@testing-library/react');
let RoleContext: (typeof import('../hooks/useRole.tsx'))['RoleContext'];
let MessageTester: (typeof import('./MessageTester.tsx'))['MessageTester'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  window.sessionStorage.setItem('openwa_api_key_id', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleContext } = await import('../hooks/useRole.tsx'));
  ({ MessageTester } = await import('./MessageTester.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

test('batch polling skips overlapping interval ticks while getBatchStatus is in flight', async t => {
  let statusCalls = 0;
  let resolveFirstPoll!: (res: Response) => void;

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/auth/session')) {
      return Promise.resolve(json({ valid: true, role: 'operator', scoped: false, apiKeyId: 'test-key' }));
    }
    if (url.endsWith('/api/sessions')) {
      return Promise.resolve(json([{ id: 's1', name: 'Main', status: 'ready', phone: '15550000000' }]));
    }
    if (url.endsWith('/messages/send-bulk')) {
      return Promise.resolve(json({ batchId: 'b1', status: 'pending', totalMessages: 1 }, 202));
    }
    if (url.endsWith('/messages/batch/b1')) {
      statusCalls += 1;
      if (statusCalls === 1) {
        return new Promise<Response>(resolve => {
          resolveFirstPoll = resolve;
        });
      }
      return Promise.resolve(
        json({
          batchId: 'b1',
          status: 'completed',
          progress: { total: 1, sent: 1, failed: 0, pending: 0, cancelled: 0 },
          results: [],
        }),
      );
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const roleValue = {
    role: 'operator' as const,
    setRole: () => {},
    isAdmin: false,
    isOperator: true,
    isViewer: false,
    canWrite: true,
    engineType: 'baileys',
    setEngineType: () => {},
    scoped: false,
    setScoped: () => {},
  };
  const view = rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RoleContext.Provider, { value: roleValue }, createElement(MessageTester)),
    ),
  );
  await rtl.screen.findByRole('option', { name: /Main/ });

  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Bulk' }));
    const bulkInput = view.container.querySelector('#mt-11') as HTMLTextAreaElement;
    const msgInput = view.container.querySelector('#mt-12') as HTMLTextAreaElement;
    rtl.fireEvent.change(bulkInput, { target: { value: '15550000001' } });
    rtl.fireEvent.change(msgInput, { target: { value: 'Hello batch' } });
    const sendBtn = rtl.screen.getByRole('button', { name: 'Send Message' });
    rtl.fireEvent.click(sendBtn);
    await rtl.screen.findByRole('button', { name: 'Cancel Batch' });

    await rtl.act(async () => {
      t.mock.timers.tick(2000);
      await Promise.resolve();
    });
    assert.equal(statusCalls, 1);

    await rtl.act(async () => {
      t.mock.timers.tick(2000);
      await Promise.resolve();
    });
    assert.equal(statusCalls, 1, 'overlapping poll fired while request was still in flight');

    await rtl.act(async () => {
      resolveFirstPoll(
        json({
          batchId: 'b1',
          status: 'processing',
          progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
          results: [],
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await rtl.act(async () => {
      t.mock.timers.tick(2000);
      await Promise.resolve();
    });
    assert.equal(statusCalls, 2);
  } finally {
    t.mock.timers.reset();
    rtl.cleanup();
    client.clear();
  }
});
