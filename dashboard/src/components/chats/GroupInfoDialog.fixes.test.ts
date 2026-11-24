import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, Session } from '../../services/api.ts';

let rtl: typeof import('@testing-library/react');
let RoleContext: (typeof import('../../hooks/useRole.tsx'))['RoleContext'];
let ToastProvider: (typeof import('../Toast.tsx'))['ToastProvider'];
let GroupInfoDialog: (typeof import('./GroupInfoDialog.tsx'))['default'];

const SESSION: Session = {
  id: 's1',
  name: 'Main',
  status: 'ready',
  phone: '15550000000',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const GROUP: Chat = {
  id: 'g1@g.us',
  name: 'Team',
  isGroup: true,
  kind: 'group',
  unreadCount: 0,
  timestamp: 1_700_000_000,
  lastMessage: '',
  archived: false,
  pinned: false,
  muted: false,
};

let queryClient!: QueryClient;
const realFetch = globalThis.fetch;

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleContext } = await import('../../hooks/useRole.tsx'));
  ({ ToastProvider } = await import('../Toast.tsx'));
  ({ default: GroupInfoDialog } = await import('./GroupInfoDialog.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  queryClient?.clear();
});

after(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderDialog(onClose = () => {}) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleContext.Provider,
        { value: roleValue },
        createElement(
          ToastProvider,
          null,
          createElement(GroupInfoDialog, {
            session: SESSION,
            group: GROUP,
            onClose,
            onRenamed: () => {},
          }),
        ),
      ),
    ),
  );
}

test('GroupInfoDialog wires ARIA tabpanel linkage, keeps draft on failed refresh, isolates member spinner, and skips late FileReader on unmount', async () => {
  let failGroupFetch = false;
  let releasePromote!: () => void;
  const promoteGate = new Promise<void>(resolve => {
    releasePromote = resolve;
  });

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/picture')) return Promise.resolve(json({ url: null }));
    if (url.includes('/participants/promote')) {
      return promoteGate.then(() => json({ results: [{ id: '15551111111@c.us', status: 200 }] }));
    }
    if (url.includes('/groups/')) {
      if (failGroupFetch) return Promise.resolve(json({ message: 'offline' }, 502));
      return Promise.resolve(
        json({
          id: GROUP.id,
          name: 'Team',
          description: 'Orig',
          locked: false,
          participants: [
            { id: '15550000000@c.us', number: '15550000000', isAdmin: true, isSuperAdmin: false },
            { id: '15551111111@c.us', number: '15551111111', name: 'Alice', isAdmin: false, isSuperAdmin: false },
          ],
        }),
      );
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  const view = renderDialog();
  const nameInput = (await rtl.screen.findByLabelText(/Group Name/i)) as HTMLInputElement;

  const infoTab = rtl.screen.getByRole('tab', { name: 'Info' });
  const participantsTab = rtl.screen.getByRole('tab', { name: 'Participants' });
  const infoPanel = rtl.screen.getByRole('tabpanel');
  assert.equal(infoTab.getAttribute('aria-controls'), infoPanel.id);
  assert.equal(infoPanel.getAttribute('aria-labelledby'), infoTab.id);

  rtl.fireEvent.change(nameInput, { target: { value: 'Unsaved Draft' } });
  failGroupFetch = true;
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Refresh' }));
  await rtl.waitFor(() => assert.ok(rtl.screen.getByText('Could not load the group info')));
  assert.equal((document.querySelector('.group-info-form input') as HTMLInputElement).value, 'Unsaved Draft');

  failGroupFetch = false;
  rtl.fireEvent.click(participantsTab);
  const partPanel = rtl.screen.getByRole('tabpanel');
  assert.equal(participantsTab.getAttribute('aria-controls'), partPanel.id);
  assert.equal(partPanel.getAttribute('aria-labelledby'), participantsTab.id);

  const promoteBtn = rtl.screen.getByRole('button', { name: /Make admin: Alice/i });
  const removeBtn = rtl.screen.getByRole('button', { name: /Remove: Alice/i });
  const refreshBtn = rtl.screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
  rtl.fireEvent.click(promoteBtn);

  await rtl.waitFor(() => assert.ok(promoteBtn.querySelector('.animate-spin')));
  assert.equal(removeBtn.querySelector('.animate-spin'), null);
  assert.equal((infoTab as HTMLButtonElement).disabled, true);
  assert.equal((participantsTab as HTMLButtonElement).disabled, true);
  assert.equal(refreshBtn.disabled, true);
  rtl.fireEvent.click(infoTab);
  assert.equal(participantsTab.getAttribute('aria-selected'), 'true');

  await rtl.act(async () => {
    releasePromote();
    await promoteGate;
  });
  await rtl.waitFor(() => assert.equal((infoTab as HTMLButtonElement).disabled, false));

  // Unmount while a FileReader picture read is in flight should not call URL.createObjectURL late.
  const origFileReader = globalThis.FileReader;
  const origCreateObjectUrl = URL.createObjectURL;
  let createCalls = 0;
  const readers: Array<{ onload: ((event: ProgressEvent<FileReader>) => void) | null }> = [];
  URL.createObjectURL = () => {
    createCalls += 1;
    return 'blob:test';
  };
  globalThis.FileReader = class {
    onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
    readAsDataURL() {
      readers.push(this);
    }
  } as unknown as typeof FileReader;

  try {
    rtl.fireEvent.click(infoTab);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['abc'], 'photo.png', { type: 'image/png' });
    rtl.fireEvent.change(fileInput, { target: { files: [file] } });
    assert.equal(readers.length, 1);
    assert.ok(readers[0].onload);
    view.unmount();
    readers[0].onload?.({
      target: { result: 'data:image/png;base64,YWJj' },
    } as unknown as ProgressEvent<FileReader>);
    assert.equal(createCalls, 0);
  } finally {
    globalThis.FileReader = origFileReader;
    URL.createObjectURL = origCreateObjectUrl;
  }
});

test('GroupInfoDialog locks tabs, Refresh, and Cancel while saving group info', async () => {
  let releaseSubject!: () => void;
  const subjectGate = new Promise<void>(resolve => {
    releaseSubject = resolve;
  });
  let closeCalls = 0;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/picture')) return Promise.resolve(json({ url: null }));
    if (url.endsWith('/subject') && method === 'PUT') {
      return subjectGate.then(() => json({ success: true }));
    }
    if (url.includes('/groups/')) {
      return Promise.resolve(
        json({
          id: GROUP.id,
          name: 'Team',
          description: 'Orig',
          locked: false,
          participants: [{ id: '15550000000@c.us', number: '15550000000', isAdmin: true, isSuperAdmin: false }],
        }),
      );
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  renderDialog(() => {
    closeCalls += 1;
  });
  const nameInput = (await rtl.screen.findByLabelText(/Group Name/i)) as HTMLInputElement;
  rtl.fireEvent.change(nameInput, { target: { value: 'Renamed Team' } });

  const saveBtn = rtl.screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
  const cancelBtn = rtl.screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
  const infoTab = rtl.screen.getByRole('tab', { name: 'Info' }) as HTMLButtonElement;
  const participantsTab = rtl.screen.getByRole('tab', { name: 'Participants' }) as HTMLButtonElement;
  const refreshBtn = rtl.screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;

  rtl.fireEvent.click(saveBtn);
  await rtl.waitFor(() => assert.equal(cancelBtn.disabled, true));
  assert.equal(infoTab.disabled, true);
  assert.equal(participantsTab.disabled, true);
  assert.equal(refreshBtn.disabled, true);

  rtl.fireEvent.click(cancelBtn);
  rtl.fireEvent.click(participantsTab);
  rtl.fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(closeCalls, 0);
  assert.equal(infoTab.getAttribute('aria-selected'), 'true');

  await rtl.act(async () => {
    releaseSubject();
    await subjectGate;
  });
  await rtl.waitFor(() => assert.equal(participantsTab.disabled, false));
  assert.equal(infoTab.disabled, false);
  assert.equal(refreshBtn.disabled, false);
  assert.equal(cancelBtn.disabled, false);
});

test('GroupInfoDialog locks add-member input and suppresses rapid double Enter submits', async () => {
  let checkCalls = 0;
  let releaseCheck!: () => void;
  const checkGate = new Promise<void>(resolve => {
    releaseCheck = resolve;
  });

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/picture')) return Promise.resolve(json({ url: null }));
    if (url.includes('/contacts/check/')) {
      checkCalls += 1;
      return checkGate.then(() => json({ exists: true, whatsappId: '628123456789@c.us' }));
    }
    if (url.endsWith('/participants') && method === 'POST') {
      return Promise.resolve(json({ results: [{ id: '628123456789@c.us', success: true }] }));
    }
    if (url.includes('/groups/')) {
      return Promise.resolve(
        json({
          id: GROUP.id,
          name: 'Team',
          description: 'Orig',
          locked: false,
          participants: [{ id: '15550000000@c.us', number: '15550000000', isAdmin: true, isSuperAdmin: false }],
        }),
      );
    }
    return Promise.resolve(json([]));
  }) as typeof fetch;

  renderDialog();
  rtl.fireEvent.click(await rtl.screen.findByRole('tab', { name: 'Participants' }));

  const telInput = (await rtl.screen.findByPlaceholderText('Add a number with country code')) as HTMLInputElement;
  const addBtn = rtl.screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
  const infoTab = rtl.screen.getByRole('tab', { name: 'Info' }) as HTMLButtonElement;
  const refreshBtn = rtl.screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
  const form = telInput.closest('form')!;

  rtl.fireEvent.change(telInput, { target: { value: '628123456789' } });
  rtl.fireEvent.submit(form);
  rtl.fireEvent.submit(form);

  await rtl.waitFor(() => assert.equal(telInput.disabled, true));
  assert.equal(checkCalls, 1);
  assert.equal(addBtn.disabled, true);
  assert.equal(infoTab.disabled, true);
  assert.equal(refreshBtn.disabled, true);

  await rtl.act(async () => {
    releaseCheck();
    await checkGate;
  });
  await rtl.waitFor(() => assert.equal(telInput.disabled, false));
  assert.equal(telInput.value, '');
  assert.equal(infoTab.disabled, false);
  assert.equal(refreshBtn.disabled, false);
});
