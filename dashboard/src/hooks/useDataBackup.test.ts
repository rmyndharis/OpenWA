// The backup export saves a file with every integration instance's secrets in plaintext, so an export
// still in flight when the operator signs out must not save it over the login form. The replace-all
// import asks before it replaces anything and again before it stops live engines.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, StrictMode, type ReactNode } from 'react';
import type { useDataBackup as useDataBackupFn } from './useDataBackup.ts';
import type { ToastContext as ToastContextType } from './useToast.ts';

type RTL = typeof import('@testing-library/react');

let rtl: RTL;
let useDataBackup: typeof useDataBackupFn;
let ToastContext: typeof ToastContextType;

// Answer of the export route, per test; a pending one is an export still in flight.
let exportAnswer: Promise<Response> = new Promise(() => {});
const saved: HTMLAnchorElement[] = [];
// Answers of the import route in order, and what it was sent.
let importAnswers: Array<Response | Promise<Response>> = [];
const importKeys: Array<string | null> = [];
const importBodies: Array<Record<string, unknown>> = [];
const toastLog: Array<{ kind: string; title: string; detail?: string }> = [];
let i18nT: (key: string, options?: Record<string, unknown>) => string;
let createElementOriginal: typeof document.createElement;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function dump(extra: Record<string, unknown> = {}): Response {
  return json({ exportedAt: '2026-10-09T10:00:00.000Z', dataDbType: 'sqlite', tables: {}, counts: {}, ...extra });
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  createElementOriginal = document.createElement;
  const { i18nReady, default: i18n } = await import('../i18n/index.ts');
  await i18nReady;
  i18nT = (key, options) => i18n.t(key, options) as string;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/infra/import-data')) {
      importKeys.push((init?.headers as Record<string, string> | undefined)?.['X-API-Key'] ?? null);
      importBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Promise.resolve(importAnswers.shift() ?? json({ imported: true, counts: {}, warnings: [] }, 201));
    }
    return url.endsWith('/api/infra/export-data')
      ? exportAnswer
      : Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
  };
  URL.createObjectURL = () => 'blob:backup';
  URL.revokeObjectURL = () => {};
  rtl = await import('@testing-library/react');
  ({ useDataBackup } = await import('./useDataBackup.ts'));
  ({ ToastContext } = await import('./useToast.ts'));
});

afterEach(() => {
  rtl.cleanup();
  saved.length = 0;
  exportAnswer = new Promise(() => {});
  window.sessionStorage.removeItem('openwa_api_key');
  document.createElement = createElementOriginal;
  importAnswers = [];
  importBodies.length = 0;
  importKeys.length = 0;
  toastLog.length = 0;
});

function renderBackup(strict = false) {
  const noop = () => {};
  const record = (kind: string) => (title: string, detail?: string) => void toastLog.push({ kind, title, detail });
  const value = {
    toasts: [],
    addToast: noop,
    removeToast: noop,
    success: record('success'),
    error: record('error'),
    warning: record('warning'),
    info: record('info'),
  };
  const wrapper = ({ children }: { children: ReactNode }) => {
    const wrapped = createElement(ToastContext.Provider, { value }, children);
    return strict ? createElement(StrictMode, null, wrapped) : wrapped;
  };
  // Record each file the hook saves by capturing the link it clicks, instead of letting jsdom navigate.
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = createElementOriginal.call(document, tag, options);
    if (tag === 'a') (element as HTMLAnchorElement).click = () => void saved.push(element as HTMLAnchorElement);
    return element;
  }) as typeof document.createElement;
  return rtl.renderHook(() => useDataBackup(), { wrapper });
}

test('an export that completes while signed in saves the backup file', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  exportAnswer = Promise.resolve(dump());
  const { result } = renderBackup();
  await rtl.act(() => result.current.exportBackup());
  assert.deepEqual(
    saved.map(link => link.download),
    ['openwa-backup-2026-10-09.json'],
  );
});

test('an export answered after sign-out saves no file', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  let answer!: (response: Response) => void;
  exportAnswer = new Promise<Response>(resolve => (answer = resolve));
  const { result } = renderBackup();
  const exporting = rtl.act(() => result.current.exportBackup());
  window.sessionStorage.removeItem('openwa_api_key');
  answer(dump());
  await exporting;
  assert.deepEqual(saved, [], 'a backup of the whole database was saved after the sign-out');
});

test('an export that dropped inline media warns that the archive restores without those attachments', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  exportAnswer = Promise.resolve(dump({ omittedInlineMedia: { messages: 2, messageBatches: 1 } }));
  const { result } = renderBackup();
  await rtl.act(() => result.current.exportBackup());
  assert.equal(saved.length, 1);
  assert.deepEqual(toastLog, [
    {
      kind: 'warning',
      title: i18nT('infrastructure.migration.exportPartialTitle'),
      detail: i18nT('infrastructure.migration.exportPartial', { count: 3 }),
    },
  ]);
});

// The import prompts go through window.confirm: record each message and answer from a script.
const backupFile = (body: unknown): File =>
  new File([typeof body === 'string' ? body : JSON.stringify(body)], 'b.json');

function answerConfirms(...answers: boolean[]): string[] {
  const asked: string[] = [];
  window.confirm = (message?: string) => {
    asked.push(String(message));
    return answers.shift() ?? false;
  };
  return asked;
}

test('an import the operator declines at the row-count prompt sends nothing', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  const asked = answerConfirms(false);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }, { id: 'b' }] } })));
  assert.deepEqual(asked, [i18nT('infrastructure.migration.importConfirm', { rows: 2 })]);
  assert.equal(importBodies.length, 0);
  assert.equal(result.current.migrating, false);
});

test('a file that is not JSON, or holds no tables, is refused before any prompt', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  const asked = answerConfirms(true, true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile('not json')));
  await rtl.act(() => result.current.importBackup(backupFile({ exportedAt: 'x' })));
  assert.deepEqual(asked, []);
  assert.equal(importBodies.length, 0);
  assert.deepEqual(
    toastLog.map(toast => [toast.kind, toast.detail]),
    [
      ['error', i18nT('infrastructure.migration.invalidFile')],
      ['error', i18nT('infrastructure.migration.invalidFile')],
    ],
  );
});

test('a confirmed import posts the tables and reports success', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  answerConfirms(true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.deepEqual(importBodies, [{ tables: { sessions: [{ id: 'a' }] } }]);
  assert.deepEqual(toastLog, [
    { kind: 'success', title: i18nT('infrastructure.migration.importOk'), detail: undefined },
  ]);
});

const orphanRefusal = (): Response =>
  json(
    {
      statusCode: 409,
      message: 'Stop these sessions first: s1',
      error: 'Conflict',
      code: 'IMPORT_WOULD_ORPHAN_ENGINES',
    },
    409,
  );

test('an orphan-engine refusal asks, and retries once with stopOrphans only when the operator agrees', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers = [orphanRefusal()];
  const asked = answerConfirms(true, true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.equal(asked.length, 2);
  assert.equal(asked[1], 'Stop these sessions first: s1');
  assert.deepEqual(
    importBodies.map(body => body.stopOrphans),
    [undefined, true],
  );
  assert.equal(toastLog.at(-1)?.kind, 'success');
});

test('declining the orphan-engine prompt leaves the engines and the data alone', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers = [orphanRefusal()];
  answerConfirms(true, false);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.equal(importBodies.length, 1);
  assert.deepEqual(toastLog, [
    { kind: 'error', title: i18nT('infrastructure.migration.importFailed'), detail: 'Stop these sessions first: s1' },
  ]);
});

test('a conflict with another code, or none, is never offered the destructive retry', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers = [
    json({ statusCode: 409, message: 'An import is already running', code: 'IMPORT_ALREADY_RUNNING' }, 409),
    json({ statusCode: 409, message: 'Conflict' }, 409),
  ];
  const asked = answerConfirms(true, true, true, true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.equal(asked.length, 2, 'only the two row-count prompts');
  assert.equal(importBodies.length, 2);
  assert.deepEqual(
    toastLog.map(toast => toast.kind),
    ['error', 'error'],
  );
});

test('a backup over the request body cap gets the actionable message, not a bare Payload Too Large', async () => {
  window.sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers = [json({ statusCode: 413, message: 'Payload Too Large' }, 413)];
  answerConfirms(true);
  const { result } = renderBackup();
  await rtl.act(() => result.current.importBackup(backupFile({ tables: { sessions: [{ id: 'a' }] } })));
  assert.deepEqual(toastLog, [
    {
      kind: 'error',
      title: i18nT('infrastructure.migration.importFailed'),
      detail: i18nT('infrastructure.migration.importTooLarge'),
    },
  ]);
});

function heldValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function selectedFile(text: Promise<string>): File {
  const file = backupFile('');
  Object.defineProperty(file, 'text', { value: () => text });
  return file;
}

async function importTurn(action: () => void): Promise<void> {
  await rtl.act(async () => {
    action();
    for (let i = 0; i < 16; i++) await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

const retirements = ['signed-out', 'replacement-key', 'unmounted', 'same-key-relogin'] as const;
function retireImport(view: ReturnType<typeof renderBackup>, kind: (typeof retirements)[number]) {
  if (kind === 'signed-out') sessionStorage.removeItem('openwa_api_key');
  if (kind === 'replacement-key') sessionStorage.setItem('openwa_api_key', 'key-b');
  if (kind === 'unmounted') view.unmount();
  if (kind === 'same-key-relogin') {
    view.unmount();
    sessionStorage.removeItem('openwa_api_key');
    sessionStorage.setItem('openwa_api_key', 'key-a');
    renderBackup();
  }
}

// A restore already sent is reported to whoever is on the page, unless another key has taken over.
const reportedAfter = (kind: (typeof retirements)[number]) =>
  kind === 'unmounted' || kind === 'same-key-relogin' ? 1 : 0;

const importBody = JSON.stringify({ tables: { dummyRows: [{ label: 'selected' }] } });
const importEffects = (prompts: string[]) => ({
  prompts: prompts.length,
  requests: importBodies.length,
  toasts: toastLog.length,
});

for (const kind of retirements) {
  test(`a file read retired by ${kind} causes no prompt, request or toast`, async () => {
    sessionStorage.setItem('openwa_api_key', 'key-a');
    const read = heldValue<string>(),
      view = renderBackup(),
      prompts = answerConfirms(true, true);
    await importTurn(() => {
      void view.result.current.importBackup(selectedFile(read.promise));
    });
    await importTurn(() => retireImport(view, kind));
    await importTurn(() => read.resolve(importBody));
    assert.deepEqual(importEffects(prompts), { prompts: 0, requests: 0, toasts: 0 });
  });
  test(`a failed file read retired by ${kind} reports no stale error`, async () => {
    sessionStorage.setItem('openwa_api_key', 'key-a');
    const read = heldValue<string>(),
      view = renderBackup(),
      prompts = answerConfirms(true, true);
    await importTurn(() => {
      void view.result.current.importBackup(selectedFile(read.promise));
    });
    await importTurn(() => retireImport(view, kind));
    await importTurn(() => read.reject(new Error('Dummy file read failure')));
    assert.deepEqual(importEffects(prompts), { prompts: 0, requests: 0, toasts: 0 });
  });
  test(`a refusal after ${kind} opens no orphan retry and is reported only to the same key`, async () => {
    sessionStorage.setItem('openwa_api_key', 'key-a');
    const answer = heldValue<Response>();
    importAnswers.push(answer.promise);
    const view = renderBackup(),
      prompts = answerConfirms(true, true);
    await importTurn(() => {
      void view.result.current.importBackup(backupFile(importBody));
    });
    assert.deepEqual(importEffects(prompts), { prompts: 1, requests: 1, toasts: 0 });
    assert.deepEqual(importKeys, ['key-a']);
    await importTurn(() => retireImport(view, kind));
    await importTurn(() => answer.resolve(orphanRefusal()));
    assert.deepEqual(importEffects(prompts), { prompts: 1, requests: 1, toasts: reportedAfter(kind) });
    assert.deepEqual(
      toastLog.map(entry => entry.kind),
      reportedAfter(kind) ? ['error'] : [],
    );
  });
  for (const status of [200, 503]) {
    test(`an import answered with ${status} after ${kind} is reported only to the same key`, async () => {
      sessionStorage.setItem('openwa_api_key', 'key-a');
      const answer = heldValue<Response>();
      importAnswers.push(answer.promise);
      const view = renderBackup(),
        prompts = answerConfirms(true);
      await importTurn(() => {
        void view.result.current.importBackup(backupFile(importBody));
      });
      assert.equal(importBodies.length, 1);
      await importTurn(() => retireImport(view, kind));
      await importTurn(() =>
        answer.resolve(
          status === 200 ? json({ imported: true, counts: {}, warnings: [] }) : json({ message: 'Dummy failure' }, 503),
        ),
      );
      assert.deepEqual(importEffects(prompts), { prompts: 1, requests: 1, toasts: reportedAfter(kind) });
    });
  }
}

for (const key of [null, '']) {
  test(`an import begun with ${key === null ? 'no' : 'an empty'} key reads and sends nothing`, async () => {
    if (key === null) sessionStorage.removeItem('openwa_api_key');
    else sessionStorage.setItem('openwa_api_key', key);
    let reads = 0;
    const file = backupFile(importBody);
    Object.defineProperty(file, 'text', {
      value: async () => {
        reads++;
        return importBody;
      },
    });
    const view = renderBackup(),
      prompts = answerConfirms(true);
    await importTurn(() => {
      void view.result.current.importBackup(file);
    });
    assert.deepEqual({ ...importEffects(prompts), reads }, { prompts: 0, requests: 0, toasts: 0, reads: 0 });
  });
}

test('a row confirmation cannot dispatch with a key changed while it was open', async () => {
  sessionStorage.setItem('openwa_api_key', 'key-a');
  const view = renderBackup();
  let prompts = 0;
  window.confirm = () => {
    prompts++;
    sessionStorage.setItem('openwa_api_key', 'key-b');
    return true;
  };
  await importTurn(() => {
    void view.result.current.importBackup(backupFile(importBody));
  });
  assert.equal(prompts, 1);
  assert.deepEqual(importBodies, []);
  assert.deepEqual(toastLog, []);
});

test('an orphan confirmation cannot retry with a key changed while it was open', async () => {
  sessionStorage.setItem('openwa_api_key', 'key-a');
  importAnswers.push(orphanRefusal());
  const view = renderBackup();
  let prompts = 0;
  window.confirm = () => {
    if (++prompts === 2) sessionStorage.setItem('openwa_api_key', 'key-b');
    return true;
  };
  await importTurn(() => {
    void view.result.current.importBackup(backupFile(importBody));
  });
  assert.equal(prompts, 2);
  assert.deepEqual(importKeys, ['key-a']);
  assert.equal(importBodies.length, 1);
  assert.deepEqual(toastLog, []);
});

for (const outcome of ['success', 'read-failure', 'invalid-json'] as const) {
  test(`an older selection ending with ${outcome} cannot replace the newer selection`, async () => {
    sessionStorage.setItem('openwa_api_key', 'key-a');
    const oldRead = heldValue<string>(),
      freshRead = heldValue<string>();
    const view = renderBackup(),
      prompts = answerConfirms(true, true);
    await importTurn(() => {
      void view.result.current.importBackup(selectedFile(oldRead.promise));
    });
    await importTurn(() => {
      void view.result.current.importBackup(selectedFile(freshRead.promise));
    });
    const fresh = { tables: { dummyRows: [{ label: 'newer' }] } };
    await importTurn(() => freshRead.resolve(JSON.stringify(fresh)));
    assert.deepEqual(importBodies, [fresh]);
    if (outcome === 'read-failure') await importTurn(() => oldRead.reject(new Error('Dummy old read failure')));
    else await importTurn(() => oldRead.resolve(outcome === 'invalid-json' ? 'not json' : importBody));
    assert.deepEqual(importBodies, [fresh]);
    assert.deepEqual(importEffects(prompts), { prompts: 1, requests: 1, toasts: 1 });
    assert.equal(toastLog[0].kind, 'success');
  });
}

test('an old response cannot clear the busy state of a newer file read', async () => {
  sessionStorage.setItem('openwa_api_key', 'key-a');
  const oldAnswer = heldValue<Response>(),
    freshRead = heldValue<string>();
  importAnswers.push(oldAnswer.promise);
  const view = renderBackup(),
    prompts = answerConfirms(true, false);
  await importTurn(() => {
    void view.result.current.importBackup(backupFile(importBody));
  });
  assert.equal(importBodies.length, 1);
  await importTurn(() => {
    void view.result.current.importBackup(selectedFile(freshRead.promise));
  });
  assert.equal(view.result.current.migrating, true);
  await importTurn(() => oldAnswer.resolve(json({ imported: true, counts: {}, warnings: [] })));
  assert.equal(view.result.current.migrating, true);
  assert.deepEqual(importEffects(prompts), { prompts: 1, requests: 1, toasts: 1 });
  await importTurn(() => freshRead.resolve(importBody));
  assert.equal(view.result.current.migrating, false);
  assert.deepEqual(importEffects(prompts), { prompts: 2, requests: 1, toasts: 1 });
});

test('a declined newer selection still retires an older file read', async () => {
  sessionStorage.setItem('openwa_api_key', 'key-a');
  const oldRead = heldValue<string>(),
    view = renderBackup(),
    prompts = answerConfirms(false, true);
  await importTurn(() => {
    void view.result.current.importBackup(selectedFile(oldRead.promise));
  });
  await importTurn(() => {
    void view.result.current.importBackup(backupFile(importBody));
  });
  assert.equal(view.result.current.migrating, false);
  await importTurn(() => oldRead.resolve(importBody));
  assert.deepEqual(importEffects(prompts), { prompts: 1, requests: 0, toasts: 0 });
});

test('an import remains usable after StrictMode effect replay', async () => {
  sessionStorage.setItem('openwa_api_key', 'key-a');
  const view = renderBackup(true),
    prompts = answerConfirms(true);
  await importTurn(() => {
    void view.result.current.importBackup(backupFile(importBody));
  });
  assert.deepEqual(importEffects(prompts), { prompts: 1, requests: 1, toasts: 1 });
  assert.equal(toastLog[0].kind, 'success');
  assert.equal(view.result.current.migrating, false);
});

for (const stage of ['file-read', 'response'] as const) {
  for (const change of ['remove-key', 'replace-key'] as const) {
    test(`a canceled ${stage} after ${change} clears busy state before a fresh B selection`, async () => {
      sessionStorage.setItem('openwa_api_key', 'key-a');
      const read = heldValue<string>(),
        answer = heldValue<Response>();
      const view = renderBackup(),
        prompts = answerConfirms(true, true);
      if (stage === 'response') importAnswers.push(answer.promise);
      await importTurn(() => {
        void view.result.current.importBackup(
          stage === 'file-read' ? selectedFile(read.promise) : backupFile(importBody),
        );
      });
      assert.equal(view.result.current.migrating, true);
      assert.equal(importBodies.length, stage === 'response' ? 1 : 0);
      if (change === 'remove-key') sessionStorage.removeItem('openwa_api_key');
      else sessionStorage.setItem('openwa_api_key', 'key-b');
      await importTurn(() => {
        if (stage === 'file-read') read.resolve(importBody);
        else answer.resolve(json({ imported: true, counts: {}, warnings: [] }));
      });
      const canceled = { ...importEffects(prompts), migrating: view.result.current.migrating };
      sessionStorage.setItem('openwa_api_key', 'key-b');
      const fresh = { tables: { dummyRows: [{ label: 'fresh-B-selection' }] } };
      await importTurn(() => {
        void view.result.current.importBackup(backupFile(fresh));
      });
      assert.deepEqual(canceled, {
        prompts: stage === 'response' ? 1 : 0,
        requests: stage === 'response' ? 1 : 0,
        toasts: 0,
        migrating: false,
      });
      assert.deepEqual(importBodies.at(-1), fresh);
      assert.equal(importKeys.at(-1), 'key-b');
      assert.equal(view.result.current.migrating, false);
      assert.equal(toastLog.length, 1);
      assert.equal(toastLog[0].kind, 'success');
    });
  }
}
