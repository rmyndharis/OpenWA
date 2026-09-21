import '../test-helpers/register-hooks.ts';
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { createElement } from 'react';
import type { WorkflowRecord, WorkflowTalentPoolEntry } from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let TalentBank: (typeof import('./TalentBank.tsx'))['TalentBank'];
let ToastProvider: (typeof import('./Toast.tsx'))['ToastProvider'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  rtl = await import('@testing-library/react');
  ({ TalentBank } = await import('./TalentBank.tsx'));
  ({ ToastProvider } = await import('./Toast.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

const entry = (id: string, name: string, version = 1): WorkflowTalentPoolEntry => {
  const record: WorkflowRecord = {
    id: `record-${id}`,
    instanceId: 'flow-1',
    instanceName: 'Fluxo',
    contactId: `${id}@c.us`,
    phone: id,
    status: 'CONFIRMADO',
    data: { nome: name, area_profissional: 'Atendimento', municipio_residencia: 'Recife' },
    currentVersion: 1,
    definitionVersionId: 'version-1',
    validUntil: '2027-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    id: `entry-${id}`,
    instanceId: 'flow-1',
    recordId: record.id,
    contactId: record.contactId,
    status: 'DISPONIVEL',
    owner: null,
    convertedAt: null,
    version,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    instance: { id: 'flow-1', name: 'Fluxo' },
    record,
  };
};

const renderBank = (sessionId: string) =>
  createElement(
    ToastProvider,
    null,
    createElement(TalentBank, {
      sessionId,
      canWrite: true,
      refreshRevision: 0,
      onCandidateSelect: () => undefined,
    }),
  );

test('clears drafts on a rapid session switch and ignores the stale response', async () => {
  let releaseOld: ((response: Response) => void) | undefined;
  const oldResponse = new Promise<Response>(resolve => {
    releaseOld = resolve;
  });
  globalThis.fetch = async input => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.includes('/sessions/old/')) return oldResponse;
    if (path.includes('/sessions/new/'))
      return new Response(JSON.stringify([entry('new', 'Pessoa nova')]), {
        headers: { 'Content-Type': 'application/json' },
      });
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  };

  const view = rtl.render(renderBank('old'));
  view.rerender(renderBank('new'));
  assert.ok(await rtl.screen.findByText('Pessoa nova'));

  releaseOld!(
    new Response(JSON.stringify([entry('old', 'Pessoa obsoleta')]), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await rtl.waitFor(() => assert.equal(rtl.screen.queryByText('Pessoa obsoleta'), null));
  assert.equal((rtl.screen.getByLabelText('Pesquisar no Banco de Talentos') as HTMLInputElement).value, '');
});

test('sends expectedVersion and explains a 409 conflict before refreshing', async () => {
  const current = entry('versioned', 'Pessoa versionada', 7);
  let patchBody: { expectedVersion?: number } | undefined;
  let listRequests = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (init?.method === 'PATCH') {
      patchBody = JSON.parse(String(init.body)) as { expectedVersion?: number };
      return new Response(JSON.stringify({ message: 'Conflict' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (path.endsWith('/workflow-hub/talent-pool')) {
      listRequests += 1;
      return new Response(JSON.stringify([current]), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  };

  rtl.render(renderBank('session-1'));
  await rtl.screen.findByText('Pessoa versionada');
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Salvar acompanhamento' }));

  assert.ok(await rtl.screen.findByText(/alterado por outra pessoa/i));
  assert.equal(patchBody?.expectedVersion, 7);
  assert.equal(listRequests, 2);
});
