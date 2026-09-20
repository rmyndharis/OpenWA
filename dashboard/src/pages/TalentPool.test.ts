import '../test-helpers/register-hooks.ts';
import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type {
  WorkflowAppointment,
  WorkflowSlot,
  WorkflowInstance,
  WorkflowRecord,
  WorkflowRecruitmentApplication,
  WorkflowRecruitmentEvent,
  WorkflowTalentPoolEntry,
  WorkflowVersion,
} from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let Page: (typeof import('./TalentPool.tsx'))['default'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let client: QueryClient;
let stored: WorkflowInstance;
let releaseSave: (() => void) | undefined;
let saveGate: Promise<void> | undefined;
let submitted: WorkflowVersion | undefined;
let departmentColumns: Array<{ id: string; visible: boolean }> = [];
let departmentSubmissions: Array<Array<{ id: string; visible: boolean }>> = [];
let flowSettingSubmissions: Array<Partial<WorkflowInstance>> = [];
let records: WorkflowRecord[] = [];
let recruitmentApplications: WorkflowRecruitmentApplication[] = [];
let recruitmentEvents: WorkflowRecruitmentEvent[] = [];
let talentPoolEntries: WorkflowTalentPoolEntry[] = [];
let appointmentSlots: WorkflowSlot[] = [];
let appointments: WorkflowAppointment[] = [];
let scheduledAppointmentRequests: Array<{ recordId: string; targetSlotId: string }> = [];
let candidateRecordSubmissions: Array<{ data: Record<string, unknown>; expectedVersion: number }> = [];
let humanServiceEnabled = true;
let workflowPluginActive = true;
let sessionReady = true;
let emptySessionRequests: string[] = [];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  window.localStorage.setItem('openwa_user_role', 'admin');
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.includes('/sessions//')) emptySessionRequests.push(path);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/sessions')
      return json([{ id: 's1', name: 'Setor teste', status: sessionReady ? 'ready' : 'disconnected' }]);
    if (path === '/api/plugins/workflow-hub/enable' && init?.method === 'POST') {
      workflowPluginActive = true;
      return json({ success: true, message: 'enabled' });
    }
    if (path === '/api/plugins/workflow-hub/disable' && init?.method === 'POST') {
      workflowPluginActive = false;
      return json({ success: true, message: 'disabled' });
    }
    if (path === '/api/sessions/s1/start' && init?.method === 'POST') {
      sessionReady = true;
      return json({ id: 's1', name: 'Setor teste', status: 'ready' });
    }
    if (path === '/api/sessions/s1/stop' && init?.method === 'POST') {
      sessionReady = false;
      return json({ id: 's1', name: 'Setor teste', status: 'disconnected' });
    }
    if (path.endsWith('/draft') && init?.method === 'PUT') {
      const payload = JSON.parse(String(init.body));
      submitted = { ...stored.versions[0], ...payload };
      await saveGate;
      stored = { ...stored, versions: [submitted!] };
      return json(submitted);
    }
    if (/\/workflow-hub\/instances\/[^/]+$/.test(path) && init?.method === 'PUT') {
      const payload = JSON.parse(String(init.body)) as Partial<WorkflowInstance>;
      flowSettingSubmissions.push(payload);
      stored = { ...stored, ...payload };
      return json(stored);
    }
    const lifecycleAction = path.match(/\/workflow-hub\/instances\/[^/]+\/(pause|resume)$/);
    if (lifecycleAction && init?.method === 'POST') {
      stored = { ...stored, status: lifecycleAction[1] === 'pause' ? 'PAUSADA' : 'PUBLICADA' };
      return json(stored);
    }
    if (path.endsWith('/workflow-hub/instances')) return json([stored]);
    if (path.endsWith('/workflow-hub/runtime-status'))
      return json({
        pluginId: 'workflow-hub',
        installed: true,
        status: workflowPluginActive ? 'enabled' : 'disabled',
        activeForSession: workflowPluginActive,
        technicalRetentionDays: 365,
      });
    if (/\/workflow-hub\/recruitment-applications\/[^/]+\/events$/.test(path)) return json(recruitmentEvents);
    if (/\/workflow-hub\/recruitment-applications\/[^/]+$/.test(path) && init?.method === 'PATCH') {
      const id = path.split('/').at(-1);
      const payload = JSON.parse(String(init.body)) as Partial<WorkflowRecruitmentApplication>;
      const current = recruitmentApplications.find(application => application.id === id);
      if (!current) return new Response(null, { status: 404 });
      const saved = { ...current, ...payload, updatedAt: new Date().toISOString() };
      recruitmentApplications = recruitmentApplications.map(application =>
        application.id === id ? saved : application,
      );
      return json(saved);
    }
    if (path.endsWith('/workflow-hub/recruitment-applications')) return json(recruitmentApplications);
    if (path.endsWith('/workflow-hub/talent-pool')) return json(talentPoolEntries);
    if (/\/workflow-hub\/talent-pool\/[^/]+\/events$/.test(path)) return json([]);
    const candidateRecord = path.match(/\/workflow-hub\/records\/([^/]+)$/);
    if (candidateRecord && init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body)) as { data: Record<string, unknown>; expectedVersion: number };
      candidateRecordSubmissions.push(payload);
      const current = records.find(record => record.id === candidateRecord[1]);
      if (!current) return new Response(null, { status: 404 });
      const saved = {
        ...current,
        data: { ...current.data, ...payload.data },
        currentVersion: payload.expectedVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      records = records.map(record => (record.id === saved.id ? saved : record));
      return json(saved);
    }
    if (path.endsWith('/workflow-hub/records')) return json(records);
    if (path.endsWith('/workflow-hub/proximity/test') && init?.method === 'POST')
      return json({
        success: true,
        origin: { address: 'Rua Teste, 10, Centro, Belo Horizonte, MG', latitude: -19.9, longitude: -43.9 },
        normalizedAddress: {
          postalCode: '30110000',
          street: 'Rua Teste',
          number: '10',
          neighborhood: 'Centro',
          city: 'Belo Horizonte',
          state: 'MG',
        },
        results: [
          {
            posicao: 1,
            locationId: 'location-1',
            nome: 'Matriz',
            endereco: 'Rua da Matriz, 1',
            distanciaKm: 2.4,
            tempoMinutos: 6,
            routeAvailable: true,
          },
        ],
        destinationCount: 1,
        elapsedMs: 120,
      });
    if (/\/workflow-hub\/instances\/[^/]+\/slots$/.test(path)) return json(appointmentSlots);
    if (/\/workflow-hub\/instances\/[^/]+\/appointments$/.test(path)) return json(appointments);
    const manualAppointment = path.match(/\/workflow-hub\/instances\/[^/]+\/records\/([^/]+)\/appointment$/);
    if (manualAppointment && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body)) as { targetSlotId: string };
      scheduledAppointmentRequests.push({ recordId: manualAppointment[1], targetSlotId: payload.targetSlotId });
      const slot = appointmentSlots.find(item => item.id === payload.targetSlotId)!;
      const created: WorkflowAppointment = {
        id: 'manual-appointment',
        contactId: records.find(item => item.id === manualAppointment[1])?.contactId ?? '',
        status: 'CONFIRMADO',
        createdAt: new Date().toISOString(),
        reminderSentAt: null,
        slot,
      };
      appointments = [created];
      const record = records.find(item => item.id === manualAppointment[1]);
      recruitmentApplications = recruitmentApplications.map(application =>
        record && application.contactId === record.contactId
          ? {
              ...application,
              appointmentId: created.id,
              appointment: created,
              status:
                slot.interviewPhase === 'FASE_3_CONTRATACAO'
                  ? 'DOCUMENTACAO'
                  : slot.interviewPhase === 'FASE_2_ENTREVISTA_FOCADA'
                    ? 'APROVADO'
                    : 'ENTREVISTA_MARCADA',
            }
          : application,
      );
      return json(created);
    }
    if (path.endsWith('/department/human-service') && init?.method === 'PUT') {
      humanServiceEnabled = Boolean((JSON.parse(String(init.body)) as { enabled: boolean }).enabled);
      return json({
        department: {
          id: 'd1',
          name: 'Setor teste',
          timezone: 'America/Sao_Paulo',
          enabled: true,
          humanServiceEnabled,
          menuTimeoutMinutes: 10,
          messages: {},
          candidateTableColumns: departmentColumns,
          schedule: { timezone: 'America/Sao_Paulo', weekdays: {}, exceptions: [] },
        },
      });
    }
    if (path.endsWith('/department')) {
      if (init?.method === 'PUT') {
        const payload = JSON.parse(String(init.body));
        if (payload.candidateTableColumns) {
          departmentColumns = payload.candidateTableColumns;
          departmentSubmissions.push(payload.candidateTableColumns);
        }
      }
      return json({
        id: 'd1',
        name: 'Setor teste',
        timezone: 'America/Sao_Paulo',
        enabled: true,
        humanServiceEnabled,
        menuTimeoutMinutes: 10,
        messages: {},
        candidateTableColumns: departmentColumns,
        schedule: { timezone: 'America/Sao_Paulo', weekdays: {}, exceptions: [] },
      });
    }
    if (path.endsWith('/indicators'))
      return json({ flows: 1, published: 0, records: 0, activeRuns: 0, availableSlots: 0, appointments: 0 });
    return json([]);
  };
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ default: Page } = await import('./TalentPool.tsx'));
});

afterEach(() => {
  releaseSave?.();
  rtl.cleanup();
  client?.clear();
  saveGate = undefined;
  releaseSave = undefined;
  submitted = undefined;
  departmentColumns = [];
  departmentSubmissions = [];
  flowSettingSubmissions = [];
  records = [];
  recruitmentApplications = [];
  recruitmentEvents = [];
  talentPoolEntries = [];
  appointmentSlots = [];
  appointments = [];
  scheduledAppointmentRequests = [];
  candidateRecordSubmissions = [];
  humanServiceEnabled = true;
  workflowPluginActive = true;
  sessionReady = true;
  emptySessionRequests = [];
});

function mount(flowOverride: Partial<WorkflowInstance> = {}, initialEntry = '/recruitment-center') {
  stored = {
    id: 'f1',
    name: 'Fluxo teste',
    slug: 'teste',
    description: null,
    status: 'RASCUNHO',
    keywords: ['teste'],
    flowTimeoutMinutes: 10,
    humanInactivityMinutes: 30,
    humanGraceMinutes: 5,
    validityMonths: 12,
    invalidAttemptLimit: 3,
    pdfMaxBytes: 10485760,
    proactiveReminderDays: null,
    appointmentNotificationNumbers: [],
    appointmentNotifications: [],
    messages: {},
    recordMenu: { title: 'Menu', actions: [{ action: 'ENCERRAR_ATENDIMENTO', label: 'Encerrar', enabled: true }] },
    currentVersionId: null,
    versions: [
      {
        id: 'v1',
        versionNumber: 1,
        status: 'RASCUNHO',
        definition: {},
        fields: [
          { id: 'nome', label: 'Nome original', prompt: 'Qual seu nome?', type: 'text', required: true, order: 1 },
          {
            id: 'area_interesse',
            answerKey: 'area_interesse',
            label: 'Área de interesse',
            prompt: 'Qual área ou oportunidade profissional mais combina com você?',
            type: 'select',
            required: true,
            order: 2,
            options: ['Auxiliar de cozinha', 'Primeiro emprego'],
          },
        ],
      },
    ],
    ...flowOverride,
  };
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1000 } } });
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [initialEntry] },
        createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Page))),
      ),
    ),
  );
}

function recruitmentApplication(
  id: string,
  name: string,
  status: WorkflowRecruitmentApplication['status'],
): WorkflowRecruitmentApplication {
  const record: WorkflowRecord = {
    id: `record-${id}`,
    instanceId: 'f1',
    instanceName: 'Fluxo teste',
    contactId: `553199999${id}@c.us`,
    phone: `553199999${id}`,
    status: 'CONFIRMADO',
    currentVersion: 1,
    definitionVersionId: 'version-1',
    data: { nome: name, area_interesse: 'Auxiliar de cozinha' },
    validUntil: '2027-09-14T12:00:00.000Z',
    updatedAt: '2026-09-14T12:00:00.000Z',
  };
  return {
    id: `application-${id}`,
    instanceId: 'f1',
    contactId: record.contactId,
    recordId: record.id,
    appointmentId: null,
    status,
    owner: null,
    rating: null,
    nextActionAt: null,
    version: 1,
    createdAt: '2026-09-13T12:00:00.000Z',
    updatedAt: '2026-09-14T12:00:00.000Z',
    instance: { id: 'f1', name: 'Fluxo teste' },
    record,
    appointment: null,
  };
}

test('editing conversation identity in Fluxos survives an explicit data refresh', async () => {
  mount();
  const { screen, fireEvent, waitFor } = rtl;
  fireEvent.click(await screen.findByRole('button', { name: /Nome original/ }));
  await screen.findByDisplayValue('Nome original');
  const name = (await screen.findByDisplayValue('Fluxo teste')) as HTMLInputElement;
  fireEvent.change(name, { target: { value: 'Nome em edição' } });
  fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
  await waitFor(() =>
    assert.equal((screen.getByRole('button', { name: 'Atualizar' }) as HTMLButtonElement).disabled, false),
  );
  assert.equal(name.value, 'Nome em edição');
});

test('reactivates a paused flow without publishing its draft again', async () => {
  mount({
    status: 'PAUSADA',
    currentVersionId: 'published-v1',
    versions: [
      {
        id: 'published-v1',
        versionNumber: 1,
        status: 'PUBLICADA',
        definition: {},
        fields: [{ id: 'nome', label: 'Nome', prompt: 'Seu nome?', type: 'text', required: true, order: 1 }],
      },
    ],
  });
  const { screen, fireEvent, waitFor } = rtl;
  const reactivate = await screen.findByRole('button', { name: 'Reativar fluxo' });
  fireEvent.click(reactivate);

  await waitFor(() => assert.equal(stored.status, 'PUBLICADA'));
  assert.ok(screen.getByRole('button', { name: 'Pausar' }));
});

test('shows the disabled plugin and active WhatsApp session beside the flow header', async () => {
  workflowPluginActive = false;
  mount();
  const { screen } = rtl;
  assert.ok(await screen.findByText('Plugin desativado'));
  assert.ok(screen.getByText('Sessão ativa'));
});

test('keeps the selected Central de Recrutamento tab in the URL', async () => {
  mount({}, '/recruitment-center?aba=candidates');
  const { screen } = rtl;
  assert.ok(await screen.findByRole('heading', { name: 'Candidatos' }));
  assert.equal(screen.getByRole('button', { name: 'Candidatos' }).className, 'active');
});

test('does not load the recruitment board before the session is selected', async () => {
  mount({}, '/recruitment-center?aba=recruitment');
  const { screen, waitFor } = rtl;
  await screen.findByRole('heading', { name: 'Processo seletivo' });
  await waitFor(() => assert.equal(emptySessionRequests.length, 0));
});

test('lists talent-pool candidates even before they have an interview', async () => {
  records = [
    {
      id: 'record-talent-pool',
      instanceId: 'f1',
      instanceName: 'Fluxo teste',
      contactId: '5531999991111@c.us',
      phone: '5531999991111',
      status: 'CONFIRMADO',
      data: { nome: 'Candidata Banco Futuro', area_interesse: 'Banco de Talentos' },
      currentVersion: 1,
      definitionVersionId: 'v1',
      validUntil: '2027-09-17T12:00:00.000Z',
      updatedAt: '2026-09-17T12:00:00.000Z',
    },
  ];
  talentPoolEntries = [
    {
      id: 'talent-entry-1',
      instanceId: 'f1',
      recordId: records[0].id,
      contactId: records[0].contactId,
      status: 'DISPONIVEL',
      owner: null,
      convertedAt: null,
      version: 1,
      createdAt: '2026-09-17T12:00:00.000Z',
      updatedAt: '2026-09-17T12:00:00.000Z',
      instance: { id: 'f1', name: 'Fluxo teste' },
      record: records[0],
    },
  ];
  mount({
    versions: [
      {
        id: 'v1',
        versionNumber: 1,
        status: 'RASCUNHO',
        definition: {},
        fields: [
          { id: 'nome', label: 'Nome', prompt: 'Nome?', type: 'text', required: true, order: 1 },
          {
            id: 'area_interesse',
            answerKey: 'area_interesse',
            label: 'Área de interesse',
            prompt: 'Qual vaga você procura?',
            type: 'select',
            required: true,
            order: 2,
            options: ['Auxiliar de Churrasco', 'Banco de Talentos'],
            talentPoolOption: 'Banco de Talentos',
          },
        ],
      },
    ],
  });
  const { screen, fireEvent } = rtl;
  fireEvent.click(await screen.findByRole('button', { name: /Banco de Talentos/ }));

  assert.ok(await screen.findByText('Candidata Banco Futuro'));
  assert.ok(screen.getByRole('heading', { name: 'Banco de Talentos' }));
  fireEvent.click(screen.getByRole('button', { name: 'Candidatos' }));
  assert.equal(screen.queryByText('Candidata Banco Futuro'), null);
});

test('changes plugin and session status from the runtime indicators', async () => {
  mount();
  const { screen, fireEvent, waitFor, within } = rtl;
  fireEvent.click(await screen.findByRole('button', { name: 'Plugin ativo' }));
  const pluginDialog = screen.getByRole('dialog', { name: 'Desativar a Central de Recrutamento?' });
  fireEvent.click(within(pluginDialog).getByRole('button', { name: 'Confirmar alteração' }));
  await waitFor(() => assert.equal(workflowPluginActive, false));

  fireEvent.click(screen.getByRole('button', { name: 'Sessão ativa' }));
  const sessionDialog = screen.getByRole('dialog', { name: 'Desativar a sessão do WhatsApp?' });
  fireEvent.click(within(sessionDialog).getByRole('button', { name: 'Confirmar alteração' }));
  await waitFor(() => assert.equal(sessionReady, false));
});

test('an authorized user can disable and restore human service from the tab bar', async () => {
  mount();
  const { screen, fireEvent, waitFor, within } = rtl;
  fireEvent.click(await screen.findByRole('button', { name: 'Encerrar atendimento humano' }));
  const closeDialog = screen.getByRole('dialog', { name: 'Encerrar atendimento humano?' });
  assert.match(closeDialog.textContent ?? '', /novas solicitações serão bloqueadas/);
  fireEvent.click(within(closeDialog).getByRole('button', { name: 'Encerrar atendimento humano' }));

  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Ativar atendimento humano' })));
  assert.equal(humanServiceEnabled, false);

  fireEvent.click(screen.getByRole('button', { name: 'Ativar atendimento humano' }));
  const openDialog = screen.getByRole('dialog', { name: 'Ativar atendimento humano?' });
  fireEvent.click(within(openDialog).getByRole('button', { name: 'Ativar atendimento humano' }));

  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Encerrar atendimento humano' })));
  assert.equal(humanServiceEnabled, true);
});

test('tests a structured address from the location card in settings', async () => {
  mount();
  const { screen, fireEvent } = rtl;
  await screen.findByRole('button', { name: /Nome original/ });
  fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
  fireEvent.click(screen.getByRole('button', { name: /Teste de localização/ }));
  fireEvent.change(screen.getByLabelText('CEP'), { target: { value: '30110000' } });
  fireEvent.change(screen.getByLabelText('Logradouro'), { target: { value: 'Rua Teste' } });
  fireEvent.change(screen.getByLabelText('Número'), { target: { value: '10A' } });
  fireEvent.change(screen.getByLabelText('Bairro'), { target: { value: 'Centro' } });
  fireEvent.change(screen.getByLabelText('Cidade'), { target: { value: 'Belo Horizonte' } });
  fireEvent.change(screen.getByLabelText('UF'), { target: { value: 'mg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Testar endereço' }));

  await screen.findByText('Localização e rotas encontradas');
  assert.ok(screen.getByText('Matriz'));
  assert.ok(screen.getByText('6 min'));
  assert.equal((screen.getByLabelText('Número') as HTMLInputElement).value, '10');
  assert.ok(screen.getByText(/Rua Teste, 10, Centro, Belo Horizonte, MG/));
});

test('saves the appointment notification recipients in the selected flow', async () => {
  mount();
  const { screen, fireEvent, waitFor } = rtl;
  await screen.findByRole('button', { name: /Nome original/ });
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar gestor' }));
  const firstManagerCard = screen.getByLabelText('Expandir configurações de gestor 1');
  assert.equal(firstManagerCard.closest('details')?.hasAttribute('open'), false);
  fireEvent.click(firstManagerCard);
  fireEvent.change(screen.getByRole('textbox', { name: 'Nome do gestor 1' }), { target: { value: 'Amanda' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'DDD do destinatário 1' }), { target: { value: '31' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Número do destinatário 1' }), {
    target: { value: '999991111' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar gestor' }));
  fireEvent.click(screen.getByLabelText('Expandir configurações de gestor 2'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Nome do gestor 2' }), { target: { value: 'Priscila' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'DDD do destinatário 2' }), { target: { value: '31' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Número do destinatário 2' }), {
    target: { value: '999992222' },
  });
  fireEvent.click(screen.getAllByRole('checkbox', { name: 'Entrevista marcada' })[1]);
  fireEvent.click(screen.getAllByRole('checkbox', { name: 'Entrevista cancelada' })[1]);
  assert.ok(screen.getByText('Amanda'));
  assert.ok(screen.getByText('Priscila'));
  assert.equal(screen.queryByText('Gestor 1'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Salvar identidade e avisos' }));

  await waitFor(() => assert.equal(flowSettingSubmissions.length, 1));
  assert.deepEqual(
    flowSettingSubmissions[0].appointmentNotifications?.map(recipient => ({
      ddi: recipient.ddi,
      ddd: recipient.ddd,
      number: recipient.number,
      events: recipient.events,
    })),
    [
      { ddi: '55', ddd: '31', number: '999991111', events: ['CONFIRMADA'] },
      { ddi: '55', ddd: '31', number: '999992222', events: ['CANCELADA'] },
    ],
  );
});

test('typing during a slow save keeps the newest text pending instead of replacing it', async () => {
  mount();
  const { screen, fireEvent, waitFor, act } = rtl;
  fireEvent.click(await screen.findByRole('button', { name: /Nome original/ }));
  const input = (await screen.findByDisplayValue('Nome original')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Primeira edição' } });
  saveGate = new Promise(resolve => {
    releaseSave = resolve;
  });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar rascunho' }));
  await waitFor(() => assert.ok(submitted));
  fireEvent.change(input, { target: { value: 'Edição mais recente' } });
  await act(async () => {
    releaseSave!();
    await saveGate;
  });
  await screen.findByText('Versão enviada salva. Suas alterações mais recentes continuam pendentes; salve novamente.');
  assert.equal(input.value, 'Edição mais recente');
  assert.equal(submitted!.fields[0].label, 'Primeira edição');
  assert.equal((screen.getByRole('button', { name: 'Salvar rascunho' }) as HTMLButtonElement).disabled, false);
});

test('changing a candidate column saves its visibility to the department database endpoint automatically', async () => {
  mount();
  const { screen, fireEvent, waitFor } = rtl;
  await screen.findByRole('button', { name: /Nome original/ });
  fireEvent.click(await screen.findByRole('button', { name: 'Configurações' }));
  const columnsHeader = screen.getByRole('button', { name: /Campos padrão da tabela/ });
  fireEvent.click(columnsHeader);
  const checkbox = (await screen.findByRole('checkbox', { name: /Nome original/ })) as HTMLInputElement;
  assert.equal(checkbox.checked, true);

  fireEvent.click(checkbox);

  await waitFor(() => assert.equal(departmentSubmissions.length, 1), { timeout: 2_000 });
  assert.deepEqual(
    departmentSubmissions[0].find(column => column.id === 'answer:nome'),
    { id: 'answer:nome', visible: false },
  );
  await screen.findByText('Salvo no banco');
});

test('settings cards have their own save actions and persist only the selected card', async () => {
  mount();
  const { screen, fireEvent, waitFor, within } = rtl;
  await screen.findByRole('button', { name: /Nome original/ });
  fireEvent.click(await screen.findByRole('button', { name: 'Configurações' }));

  assert.equal(screen.queryByRole('button', { name: 'Salvar setor e horários' }), null);
  const openCard = (name: string) => {
    const header = screen.getByRole('button', { name: new RegExp(name) });
    fireEvent.click(header);
    return header;
  };
  const departmentHeader = openCard('Setor e atendimento');
  assert.ok(await screen.findByRole('button', { name: 'Salvar setor e horários' }));
  assert.equal(departmentHeader.getAttribute('aria-expanded'), 'true');

  openCard('Campos padrão da tabela');
  openCard('Prazos e limites');
  openCard('Validade e lembrete');
  assert.ok(screen.getByRole('button', { name: 'Salvar campos da tabela' }));
  assert.ok(screen.getByRole('button', { name: 'Salvar prazos e limites' }));
  assert.ok(screen.getByRole('button', { name: 'Salvar validade e lembrete' }));

  const pdfCard = screen.getByRole('button', { name: /Arquivos PDF/ }).closest('article');
  assert.ok(pdfCard);
  openCard('Arquivos PDF');
  fireEvent.change(within(pdfCard).getByRole('spinbutton'), { target: { value: '12' } });
  fireEvent.click(within(pdfCard).getByRole('button', { name: 'Salvar limite do PDF' }));

  await waitFor(() => assert.equal(flowSettingSubmissions.length, 1));
  assert.deepEqual(flowSettingSubmissions[0], { pdfMaxBytes: 12 * 1_048_576 });
});

test('diagram stages start collapsed and expand by clicking their card headers', async () => {
  mount();
  const { screen, fireEvent, waitFor } = rtl;
  await screen.findByRole('button', { name: /Nome original/ });
  fireEvent.click(await screen.findByRole('button', { name: 'Diagrama' }));
  const header = await screen.findByRole('button', { name: /Perguntas e caminhos/ });
  const card = header.closest('article');
  assert.ok(card && header);
  assert.equal(card.querySelector('#diagram-questions-and-paths'), null);
  fireEvent.click(header);
  await waitFor(() => assert.ok(card.querySelector('#diagram-questions-and-paths')));
  assert.equal(header.getAttribute('aria-expanded'), 'true');

  const entryHeader = screen.getByRole('button', { name: /Entrada da conversa/ });
  const entryContent = document.querySelector<HTMLElement>('#diagram-conversation-entry');
  assert.ok(entryContent);
  assert.equal(entryHeader.getAttribute('aria-expanded'), 'false');
  assert.equal(entryContent.hidden, true);
  fireEvent.click(entryHeader);
  assert.equal(entryHeader.getAttribute('aria-expanded'), 'true');
  assert.equal(entryContent.hidden, false);

  const confirmationHeader = screen.getByRole('button', { name: /Confirmação e menu do cliente/ });
  const confirmationContent = document.querySelector<HTMLElement>('#diagram-confirmation-menu');
  assert.ok(confirmationContent);
  assert.equal(confirmationHeader.getAttribute('aria-expanded'), 'false');
  assert.equal(confirmationContent.hidden, true);
  fireEvent.click(confirmationHeader);
  assert.equal(confirmationHeader.getAttribute('aria-expanded'), 'true');
  assert.equal(confirmationContent.hidden, false);
});

test('opens the post-interview selection process separately from flow triage', async () => {
  recruitmentApplications = [
    recruitmentApplication('1111', 'Candidata ativa', 'EM_AVALIACAO'),
    recruitmentApplication('2222', 'Pessoa contratada', 'CONTRATADO'),
    recruitmentApplication('3333', 'Processo encerrado', 'DESISTIU'),
  ];
  mount();
  const { screen, fireEvent } = rtl;
  await screen.findByRole('button', { name: /Nome original/ });
  fireEvent.click(screen.getByRole('button', { name: 'Processo seletivo' }));
  assert.ok(await screen.findByRole('heading', { name: 'Processo seletivo' }));
  assert.ok(screen.getByText(/acompanhamento começa quando a entrevista é marcada/i));
  assert.ok(screen.getByText('1ª fase — Entrevista simples'));
  assert.ok(screen.getAllByText('2ª fase — Entrevista teste').length > 0);
  assert.ok(screen.getAllByText('3ª fase — Entrevista com DP').length > 0);
  assert.equal(screen.queryByText('Documentação'), null);
  const activeView = screen.getByRole('tab', { name: /Em andamento/ });
  assert.equal(activeView.getAttribute('aria-selected'), 'true');
  assert.ok(screen.getByText('Candidata ativa'));
  assert.equal(screen.queryByText('Pessoa contratada'), null);

  const hiredView = screen.getByRole('tab', { name: /Contratados/ });
  fireEvent.click(hiredView);
  assert.equal(hiredView.getAttribute('aria-selected'), 'true');
  assert.ok(screen.getByText('Pessoa contratada'));
  assert.equal(screen.queryByText('Candidata ativa'), null);
  fireEvent.click(screen.getByRole('button', { name: /Pessoa contratada/ }));
  assert.ok(screen.getByRole('button', { name: 'Desistir da vaga' }));
  assert.equal(screen.queryByRole('button', { name: '3ª fase — Entrevista com DP' }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Fechar acompanhamento' }));

  const closedView = screen.getByRole('tab', { name: /Encerrados/ });
  fireEvent.click(closedView);
  assert.ok(screen.getByText('Processo encerrado'));
  assert.equal(screen.queryByText('Pessoa contratada'), null);

  fireEvent.click(activeView);
  assert.equal(screen.getByRole('button', { name: /Todas as áreas/ }).getAttribute('aria-pressed'), 'true');
  const areaFilters = screen.getByRole('group', { name: 'Filtrar processo seletivo por área de interesse' });
  const area = rtl.within(areaFilters).getByRole('button', { name: /Auxiliar de cozinha/ });
  assert.equal(area.getAttribute('aria-pressed'), 'false');
  fireEvent.click(area);
  assert.equal(area.getAttribute('aria-pressed'), 'true');
  assert.ok(screen.getByRole('button', { name: 'Mostrar todas' }));
});

test('updates the candidate process status after a selection-process transition without reloading the page', async () => {
  const application = recruitmentApplication('4444', 'Candidata sincronizada', 'EM_AVALIACAO');
  recruitmentApplications = [application];
  records = [application.record!];
  appointmentSlots = [
    {
      id: 'focused-slot',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      label: null,
      location: 'Matriz',
      interviewPhase: 'FASE_2_ENTREVISTA_FOCADA',
      status: 'DISPONIVEL',
      capacity: 2,
      bookedCount: 0,
    },
  ];
  mount();
  const { screen, fireEvent, waitFor, within } = rtl;
  await screen.findByRole('button', { name: /Nome original/ });
  fireEvent.click(screen.getByRole('button', { name: 'Processo seletivo' }));
  fireEvent.click(await screen.findByRole('button', { name: /Candidata sincronizada/ }));
  fireEvent.click(screen.getByRole('button', { name: '2ª fase — Entrevista teste' }));
  const phaseSelect = await screen.findByLabelText('Nova data da entrevista');
  fireEvent.change(phaseSelect, { target: { value: 'focused-slot' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar nova entrevista' }));
  await waitFor(() => assert.equal(recruitmentApplications[0].status, 'APROVADO'));

  fireEvent.click(screen.getByRole('button', { name: 'Candidatos' }));
  const row = (await screen.findAllByText('Candidata sincronizada'))[0].closest('tr');
  assert.ok(row);
  await waitFor(() => assert.ok(within(row).getByText('2ª fase — Entrevista teste')));
});

test('returns a second-evaluation candidate to the interview-test card after scheduling a new date', async () => {
  const application = recruitmentApplication('4555', 'Candidata para nova loja', 'EM_AVALIACAO_FASE_2');
  recruitmentApplications = [application];
  records = [application.record!];
  appointmentSlots = [
    {
      id: 'second-focused-slot',
      startsAt: new Date(Date.now() + 172_800_000).toISOString(),
      label: null,
      location: 'Loja 2',
      interviewPhase: 'FASE_2_ENTREVISTA_FOCADA',
      status: 'DISPONIVEL',
      capacity: 2,
      bookedCount: 0,
    },
  ];

  mount();
  const { screen, fireEvent, waitFor, within } = rtl;
  await screen.findByRole('button', { name: /Nome original/ });
  fireEvent.click(screen.getByRole('button', { name: 'Processo seletivo' }));
  fireEvent.click(await screen.findByRole('button', { name: /Candidata para nova loja/ }));
  assert.ok(screen.getByText('Passar para a próxima fase'));
  assert.ok(screen.getByText('Manter ou retornar na fase'));
  assert.ok(screen.getByText('Encerrar participação'));
  fireEvent.click(screen.getByRole('button', { name: 'Marcar nova entrevista/teste' }));
  fireEvent.change(await screen.findByLabelText('Nova data da entrevista'), {
    target: { value: 'second-focused-slot' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar nova entrevista' }));

  await waitFor(() => assert.equal(recruitmentApplications[0].status, 'APROVADO'));
  const focusedColumn = screen
    .getAllByText('2ª fase — Entrevista teste')
    .find(element => element.closest('header'))
    ?.closest<HTMLElement>('.recruitment-column');
  assert.ok(focusedColumn);
  await waitFor(() => assert.ok(within(focusedColumn).getByText('Candidata para nova loja')));
});

test('links the candidate profile to recruitment, interview and process history', async () => {
  const record: WorkflowRecord = {
    id: 'record-1',
    instanceId: 'f1',
    instanceName: 'Fluxo teste',
    contactId: '5531999991111@c.us',
    phone: '5531999991111',
    status: 'CONFIRMADO',
    currentVersion: 1,
    definitionVersionId: 'version-1',
    data: { nome: 'Maria Teste', area_interesse: 'Auxiliar de cozinha' },
    validUntil: '2027-09-14T12:00:00.000Z',
    updatedAt: '2026-09-14T12:00:00.000Z',
  };
  records = [record];
  recruitmentApplications = [
    {
      id: 'application-1',
      instanceId: 'f1',
      contactId: record.contactId,
      recordId: record.id,
      appointmentId: 'appointment-1',
      status: 'APROVADO',
      owner: 'Amanda',
      rating: 5,
      nextActionAt: '2026-09-16T12:00:00.000Z',
      version: 2,
      createdAt: '2026-09-13T12:00:00.000Z',
      updatedAt: '2026-09-14T12:00:00.000Z',
      instance: { id: 'f1', name: 'Fluxo teste' },
      record,
      appointment: {
        id: 'appointment-1',
        contactId: record.contactId,
        status: 'CONFIRMADO',
        createdAt: '2026-09-13T12:00:00.000Z',
        reminderSentAt: null,
        slot: {
          id: 'slot-1',
          startsAt: '2026-09-15T13:00:00.000Z',
          label: null,
          location: 'Ambrozini Floresta',
          address: 'Rua da Entrevista, 100',
          instruction: 'Apresente-se na recepção',
          responsible: 'Amanda',
          mapsUrl: 'https://maps.google.com/example',
          status: 'DISPONIVEL',
          capacity: 5,
          bookedCount: 1,
        },
      },
    },
  ];
  recruitmentEvents = [
    {
      id: 'event-1',
      type: 'STATUS_CHANGED',
      fromStatus: 'EM_AVALIACAO',
      toStatus: 'APROVADO',
      actorId: 'admin',
      note: 'Perfil aprovado pelo gestor.',
      metadata: {},
      createdAt: '2026-09-14T12:00:00.000Z',
    },
  ];

  mount();
  const { screen, fireEvent } = rtl;
  fireEvent.click(await screen.findByRole('button', { name: 'Candidatos' }));
  const candidateRow = (await screen.findAllByText('Maria Teste'))[0].closest('tr');
  assert.ok(candidateRow);
  assert.ok(rtl.within(candidateRow).getByText('2ª fase — Entrevista teste'));
  fireEvent.click(candidateRow);

  assert.ok(await screen.findByRole('heading', { name: 'Processo seletivo' }));
  assert.ok(screen.getAllByText('2ª fase — Entrevista teste').length >= 1);
  assert.ok(screen.getAllByText('Amanda').length >= 1);
  assert.ok(screen.getByText('Rua da Entrevista, 100'));
  assert.ok(screen.getByText('Perfil aprovado pelo gestor.'));
  assert.ok(screen.getByRole('link', { name: 'Ambrozini Floresta' }));
});

test('edits candidate answers from the profile using the current flow fields', async () => {
  const record: WorkflowRecord = {
    id: 'record-edit',
    instanceId: 'f1',
    instanceName: 'Fluxo teste',
    contactId: '5531999993333@c.us',
    phone: '5531999993333',
    status: 'CONFIRMADO',
    currentVersion: 1,
    definitionVersionId: 'v1',
    data: { nome: 'Nome antigo', area_interesse: 'Turno antigo que não existe mais' },
    validUntil: '2027-09-14T12:00:00.000Z',
    updatedAt: '2026-09-14T12:00:00.000Z',
  };
  records = [record];
  const { screen, fireEvent, waitFor } = rtl;
  mount();

  fireEvent.click(await screen.findByRole('button', { name: 'Candidatos' }));
  const row = (await screen.findAllByText('Nome antigo'))[0].closest('tr');
  assert.ok(row);
  fireEvent.click(row);
  fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
  const nameInput = screen.getByRole('textbox', { name: 'Nome original' });
  fireEvent.change(nameInput, { target: { value: 'Nome corrigido' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar correções' }));

  await waitFor(() => assert.equal(records[0].data.nome, 'Nome corrigido'));
  assert.deepEqual(candidateRecordSubmissions[0].data, { nome: 'Nome corrigido' });
  assert.equal(records[0].currentVersion, 2);
  assert.ok((await screen.findAllByText('Nome corrigido')).length >= 1);
});

test('marks an interview from the candidate profile using a future available slot', async () => {
  const record: WorkflowRecord = {
    id: 'record-manual',
    instanceId: 'f1',
    instanceName: 'Fluxo teste',
    contactId: '5531999992222@c.us',
    phone: '5531999992222',
    status: 'CONFIRMADO',
    currentVersion: 1,
    definitionVersionId: 'version-1',
    data: { nome: 'Candidato sem entrevista', area_interesse: 'Primeiro emprego' },
    validUntil: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  records = [record];
  appointmentSlots = [
    {
      id: 'slot-futuro',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      label: null,
      location: 'Matriz',
      address: 'Rua da Entrevista, 100',
      instruction: 'Apresente-se na recepção',
      responsible: 'Amanda',
      mapsUrl: null,
      status: 'DISPONIVEL',
      capacity: 5,
      bookedCount: 0,
    },
  ];

  mount();
  const { screen, fireEvent, waitFor } = rtl;
  fireEvent.click(await screen.findByRole('button', { name: 'Candidatos' }));
  const candidateRow = (await screen.findAllByText('Candidato sem entrevista'))[0].closest('tr');
  assert.ok(candidateRow);
  fireEvent.click(candidateRow);

  const slotSelect = await screen.findByLabelText('Horário da entrevista');
  fireEvent.change(slotSelect, { target: { value: 'slot-futuro' } });
  fireEvent.click(screen.getByRole('button', { name: 'Marcar entrevista' }));

  await waitFor(() =>
    assert.deepEqual(scheduledAppointmentRequests, [{ recordId: 'record-manual', targetSlotId: 'slot-futuro' }]),
  );
});
