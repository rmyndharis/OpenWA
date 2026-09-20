import { DataSource } from 'typeorm';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';
import {
  AppointmentSlotStatus,
  AppointmentStatus,
  WorkflowAppointment,
  WorkflowAppointmentSlot,
  WorkflowConsent,
  WorkflowDefinitionVersion,
  WorkflowDeletionRequest,
  WorkflowDepartment,
  WorkflowInstance,
  WorkflowInstanceStatus,
  WorkflowIdentity,
  WorkflowIdentityContact,
  WorkflowInterviewPhase,
  WorkflowOutboxMessage,
  WorkflowOutboxStatus,
  WorkflowPrivacyEvent,
  WorkflowProximityStatus,
  WorkflowRecord,
  WorkflowRecordMenuAction,
  WorkflowRecordStatus,
  WorkflowRecordVersion,
  WorkflowRecruitmentApplication,
  WorkflowRecruitmentEvent,
  WorkflowRecruitmentStatus,
  WorkflowTalentPoolEntry,
  WorkflowTalentPoolEvent,
  WorkflowTalentPoolStatus,
  WorkflowRun,
  WorkflowRunState,
  WorkflowTicket,
  WorkflowTicketEvent,
  WorkflowVersionStatus,
} from './entities/workflow-hub.entity';
import { WorkflowHubService } from './workflow-hub.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { TalentCandidate, TalentFlowSession, TalentFlowState } from './entities/talent-pool.entity';

describe('WorkflowHubService', () => {
  let ds: DataSource;
  let service: WorkflowHubService;
  let resolveContactPhone: jest.Mock;
  const sessionId = 'session-workflow';

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        Session,
        Message,
        WorkflowDepartment,
        WorkflowInstance,
        WorkflowIdentity,
        WorkflowIdentityContact,
        WorkflowDefinitionVersion,
        WorkflowRun,
        WorkflowRecord,
        WorkflowRecordVersion,
        WorkflowConsent,
        WorkflowDeletionRequest,
        WorkflowAppointmentSlot,
        WorkflowAppointment,
        WorkflowRecruitmentApplication,
        WorkflowRecruitmentEvent,
        WorkflowTalentPoolEntry,
        WorkflowTalentPoolEvent,
        WorkflowOutboxMessage,
        WorkflowTicket,
        WorkflowTicketEvent,
        WorkflowPrivacyEvent,
        TalentCandidate,
        TalentFlowSession,
      ],
    });
    await ds.initialize();
    await ds.getRepository(Session).save({ id: sessionId, name: sessionId, config: {} });
    resolveContactPhone = jest.fn().mockResolvedValue(null);
    service = new WorkflowHubService(
      ds,
      ds.getRepository(WorkflowDepartment),
      ds.getRepository(WorkflowInstance),
      ds.getRepository(WorkflowDefinitionVersion),
      ds.getRepository(WorkflowRun),
      ds.getRepository(WorkflowRecord),
      ds.getRepository(WorkflowRecordVersion),
      ds.getRepository(WorkflowConsent),
      ds.getRepository(WorkflowDeletionRequest),
      ds.getRepository(WorkflowAppointmentSlot),
      ds.getRepository(WorkflowAppointment),
      ds.getRepository(WorkflowRecruitmentApplication),
      ds.getRepository(WorkflowRecruitmentEvent),
      ds.getRepository(WorkflowTicket),
      ds.getRepository(WorkflowTicketEvent),
      ds.getRepository(WorkflowPrivacyEvent),
      ds.getRepository(WorkflowOutboxMessage),
      { get: () => ({ resolveContactPhone }) } as unknown as EngineRegistry,
    );
    const flow = await service.createInstance(sessionId, {
      name: 'Banco de talentos',
      keywords: ['talentos'],
      fields: [
        {
          id: 'nome',
          label: 'Nome',
          prompt: 'Qual é o seu nome?',
          type: 'text',
          required: true,
          order: 1,
          min: 3,
          validationScript: 'return { valid: true, value: String(value).toUpperCase() };',
        },
      ],
    });
    await service.publish(sessionId, flow.id);
  });

  afterEach(() => ds.destroy());

  it('reactivates a paused flow with the same published version', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const currentVersionId = flow.currentVersionId;

    const paused = await service.pause(sessionId, flow.id);
    expect(paused).toMatchObject({ status: WorkflowInstanceStatus.PAUSED, currentVersionId });

    const resumed = await service.resume(sessionId, flow.id);
    expect(resumed).toMatchObject({ status: WorkflowInstanceStatus.PUBLISHED, currentVersionId });
    await expect(service.resume(sessionId, flow.id)).rejects.toThrow('Somente um fluxo pausado pode ser reativado');
  });

  it('registers through menu, consent, validation script, review and human silent mode', async () => {
    expect((await service.processInbound(sessionId, 'contact-1', 'contact-1', 'olá'))[0]).toContain('Escolha um fluxo');
    expect((await service.processInbound(sessionId, 'contact-1', 'contact-1', '1'))[0]).toContain('concorda');
    expect((await service.processInbound(sessionId, 'contact-1', 'contact-1', 'sim'))[0]).toContain(
      'Qual é o seu nome',
    );
    expect((await service.processInbound(sessionId, 'contact-1', 'contact-1', 'Rafael'))[0]).toContain('RAFAEL');
    expect((await service.processInbound(sessionId, 'contact-1', 'contact-1', '1'))[0]).toContain('Dados confirmados');
    const record = await ds.getRepository(WorkflowRecord).findOneByOrFail({ contactId: 'contact-1' });
    expect(record.data).toEqual({ nome: 'RAFAEL' });
    expect(await ds.getRepository(WorkflowRecordVersion).count()).toBe(1);
    expect(await ds.getRepository(WorkflowConsent).count()).toBe(1);
    expect((await service.processInbound(sessionId, 'contact-1', 'contact-1', '3'))[0]).toContain(
      'bot ficará em silêncio',
    );
    expect(await service.processInbound(sessionId, 'contact-1', 'contact-1', 'mensagem ao atendente')).toEqual([]);
    expect((await ds.getRepository(WorkflowRun).findOneByOrFail({ contactId: 'contact-1' })).state).toBe(
      WorkflowRunState.HUMAN,
    );
    const ticket = await ds.getRepository(WorkflowTicket).findOneByOrFail({ contactId: 'contact-1' });
    const firstDeadline = ticket.deadlineAt.getTime();
    ticket.deadlineAt = new Date(0);
    await ds.getRepository(WorkflowTicket).save(ticket);
    expect(await service.touchHumanActivity(sessionId, 'contact-1', 'AGENT_MESSAGE', 'operator-1')).toBe(true);
    expect(
      (await ds.getRepository(WorkflowTicket).findOneByOrFail({ id: ticket.id })).deadlineAt.getTime(),
    ).toBeGreaterThan(firstDeadline - 1000);
    expect(
      await ds.getRepository(WorkflowTicketEvent).count({ where: { ticketId: ticket.id } }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('blocks new human tickets while keeping open tickets active until manual closure', async () => {
    await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', 'olá');
    await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', '1');
    await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', 'sim');
    await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', 'Rafael');
    const completed = await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', '1');
    expect(completed[0]).toContain('Falar com atendimento humano');

    expect((await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', '3'))[0]).toContain(
      'bot ficará em silêncio',
    );
    const openTicket = await ds.getRepository(WorkflowTicket).findOneByOrFail({ contactId: 'contact-human-off' });
    const eventCountBefore = await ds.getRepository(WorkflowTicketEvent).count({ where: { ticketId: openTicket.id } });
    const outboxCountBefore = await ds.getRepository(WorkflowOutboxMessage).count();

    const result = await service.setHumanServiceEnabled(sessionId, false);
    expect(result.department.humanServiceEnabled).toBe(false);

    const stillOpenTicket = await ds.getRepository(WorkflowTicket).findOneByOrFail({ id: openTicket.id });
    expect(stillOpenTicket.status).toBe(openTicket.status);
    expect(stillOpenTicket.openKey).toBe(openTicket.openKey);
    expect((await ds.getRepository(WorkflowRun).findOneByOrFail({ contactId: 'contact-human-off' })).state).toBe(
      WorkflowRunState.HUMAN,
    );
    expect(await ds.getRepository(WorkflowTicketEvent).count({ where: { ticketId: openTicket.id } })).toBe(
      eventCountBefore,
    );
    expect(await ds.getRepository(WorkflowOutboxMessage).count()).toBe(outboxCountBefore);
    expect(
      await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', 'ainda preciso de ajuda'),
    ).toEqual([]);

    await service.closeTicket(sessionId, openTicket.id, 'operator-1');
    expect(await ds.getRepository(WorkflowOutboxMessage).count()).toBe(outboxCountBefore + 1);
    expect(
      await ds.getRepository(WorkflowOutboxMessage).findOneBy({ dedupeKey: `ticket-manual-close:${openTicket.id}` }),
    ).toBeTruthy();
    const reopened = await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', 'olá');
    expect(reopened[0]).toContain('Escolha um fluxo');
    const customerMenu = await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', '1');
    expect(customerMenu[0]).not.toContain('Falar com atendimento humano');
    const directAttempt = await service.processInbound(
      sessionId,
      'contact-human-off',
      'contact-human-off',
      'atendimento humano',
    );
    expect(directAttempt[0]).toContain('Opção inválida');
    expect(
      await ds.getRepository(WorkflowTicket).count({
        where: { contactId: 'contact-human-off', openKey: `${result.department.id}:contact-human-off` },
      }),
    ).toBe(0);

    const reenabled = await service.setHumanServiceEnabled(sessionId, true);
    expect(reenabled.department.humanServiceEnabled).toBe(true);
    await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', 'menu');
    const restoredMenu = await service.processInbound(sessionId, 'contact-human-off', 'contact-human-off', '1');
    expect(restoredMenu[0]).toContain('Falar com atendimento humano');
  });

  it('stores CPF answers without punctuation in WhatsApp and administrative updates', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'cpf',
          answerKey: 'cpf',
          label: 'CPF',
          prompt: 'Qual é o seu CPF?',
          type: 'cpf',
          required: true,
          order: 1,
        },
      ],
    });
    await service.publish(sessionId, flow.id);
    await service.processInbound(sessionId, 'cpf-contact', 'cpf-contact', '1');
    await service.processInbound(sessionId, 'cpf-contact', 'cpf-contact', 'sim');
    await service.processInbound(sessionId, 'cpf-contact', 'cpf-contact', '529.982.247-25');
    await service.processInbound(sessionId, 'cpf-contact', 'cpf-contact', '1');

    const record = await ds.getRepository(WorkflowRecord).findOneByOrFail({ contactId: 'cpf-contact' });
    expect(record.data.cpf).toBe('52998224725');

    const updated = await service.updateRecord(
      sessionId,
      record.id,
      { data: { cpf: '168.995.350-09' }, expectedVersion: record.currentVersion },
      'operator-cpf',
    );
    expect(updated.data.cpf).toBe('16899535009');
  });

  it('links a new WhatsApp number to the existing candidate when the CPF matches', async () => {
    const flow = await service.createInstance(sessionId, {
      name: 'Identidade única',
      keywords: ['identidade'],
      fields: [
        {
          id: 'cpf_identidade',
          answerKey: 'cpf',
          label: 'CPF',
          prompt: 'Qual é o seu CPF?',
          type: 'cpf',
          required: true,
          order: 1,
        },
        {
          id: 'nome_identidade',
          answerKey: 'nome',
          label: 'Nome',
          prompt: 'Qual é o seu nome?',
          type: 'text',
          required: true,
          order: 2,
        },
      ],
    });
    await service.updateInstance(sessionId, flow.id, {
      messages: {
        existingCpfLinked: 'Cadastro encontrado. Seu novo WhatsApp foi vinculado.\n\n{menu}',
      },
    });
    await service.publish(sessionId, flow.id);

    const firstNumber = '5531999991111@c.us';
    expect((await service.processInbound(sessionId, firstNumber, firstNumber, 'identidade'))[0]).toContain('concorda');
    expect((await service.processInbound(sessionId, firstNumber, firstNumber, 'sim'))[0]).toContain('CPF');
    expect((await service.processInbound(sessionId, firstNumber, firstNumber, '529.982.247-25'))[0]).toContain('nome');
    expect((await service.processInbound(sessionId, firstNumber, firstNumber, 'Pessoa original'))[0]).toContain(
      'Confira',
    );
    expect((await service.processInbound(sessionId, firstNumber, firstNumber, 'confirmar'))[0]).toContain('salvos');

    const newNumber = '5531888882222@c.us';
    await service.processInbound(sessionId, newNumber, newNumber, 'identidade');
    await service.processInbound(sessionId, newNumber, newNumber, 'sim');
    const linked = (await service.processInbound(sessionId, newNumber, newNumber, '52998224725'))[0];
    expect(linked).toContain('Cadastro encontrado. Seu novo WhatsApp foi vinculado.');
    expect(linked).toContain('*Identidade única*');

    const records = await ds.getRepository(WorkflowRecord).findBy({ instanceId: flow.id });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ contactId: firstNumber, currentVersion: 1 });
    expect(records[0].data).toMatchObject({ cpf: '52998224725', nome: 'Pessoa original' });
    const identities = await ds.getRepository(WorkflowIdentity).findBy({ departmentId: flow.departmentId });
    expect(identities).toHaveLength(1);
    expect(identities[0].cpf).toBe('52998224725');
    const contacts = await ds.getRepository(WorkflowIdentityContact).findBy({ identityId: identities[0].id });
    expect(contacts.map(contact => contact.contactId).sort()).toEqual([firstNumber, newNumber].sort());
    const listed = (await service.listRecords(sessionId)).find(item => item.id === records[0].id)!;
    const firstLink = listed.linkedContacts.find(contact => contact.contactId === firstNumber)!;
    const newLink = listed.linkedContacts.find(contact => contact.contactId === newNumber)!;
    expect(firstLink.isPrimary).toBe(true);

    await service.updateRecordContact(sessionId, records[0].id, newLink.id, '5531777773333', 'operator-1');
    await expect(
      service.updateRecordContact(sessionId, records[0].id, newLink.id, '5531999991111', 'operator-1'),
    ).rejects.toThrow('já está vinculado');

    await service.setPrimaryRecordContact(sessionId, records[0].id, newLink.id, 'operator-1');
    const primaryChanged = (await service.listRecords(sessionId)).find(item => item.id === records[0].id)!;
    expect(primaryChanged.contactId).toBe(newNumber);
    expect(primaryChanged.linkedContacts.find(contact => contact.id === newLink.id)?.isPrimary).toBe(true);

    await service.deleteRecordContact(sessionId, records[0].id, firstLink.id, 'operator-1');
    expect((await service.listRecords(sessionId)).find(item => item.id === records[0].id)?.linkedContacts).toHaveLength(
      1,
    );
    await expect(service.deleteRecordContact(sessionId, records[0].id, newLink.id, 'operator-1')).rejects.toThrow(
      'último número',
    );
    const securityNotice = await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({ chatId: firstNumber });
    expect(securityNotice.body).toContain('Aviso de segurança');
  });

  it('renders editable department and flow messages with dynamic variables', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.updateDepartment(sessionId, {
      messages: { sectorMenu: 'Olá, aqui é {setor}.\n{fluxos}' },
    });
    await service.updateInstance(sessionId, flow.id, {
      messages: {
        consent: 'Autorização para {fluxo}? {contexto}Responda SIM.',
        review: 'Revise agora:\n{resumo}',
      },
    });

    expect((await service.processInbound(sessionId, 'custom-messages', 'custom-messages', 'oi'))[0]).toContain(
      'Olá, aqui é Meu setor.\n1. Banco de talentos',
    );
    expect((await service.processInbound(sessionId, 'custom-messages', 'custom-messages', '1'))[0]).toBe(
      'Autorização para Banco de talentos? Responda SIM.',
    );
    await service.processInbound(sessionId, 'custom-messages', 'custom-messages', 'sim');
    expect((await service.processInbound(sessionId, 'custom-messages', 'custom-messages', 'Rafael'))[0]).toContain(
      'Revise agora:\n*Nome:* RAFAEL',
    );
  });

  it('reports when the proximity diagnostic has no georeferenced interview locations', async () => {
    await expect(service.testProximity(sessionId, 'Rua Teste, 10, Centro, Belo Horizonte, MG')).resolves.toMatchObject({
      success: false,
      errorCode: 'NO_GEOREFERENCED_LOCATIONS',
      destinationCount: 0,
    });
  });

  it('protects the required dynamic content of editable message templates', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await expect(
      service.updateDepartment(sessionId, { messages: { sectorMenu: 'Escolha uma opção' } }),
    ).rejects.toThrow('{fluxos}');
    await expect(service.updateInstance(sessionId, flow.id, { messages: { review: 'Tudo certo?' } })).rejects.toThrow(
      '{resumo}',
    );
  });

  it('persists the candidate table order and visibility once per department', async () => {
    await service.updateDepartment(sessionId, {
      candidateTableColumns: [
        { id: 'contact', visible: true },
        { id: 'answer:nome', visible: false },
        { id: 'name', visible: true },
        // Repeated submissions must not create duplicate columns.
        { id: 'contact', visible: false },
      ],
    });

    await expect(service.getDepartment(sessionId)).resolves.toMatchObject({
      candidateTableColumns: [
        { id: 'contact', visible: true },
        { id: 'answer:nome', visible: false },
        { id: 'name', visible: true },
      ],
    });
  });

  it('stores only reusable location data and rejects duplicate internal names', async () => {
    const schedule = {
      timezone: 'America/Sao_Paulo',
      weekdays: {},
      exceptions: [],
      locations: [
        {
          id: 'unidade_centro',
          internalName: 'Matriz — Centro',
          name: 'Unidade Centro',
          address: 'Rua das Flores, 100',
          mapsUrl: 'https://maps.google.com/?q=Centro',
          notificationContacts: [
            {
              id: 'centro-gerente',
              role: 'RH',
              name: '  Amanda  ',
              ddi: '+55',
              ddd: '(31)',
              number: '99999-1111',
              enabled: true,
            },
          ],
          // Legacy scheduling defaults must not remain attached to the reusable location.
          instruction: 'Apresente-se na recepção',
          responsible: 'Amanda',
          capacity: 4,
        },
      ],
    };
    await expect(service.updateDepartment(sessionId, { schedule })).resolves.toMatchObject({
      schedule: {
        ...schedule,
        locations: [
          {
            id: 'unidade_centro',
            internalName: 'Matriz — Centro',
            name: 'Unidade Centro',
            address: 'Rua das Flores, 100',
            mapsUrl: 'https://maps.google.com/?q=Centro',
            notificationContacts: [
              {
                id: 'centro-gerente',
                role: 'RH',
                name: 'Amanda',
                ddi: '55',
                ddd: '31',
                number: '999991111',
                enabled: true,
              },
            ],
          },
        ],
      },
    });
    await expect(
      service.updateDepartment(sessionId, {
        schedule: {
          ...schedule,
          locations: [
            ...schedule.locations,
            { ...schedule.locations[0], id: 'outra', internalName: 'matriz — centro' },
          ],
        },
      }),
    ).rejects.toThrow('nomes diferentes');
  });

  it('cancels delayed appointment notifications whose appointment no longer exists', async () => {
    const row = await ds.getRepository(WorkflowOutboxMessage).save({
      sessionId,
      chatId: 'stale-contact',
      body: 'Aviso antigo',
      dedupeKey: 'appointment-cancelled:missing-appointment',
      status: WorkflowOutboxStatus.FAILED,
      attempts: 3,
      maxAttempts: 3,
      nextAttemptAt: new Date(),
      sentAt: null,
      lastError: 'offline',
    });

    expect(await service.cancelStaleOutboxMessages()).toBe(1);
    expect(await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({ id: row.id })).toMatchObject({
      status: WorkflowOutboxStatus.CANCELLED,
    });
  });

  it('reports outbox health without exposing message content, destination or raw errors', async () => {
    await ds.getRepository(WorkflowOutboxMessage).save({
      sessionId,
      chatId: '5511999999999@c.us',
      body: 'Mensagem confidencial',
      dedupeKey: 'health-failure',
      status: WorkflowOutboxStatus.FAILED,
      attempts: 4,
      maxAttempts: 3,
      nextAttemptAt: new Date(),
      sentAt: null,
      lastError: 'WhatsApp disconnected for 5511999999999',
    });

    const health = await service.outboxHealth(sessionId);

    expect(health.counts[WorkflowOutboxStatus.FAILED]).toBe(1);
    expect(health.failures[0]).toMatchObject({ reason: 'SEM_CONEXAO', exhausted: true });
    expect(health.unsent[0]).toMatchObject({ status: WorkflowOutboxStatus.FAILED, reason: 'SEM_CONEXAO' });
    expect(JSON.stringify(health)).not.toContain('Mensagem confidencial');
    expect(JSON.stringify(health)).not.toContain('5511999999999');
    expect(JSON.stringify(health)).not.toContain('disconnected');
  });

  it('reenables exactly one controlled attempt for an exhausted current outbox message', async () => {
    const row = await ds.getRepository(WorkflowOutboxMessage).save({
      sessionId,
      chatId: 'retry-contact',
      body: 'Mensagem',
      dedupeKey: 'manual-retry',
      status: WorkflowOutboxStatus.FAILED,
      attempts: 4,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() + 60_000),
      sentAt: null,
      lastError: 'offline',
    });

    await service.retryOutboxMessage(sessionId, row.id);

    const retried = await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({ id: row.id });
    expect(retried).toMatchObject({
      status: WorkflowOutboxStatus.RETRYING,
      attempts: 4,
      maxAttempts: 4,
      dedupeKey: 'manual-retry',
    });
    expect(retried.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('discards an unsent message without deleting its audit trail and refuses cross-session access', async () => {
    const row = await ds.getRepository(WorkflowOutboxMessage).save({
      sessionId,
      chatId: 'discard-contact',
      body: 'Mensagem',
      dedupeKey: 'manual-discard',
      status: WorkflowOutboxStatus.RETRYING,
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAt: new Date(),
      sentAt: null,
      lastError: 'offline',
    });

    await expect(service.discardOutboxMessage('other-session', row.id)).rejects.toThrow('Envio não encontrado');
    await service.discardOutboxMessage(sessionId, row.id);

    expect(await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({ id: row.id })).toMatchObject({
      status: WorkflowOutboxStatus.CANCELLED,
      dedupeKey: 'manual-discard',
    });
    await expect(service.retryOutboxMessage(sessionId, row.id)).rejects.toThrow('Somente um envio');
  });

  it('renders and executes the configurable post-registration menu instead of fixed option numbers', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.updateInstance(sessionId, flow.id, {
      recordMenu: {
        title: 'Central do usuário',
        actions: [
          { action: WorkflowRecordMenuAction.CLOSE, label: 'Finalizar minha conversa', enabled: true },
          { action: WorkflowRecordMenuAction.HUMAN, label: 'Conversar com a equipe', enabled: true },
          { action: WorkflowRecordMenuAction.VIEW, label: 'Ver informações', enabled: false },
        ],
      },
    });

    await service.processInbound(sessionId, 'custom-menu', 'custom-menu', '1');
    await service.processInbound(sessionId, 'custom-menu', 'custom-menu', 'sim');
    await service.processInbound(sessionId, 'custom-menu', 'custom-menu', 'Rafael');
    const completed = (await service.processInbound(sessionId, 'custom-menu', 'custom-menu', '1'))[0];

    expect(completed).toContain('*Central do usuário*');
    expect(completed).toContain('1. Finalizar minha conversa');
    expect(completed).toContain('2. Conversar com a equipe');
    expect(completed).not.toContain('Ver informações');
    expect((await service.processInbound(sessionId, 'custom-menu', 'custom-menu', '1'))[0]).toContain(
      'Atendimento encerrado',
    );
  });

  it('shows appointment actions only with a future booking and lets the customer reschedule it', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const contactId = 'customer-self-reschedule';
    await service.processInbound(sessionId, contactId, contactId, '1');
    await service.processInbound(sessionId, contactId, contactId, 'sim');
    await service.processInbound(sessionId, contactId, contactId, 'Rafael');
    const menuWithoutAppointment = (await service.processInbound(sessionId, contactId, contactId, '1'))[0];
    expect(menuWithoutAppointment).not.toContain('Visualizar minha entrevista');

    const [currentSlot, nextSlot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        { startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 2, location: 'Sala atual' },
        { startsAt: new Date(Date.now() + 172_800_000).toISOString(), capacity: 2, location: 'Sala nova' },
      ],
    });
    await ds.getRepository(WorkflowAppointmentSlot).update(currentSlot.id, { bookedCount: 1 });
    const record = await ds.getRepository(WorkflowRecord).findOneByOrFail({ instanceId: flow.id, contactId });
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: currentSlot.id,
      instanceId: flow.id,
      contactId,
      recordId: record.id,
      status: AppointmentStatus.CONFIRMED,
      cancelledAt: null,
      reminderSentAt: null,
    });

    const appointmentMenu = (await service.processInbound(sessionId, contactId, contactId, '0'))[0];
    expect(appointmentMenu).toContain('Visualizar minha entrevista');
    expect(appointmentMenu).toContain('Remarcar minha entrevista');
    expect((await service.processInbound(sessionId, contactId, contactId, '3'))[0]).toContain('Sala atual');
    expect((await service.processInbound(sessionId, contactId, contactId, '4'))[0]).toContain('Sala nova');
    const confirmation = (await service.processInbound(sessionId, contactId, contactId, '1'))[0];
    expect(confirmation).toContain('Sua entrevista foi reagendada com sucesso');
    expect(confirmation).toContain('Sala nova');
    expect((await ds.getRepository(WorkflowAppointment).findOneByOrFail({ id: appointment.id })).status).toBe(
      AppointmentStatus.CANCELLED,
    );
    expect(
      await ds.getRepository(WorkflowOutboxMessage).exists({
        where: { dedupeKey: `appointment-rescheduled:${appointment.id}:${nextSlot.id}` },
      }),
    ).toBe(false);
  });

  it('refuses a post-registration menu without any enabled action', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await expect(
      service.updateInstance(sessionId, flow.id, {
        recordMenu: {
          title: '',
          actions: [{ action: WorkflowRecordMenuAction.CLOSE, label: 'Encerrar', enabled: false }],
        },
      }),
    ).rejects.toThrow('Ative pelo menos uma ação');
  });

  it('persists PULAR as an explicit answer and does not request the optional field again', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'apelido',
          label: 'Apelido',
          prompt: 'Qual é o seu apelido?',
          type: 'text',
          required: false,
          order: 1,
        },
      ],
    });
    await service.publish(sessionId, flow.id);

    await service.processInbound(sessionId, 'contact-skip', 'contact-skip', '1');
    await service.processInbound(sessionId, 'contact-skip', 'contact-skip', 'sim');
    expect((await service.processInbound(sessionId, 'contact-skip', 'contact-skip', 'PULAR'))[0]).toContain(
      'optou por pular',
    );
    await service.processInbound(sessionId, 'contact-skip', 'contact-skip', '1');
    const record = await ds.getRepository(WorkflowRecord).findOneByOrFail({ contactId: 'contact-skip' });
    expect(record.data.apelido).toBe('__OPENWA_SKIPPED__');

    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'apelido',
          label: 'Apelido',
          prompt: 'Qual é o seu apelido?',
          type: 'text',
          required: false,
          order: 1,
        },
      ],
    });
    await service.publish(sessionId, flow.id);
    const nextAccess = await service.processInbound(sessionId, 'contact-skip', 'contact-skip', 'oi');
    expect(nextAccess[0]).toContain('Consultar meus dados');
    expect(nextAccess[0]).not.toContain('novas perguntas');

    const legacyRecord = await ds.getRepository(WorkflowRecord).findOneByOrFail({ contactId: 'contact-skip' });
    legacyRecord.data = { apelido: null };
    await ds.getRepository(WorkflowRecord).save(legacyRecord);
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'apelido',
          label: 'Apelido',
          prompt: 'Qual é o seu apelido?',
          type: 'text',
          required: false,
          order: 1,
        },
      ],
    });
    await service.publish(sessionId, flow.id);
    const legacyNextAccess = await service.processInbound(sessionId, 'contact-skip', 'contact-skip', 'oi');
    expect(legacyNextAccess[0]).not.toContain('novas perguntas');
  });

  it('expires a partial flow, clears its draft and starts fresh on the next message', async () => {
    await service.processInbound(sessionId, 'contact-2', 'contact-2', '1');
    const run = await ds.getRepository(WorkflowRun).findOneByOrFail({ contactId: 'contact-2' });
    run.deadlineAt = new Date(0);
    await ds.getRepository(WorkflowRun).save(run);
    const notices = await service.sweepDeadlines(new Date());
    expect(notices[0].text).toContain('respostas temporárias foram apagadas');
    expect((await ds.getRepository(WorkflowRun).findOneByOrFail({ id: run.id })).openKey).toBeNull();
    expect((await service.processInbound(sessionId, 'contact-2', 'contact-2', 'oi'))[0]).toContain('Escolha um fluxo');
  });

  it('collects the full applicable questionnaire when a published version adds a relevant field', async () => {
    await service.processInbound(sessionId, 'contact-schema', 'contact-schema', '1');
    await service.processInbound(sessionId, 'contact-schema', 'contact-schema', 'sim');
    await service.processInbound(sessionId, 'contact-schema', 'contact-schema', 'Rafael');
    await service.processInbound(sessionId, 'contact-schema', 'contact-schema', '1');

    const flow = (await service.listInstances(sessionId))[0];
    const published = flow.versions.find(version => version.status === WorkflowVersionStatus.PUBLISHED)!;
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        ...published.fields,
        { id: 'telefone', label: 'Telefone', prompt: 'Qual é seu telefone?', type: 'phone', required: true, order: 2 },
      ],
    });
    await service.publish(sessionId, flow.id);

    expect((await service.processInbound(sessionId, 'contact-schema', 'contact-schema', 'oi'))[0]).toContain(
      'novas perguntas',
    );
    expect((await service.processInbound(sessionId, 'contact-schema', 'contact-schema', 'sim'))[0]).toContain(
      'Qual é o seu nome',
    );
    expect(
      (await service.processInbound(sessionId, 'contact-schema', 'contact-schema', 'Rafael atualizado'))[0],
    ).toContain('Qual é seu telefone');
    expect((await service.processInbound(sessionId, 'contact-schema', 'contact-schema', '11999999999'))[0]).toContain(
      'RAFAEL ATUALIZADO',
    );
    await service.processInbound(sessionId, 'contact-schema', 'contact-schema', '1');
    const record = await ds.getRepository(WorkflowRecord).findOneByOrFail({ contactId: 'contact-schema' });
    expect(record.data).toEqual({ nome: 'RAFAEL ATUALIZADO', telefone: '11999999999' });
    expect(record.definitionVersionId).toBe(
      (await ds.getRepository(WorkflowInstance).findOneByOrFail({ id: flow.id })).currentVersionId,
    );
  });

  it('does not append multiselect instructions that were not written in the question', async () => {
    const flow = await service.createInstance(sessionId, {
      name: 'Experiência',
      keywords: ['experiencia'],
      fields: [
        {
          id: 'experiencia_anterior',
          label: 'Experiência anterior',
          prompt: '💼 Você já trabalhou nessa função anteriormente?\n\n{opções}',
          type: 'multiselect',
          required: true,
          order: 1,
          options: ['Sim', 'Não'],
        },
      ],
    });
    await service.publish(sessionId, flow.id);

    await service.processInbound(sessionId, 'multiselect-copy', 'multiselect-copy', 'experiencia');
    const question = (await service.processInbound(sessionId, 'multiselect-copy', 'multiselect-copy', 'sim'))[0];

    expect(question).toContain('1. Sim\n2. Não');
    expect(question).not.toContain('Envie os números separados por vírgula.');
  });

  it('branches to different questions according to the selected option', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'destino',
          label: 'Destino',
          prompt: 'O que deseja criar?',
          type: 'select',
          required: true,
          order: 1,
          options: ['Cadastro', 'Agenda'],
        },
        {
          id: 'etapa_cadastro',
          answerKey: 'detalhe',
          label: 'Cadastro',
          prompt: 'Qual cadastro deseja criar?',
          type: 'text',
          required: true,
          order: 2,
          visibleWhen: { fieldId: 'destino', operator: 'equals', value: 'Cadastro' },
        },
        {
          id: 'etapa_agenda',
          answerKey: 'detalhe',
          label: 'Agenda',
          prompt: 'Qual horário deseja reservar?',
          type: 'text',
          required: true,
          order: 3,
          visibleWhen: { fieldId: 'destino', operator: 'equals', value: 'Agenda' },
        },
      ],
    });
    await service.publish(sessionId, flow.id);

    await service.processInbound(sessionId, 'contact-branch-1', 'contact-branch-1', '1');
    await service.processInbound(sessionId, 'contact-branch-1', 'contact-branch-1', 'sim');
    expect((await service.processInbound(sessionId, 'contact-branch-1', 'contact-branch-1', '1'))[0]).toContain(
      'Qual cadastro deseja criar',
    );
    expect(
      (await service.processInbound(sessionId, 'contact-branch-1', 'contact-branch-1', 'Currículo'))[0],
    ).not.toContain('Qual horário deseja reservar');
    await service.processInbound(sessionId, 'contact-branch-1', 'contact-branch-1', '1');
    expect((await ds.getRepository(WorkflowRecord).findOneByOrFail({ contactId: 'contact-branch-1' })).data).toEqual({
      destino: 'Cadastro',
      detalhe: 'Currículo',
    });

    await service.processInbound(sessionId, 'contact-branch-2', 'contact-branch-2', '1');
    await service.processInbound(sessionId, 'contact-branch-2', 'contact-branch-2', 'sim');
    expect((await service.processInbound(sessionId, 'contact-branch-2', 'contact-branch-2', '2'))[0]).toContain(
      'Qual horário deseja reservar',
    );
    await service.processInbound(sessionId, 'contact-branch-2', 'contact-branch-2', 'Amanhã');
    await service.processInbound(sessionId, 'contact-branch-2', 'contact-branch-2', '1');
    expect((await ds.getRepository(WorkflowRecord).findOneByOrFail({ contactId: 'contact-branch-2' })).data).toEqual({
      destino: 'Agenda',
      detalhe: 'Amanhã',
    });
  });

  it('executes visual message blocks and conditional diagram connections', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const fields = [
      {
        id: 'aceite',
        label: 'Aceite',
        prompt: 'Deseja continuar?',
        type: 'select' as const,
        required: true,
        order: 1,
        options: ['Sim', 'Não'],
      },
    ];
    await service.saveDraft(sessionId, flow.id, {
      fields,
      definition: {
        graph: {
          version: 1,
          startNodeId: 'start',
          nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Início' } },
            {
              id: 'question:aceite',
              type: 'question',
              position: { x: 200, y: 0 },
              data: { fieldId: 'aceite', label: 'Aceite' },
            },
            {
              id: 'message:yes',
              type: 'message',
              position: { x: 400, y: 0 },
              data: { label: 'Caminho sim', text: 'Você escolheu continuar.' },
            },
            {
              id: 'message:no',
              type: 'message',
              position: { x: 400, y: 150 },
              data: { label: 'Caminho padrão', text: 'Você escolheu não continuar.' },
            },
            { id: 'review', type: 'review', position: { x: 600, y: 0 }, data: { label: 'Revisão' } },
          ],
          edges: [
            { id: 'e1', source: 'start', target: 'question:aceite' },
            {
              id: 'e2',
              source: 'question:aceite',
              target: 'message:yes',
              condition: { operator: 'equals', value: 'Sim' },
            },
            { id: 'e3', source: 'question:aceite', target: 'message:no' },
            { id: 'e4', source: 'message:yes', target: 'review' },
            { id: 'e5', source: 'message:no', target: 'review' },
          ],
        },
      },
    });
    await service.publish(sessionId, flow.id);

    await service.processInbound(sessionId, 'graph-yes', 'graph-yes', '1');
    expect((await service.processInbound(sessionId, 'graph-yes', 'graph-yes', 'sim'))[0]).toContain('Deseja continuar');
    const yesReplies = await service.processInbound(sessionId, 'graph-yes', 'graph-yes', '1');
    expect(yesReplies).toHaveLength(2);
    expect(yesReplies[0]).toBe('Você escolheu continuar.');
    expect(yesReplies[1]).toContain('Confira suas respostas');

    await service.processInbound(sessionId, 'graph-no', 'graph-no', '1');
    await service.processInbound(sessionId, 'graph-no', 'graph-no', 'sim');
    const noReplies = await service.processInbound(sessionId, 'graph-no', 'graph-no', '2');
    expect(noReplies[0]).toBe('Você escolheu não continuar.');
  });

  it('does not request a schema update when every new field belongs to another saved-answer path', async () => {
    const flow = await service.createInstance(sessionId, {
      name: 'Vagas',
      keywords: ['vagas'],
      fields: [
        {
          id: 'perfil',
          label: 'Perfil',
          prompt: 'Qual é o seu perfil?',
          type: 'select',
          required: true,
          order: 1,
          options: ['Primeiro Emprego', 'Com Experiência'],
        },
      ],
    });
    await service.publish(sessionId, flow.id);
    const previousVersionId = (await service.listInstances(sessionId)).find(
      row => row.id === flow.id,
    )?.currentVersionId;
    await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'schema-path',
      phone: null,
      status: WorkflowRecordStatus.VALID,
      data: { perfil: 'Primeiro Emprego' },
      currentVersion: 1,
      definitionVersionId: previousVersionId,
      validUntil: new Date(Date.now() + 86_400_000),
      reminderSentAt: null,
    });

    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'perfil',
          label: 'Perfil',
          prompt: 'Qual é o seu perfil?',
          type: 'select',
          required: true,
          order: 1,
          options: ['Primeiro Emprego', 'Com Experiência'],
        },
        {
          id: 'experiencia',
          label: 'Experiência',
          prompt: 'Descreva sua experiência.',
          type: 'textarea',
          required: true,
          order: 2,
        },
      ],
      definition: {
        graph: {
          version: 1,
          startNodeId: 'start',
          nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
            { id: 'question:perfil', type: 'question', position: { x: 200, y: 0 }, data: { fieldId: 'perfil' } },
            {
              id: 'question:experiencia',
              type: 'question',
              position: { x: 400, y: 100 },
              data: { fieldId: 'experiencia' },
            },
            { id: 'review', type: 'review', position: { x: 600, y: 0 }, data: {} },
          ],
          edges: [
            { id: 'e1', source: 'start', target: 'question:perfil' },
            {
              id: 'e2',
              source: 'question:perfil',
              target: 'question:experiencia',
              condition: { operator: 'equals', value: 'Com Experiência' },
            },
            { id: 'e3', source: 'question:perfil', target: 'review' },
            { id: 'e4', source: 'question:experiencia', target: 'review' },
          ],
        },
      },
    });
    await service.publish(sessionId, flow.id);

    const reply = (await service.processInbound(sessionId, 'schema-path', 'schema-path', 'vagas'))[0];
    expect(reply).toContain('Consultar meus dados');
    expect(reply).not.toContain('novas perguntas');
    expect(reply).not.toContain('consentimento');
    const record = await ds.getRepository(WorkflowRecord).findOneByOrFail({
      instanceId: flow.id,
      contactId: 'schema-path',
    });
    expect(record.definitionVersionId).toBe(
      (await service.listInstances(sessionId)).find(row => row.id === flow.id)?.currentVersionId,
    );
  });

  it('rejects a visual diagram with disconnected blocks before publication', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await expect(
      service.saveDraft(sessionId, flow.id, {
        fields: [{ id: 'nome', label: 'Nome', prompt: 'Nome?', type: 'text', required: true, order: 1 }],
        definition: {
          graph: {
            version: 1,
            startNodeId: 'start',
            nodes: [
              { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
              {
                id: 'question:nome',
                type: 'question',
                position: { x: 200, y: 0 },
                data: { fieldId: 'nome' },
              },
              { id: 'review', type: 'review', position: { x: 400, y: 0 }, data: {} },
            ],
            edges: [{ id: 'e1', source: 'start', target: 'review' }],
          },
        },
      }),
    ).rejects.toThrow('não está conectado');
  });

  it('rejects a reused answer key when both questions can occur in the same path', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await expect(
      service.saveDraft(sessionId, flow.id, {
        fields: [
          {
            id: 'beneficio_a',
            answerKey: 'beneficios',
            label: 'Benefício A',
            prompt: 'A?',
            type: 'text',
            required: true,
            order: 1,
          },
          {
            id: 'beneficio_b',
            answerKey: 'beneficios',
            label: 'Benefício B',
            prompt: 'B?',
            type: 'text',
            required: true,
            order: 2,
          },
        ],
      }),
    ).rejects.toThrow('podem ocorrer no mesmo caminho');
  });

  it('allows a reused answer key on mutually exclusive conditional questions', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await expect(
      service.saveDraft(sessionId, flow.id, {
        fields: [
          { id: 'area', label: 'Área', prompt: 'Área?', type: 'select', required: true, order: 1, options: ['A', 'B'] },
          {
            id: 'beneficio_a',
            answerKey: 'beneficios',
            label: 'Benefício A',
            prompt: 'A?',
            type: 'text',
            required: true,
            order: 2,
            visibleWhen: { fieldId: 'area', operator: 'equals', value: 'A' },
          },
          {
            id: 'beneficio_b',
            answerKey: 'beneficios',
            label: 'Benefício B',
            prompt: 'B?',
            type: 'text',
            required: true,
            order: 3,
            visibleWhen: { fieldId: 'area', operator: 'equals', value: 'B' },
          },
        ],
      }),
    ).resolves.toMatchObject({ status: WorkflowVersionStatus.DRAFT });
  });

  it('preserves the configured talent-pool option on an existing select question', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const draft = await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'area_interesse',
          answerKey: 'area_interesse',
          label: 'Área de interesse',
          prompt: 'Qual vaga você procura?',
          type: 'select',
          required: true,
          order: 1,
          options: ['Auxiliar de Churrasco', 'Banco de Talentos'],
          talentPoolOption: 'Banco de Talentos',
        },
      ],
    });

    expect(draft.fields[0]).toMatchObject({ talentPoolOption: 'Banco de Talentos' });
  });

  it('rejects a talent-pool marker that is not one of the question options', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await expect(
      service.saveDraft(sessionId, flow.id, {
        fields: [
          {
            id: 'area_interesse',
            label: 'Área de interesse',
            prompt: 'Qual vaga você procura?',
            type: 'select',
            required: true,
            order: 1,
            options: ['Auxiliar de Churrasco'],
            talentPoolOption: 'Banco de Talentos',
          },
        ],
      }),
    ).rejects.toThrow('opção de Banco de Talentos');
  });

  it('separates a talent-pool registration and converts it when an interview is scheduled', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'area_interesse',
          label: 'Área de interesse',
          prompt: 'Qual vaga você procura?',
          type: 'select',
          required: true,
          order: 1,
          options: ['Auxiliar de Churrasco', 'Banco de Talentos'],
          talentPoolOption: 'Banco de Talentos',
        },
      ],
    });
    const published = await service.publish(sessionId, flow.id);
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      identityId: null,
      contactId: 'talent-pool-conversion',
      phone: '5531999991234',
      status: WorkflowRecordStatus.VALID,
      data: { area_interesse: 'Banco de Talentos' },
      currentVersion: 1,
      definitionVersionId: published.currentVersionId,
      validUntil: new Date(Date.now() + 86_400_000),
      reminderSentAt: null,
      proximityStatus: WorkflowProximityStatus.MISSING_DATA,
      proximityData: null,
      proximityAttempts: 0,
      proximityRevision: 0,
      proximityNextAttemptAt: null,
    });

    const [entry] = await service.listTalentPoolEntries(sessionId);
    expect(entry).toMatchObject({ recordId: record.id, status: WorkflowTalentPoolStatus.AVAILABLE });
    await service.updateTalentPoolEntry(
      sessionId,
      entry.id,
      { status: WorkflowTalentPoolStatus.CONTACTED, note: 'Primeiro contato realizado.' },
      'operator-1',
    );

    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 172_800_000).toISOString(), capacity: 1, location: 'Matriz' }],
    });
    await service.scheduleRecordAppointment(sessionId, flow.id, record.id, slot.id);

    expect(await service.listTalentPoolEntries(sessionId)).toEqual([]);
    expect(await ds.getRepository(WorkflowTalentPoolEntry).findOneByOrFail({ id: entry.id })).toMatchObject({
      status: WorkflowTalentPoolStatus.CONVERTED,
    });
    expect((await service.listTalentPoolEvents(sessionId, entry.id)).map(event => event.type)).toEqual(
      expect.arrayContaining(['TALENT_POOL_REGISTERED', 'STATUS_CHANGED', 'CONVERTED_TO_CANDIDATE']),
    );
  });

  it('queues a single confirmation after approved personal-data deletion', async () => {
    await service.processInbound(sessionId, 'contact-delete', 'contact-delete', '1');
    await service.processInbound(sessionId, 'contact-delete', 'contact-delete', 'sim');
    await service.processInbound(sessionId, 'contact-delete', 'contact-delete', 'Rafael');
    await service.processInbound(sessionId, 'contact-delete', 'contact-delete', '1');
    await service.processInbound(sessionId, 'contact-delete', 'contact-delete', '5');
    const legacyCandidate = await ds.getRepository(TalentCandidate).save({
      sessionId,
      contactId: 'contact-delete',
      phone: null,
      data: { nome: 'cópia antiga' },
    });
    await ds.getRepository(TalentFlowSession).save({
      sessionId,
      contactId: 'contact-delete',
      chatId: 'contact-delete',
      candidateId: legacyCandidate.id,
      state: TalentFlowState.MENU,
      step: 0,
      draft: {},
      lastMessageId: null,
      deadlineAt: new Date(Date.now() + 60_000),
    });
    const request = (await service.listDeletionRequests(sessionId))[0];
    const stale = await ds.getRepository(WorkflowOutboxMessage).save({
      sessionId,
      chatId: 'contact-delete',
      body: 'Aviso antigo de agenda',
      dedupeKey: 'appointment-cancelled:already-removed',
      status: WorkflowOutboxStatus.FAILED,
      attempts: 3,
      maxAttempts: 3,
      nextAttemptAt: new Date(),
      sentAt: null,
      lastError: 'indisponível',
    });
    await service.decideDeletion(sessionId, request.id, true, 'admin');
    expect(await ds.getRepository(WorkflowRecord).count({ where: { contactId: 'contact-delete' } })).toBe(0);
    expect(await ds.getRepository(TalentCandidate).count({ where: { contactId: 'contact-delete' } })).toBe(0);
    expect(await ds.getRepository(TalentFlowSession).count({ where: { contactId: 'contact-delete' } })).toBe(0);
    const notification = await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({
      dedupeKey: `privacy-deletion:${request.id}`,
    });
    expect(notification.body).toContain('dados pessoais foram excluídos');
    expect(await ds.getRepository(WorkflowOutboxMessage).findOneBy({ id: stale.id })).toBeNull();
  });

  it('allows multiple candidates up to the configured interview capacity', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'entrevista',
          label: 'Entrevista',
          prompt: 'Escolha o horário da entrevista:',
          type: 'appointment',
          required: true,
          order: 1,
        },
      ],
    });
    await service.publish(sessionId, flow.id);
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 2 }],
    });

    for (const contactId of ['capacity-1', 'capacity-2']) {
      await service.processInbound(sessionId, contactId, contactId, '1');
      await service.processInbound(sessionId, contactId, contactId, 'sim');
      await service.processInbound(sessionId, contactId, contactId, '1');
      await service.processInbound(sessionId, contactId, contactId, '1');
    }

    const filled = await ds.getRepository(WorkflowAppointmentSlot).findOneByOrFail({ id: slot.id });
    expect(filled.bookedCount).toBe(2);
    expect(filled.capacity).toBe(2);
    expect(filled.status).toBe(AppointmentSlotStatus.CONFIRMED);
    expect(await ds.getRepository(WorkflowAppointment).count({ where: { slotId: slot.id } })).toBe(2);

    await service.processInbound(sessionId, 'capacity-3', 'capacity-3', '1');
    expect((await service.processInbound(sessionId, 'capacity-3', 'capacity-3', 'sim'))[0]).toContain(
      'Não há horários disponíveis',
    );
  });

  it('marks a candidate appointment manually with capacity, history and notification', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'manual-appointment',
      phone: '5531999999999',
      data: { nome: 'Candidato manual' },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 1, location: 'Matriz' }],
    });

    const appointment = await service.scheduleRecordAppointment(sessionId, flow.id, record.id, slot.id);

    expect(appointment).toMatchObject({ contactId: record.contactId, status: AppointmentStatus.CONFIRMED });
    expect(await ds.getRepository(WorkflowAppointmentSlot).findOneByOrFail({ id: slot.id })).toMatchObject({
      bookedCount: 1,
      status: AppointmentSlotStatus.CONFIRMED,
    });
    expect(
      await ds.getRepository(WorkflowOutboxMessage).count({
        where: { dedupeKey: `appointment-confirmed:${appointment.id}:2` },
      }),
    ).toBe(1);
    expect(
      await ds.getRepository(WorkflowRecruitmentApplication).count({
        where: { instanceId: flow.id, contactId: record.contactId },
      }),
    ).toBe(1);
  });

  it('starts the selection process in the phase configured on the interview slot', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'focused-interview',
      phone: '5531999999999',
      data: { nome: 'Candidato da segunda fase' },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        {
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          interviewPhase: WorkflowInterviewPhase.FOCUSED,
        },
      ],
    });

    await service.scheduleRecordAppointment(sessionId, flow.id, record.id, slot.id);

    const [application] = await service.listRecruitmentApplications(sessionId);
    expect(application.status).toBe(WorkflowRecruitmentStatus.APPROVED);
    expect(application.appointment?.slot.interviewPhase).toBe(WorkflowInterviewPhase.FOCUSED);

    await service.updateSlot(sessionId, flow.id, slot.id, { interviewPhase: WorkflowInterviewPhase.HIRING });
    expect((await service.listRecruitmentApplications(sessionId))[0].status).toBe(
      WorkflowRecruitmentStatus.DOCUMENTATION,
    );
    const hired = await service.updateRecruitmentApplication(
      sessionId,
      application.id,
      { status: WorkflowRecruitmentStatus.HIRED },
      'operator-1',
    );
    expect(hired.status).toBe(WorkflowRecruitmentStatus.HIRED);
    await expect(
      service.updateRecruitmentApplication(
        sessionId,
        application.id,
        { status: WorkflowRecruitmentStatus.DOCUMENTATION },
        'operator-1',
      ),
    ).rejects.toThrow('Esta mudança de etapa não é permitida');
    const withdrawn = await service.updateRecruitmentApplication(
      sessionId,
      application.id,
      { status: WorkflowRecruitmentStatus.WITHDRAWN },
      'operator-1',
    );
    expect(withdrawn.status).toBe(WorkflowRecruitmentStatus.WITHDRAWN);
    expect(await service.listRecruitmentEvents(sessionId, application.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'STATUS_CHANGED',
          fromStatus: WorkflowRecruitmentStatus.HIRED,
          toStatus: WorkflowRecruitmentStatus.WITHDRAWN,
        }),
      ]),
    );
  });

  it('uses the customized scheduling message for the second and third interview phases', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.updateInstance(sessionId, flow.id, {
      messages: {
        interviewScheduledPhase2: 'SEGUNDA FASE\n{detalhes_agendamento}',
        interviewScheduledPhase3: 'TERCEIRA FASE\n{detalhes_agendamento}',
      },
    });
    const secondPhaseRecord = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'phase-two-message',
      data: { nome: 'Candidata da segunda fase' },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const thirdPhaseRecord = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'phase-three-message',
      data: { nome: 'Candidato da terceira fase' },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const [secondPhaseSlot, thirdPhaseSlot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        {
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          interviewPhase: WorkflowInterviewPhase.FOCUSED,
          location: 'Unidade 2',
        },
        {
          startsAt: new Date(Date.now() + 172_800_000).toISOString(),
          interviewPhase: WorkflowInterviewPhase.HIRING,
          location: 'Unidade 3',
        },
      ],
    });

    await service.scheduleRecordAppointment(sessionId, flow.id, secondPhaseRecord.id, secondPhaseSlot.id);
    await service.scheduleRecordAppointment(sessionId, flow.id, thirdPhaseRecord.id, thirdPhaseSlot.id);

    const secondPhaseMessage = await ds
      .getRepository(WorkflowOutboxMessage)
      .findOneByOrFail({ chatId: secondPhaseRecord.contactId });
    const thirdPhaseMessage = await ds
      .getRepository(WorkflowOutboxMessage)
      .findOneByOrFail({ chatId: thirdPhaseRecord.contactId });
    expect(secondPhaseMessage.body).toContain('SEGUNDA FASE');
    expect(secondPhaseMessage.body).toContain('Unidade 2');
    expect(thirdPhaseMessage.body).toContain('TERCEIRA FASE');
    expect(thirdPhaseMessage.body).toContain('Unidade 3');
  });

  it('completes past empty slots so they cannot return to the available agenda', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const past = await ds.getRepository(WorkflowAppointmentSlot).save({
      instanceId: flow.id,
      startsAt: new Date(Date.now() - 60_000),
      label: null,
      location: null,
      address: null,
      instruction: null,
      responsible: null,
      mapsUrl: null,
      capacity: 1,
      bookedCount: 0,
      status: AppointmentSlotStatus.AVAILABLE,
      heldByRunId: null,
      holdUntil: null,
    });

    expect(await service.listSlots(sessionId, flow.id, true)).toEqual([]);
    expect(await ds.getRepository(WorkflowAppointmentSlot).findOneByOrFail({ id: past.id })).toMatchObject({
      status: AppointmentSlotStatus.COMPLETED,
    });
  });

  it('allows independent meetings at the same date and time', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();

    const created = await service.createSlots(sessionId, flow.id, {
      slots: [
        { startsAt, location: 'Sala 1', responsible: 'Amanda', capacity: 3 },
        { startsAt, location: 'Sala 1', responsible: 'Bruno', capacity: 5 },
        { startsAt, location: 'Sala 2', responsible: 'Carla', capacity: 2 },
      ],
    });

    expect(created).toHaveLength(3);
    expect(new Set(created.map(slot => slot.id)).size).toBe(3);
    expect(
      (await service.listSlots(sessionId, flow.id)).filter(slot => slot.startsAt.toISOString() === startsAt),
    ).toHaveLength(3);
  });

  it('edits slot details and increases its capacity without changing the meeting identity', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 2 }],
    });

    const updated = await service.updateSlot(sessionId, flow.id, slot.id, {
      capacity: 8,
      instruction: 'Chegar com antecedência',
      responsible: 'Amanda',
    });

    expect(updated).toMatchObject({
      id: slot.id,
      capacity: 8,
      instruction: 'Chegar com antecedência',
      responsible: 'Amanda',
    });
    await expect(service.updateSlot(sessionId, flow.id, slot.id, { capacity: 1 })).rejects.toThrow(
      'só pode ser mantido ou aumentado',
    );
  });

  it('shows appointment details instead of internal ids in the WhatsApp review', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.updateInstance(sessionId, flow.id, {
      appointmentNotifications: [
        { id: 'booking-team', ddi: '55', ddd: '31', number: '988887777', events: ['CONFIRMADA'] },
        { id: 'cancellation-team', ddi: '55', ddd: '31', number: '977776666', events: ['CANCELADA'] },
      ],
    });
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'entrevista',
          label: 'Horário da entrevista',
          prompt: 'Escolha o horário:',
          type: 'appointment',
          required: true,
          order: 1,
        },
      ],
    });
    await service.publish(sessionId, flow.id);
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        {
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          location: 'Sala principal',
          address: 'Rua Principal, 100',
          mapsUrl: 'https://maps.google.com/?q=Sala+principal',
          instruction: 'Chegue com 10 minutos de antecedência',
          responsible: 'Amanda',
          capacity: 2,
        },
      ],
    });

    await service.processInbound(sessionId, 'summary-contact', 'summary-contact', '1');
    await service.processInbound(sessionId, 'summary-contact', 'summary-contact', 'sim');
    const review = (await service.processInbound(sessionId, 'summary-contact', 'summary-contact', '1'))[0];

    expect(review).toContain('Sala principal');
    expect(review).toContain('Endereço: Rua Principal, 100');
    expect(review).toContain('Link do Google Maps: https://maps.google.com/?q=Sala+principal');
    expect(review).toContain('Instrução: Chegue com 10 minutos de antecedência');
    expect(review).toContain('Apresentar-se para: *Amanda*');
    expect(review).not.toContain(slot.id);

    const confirmation = (await service.processInbound(sessionId, 'summary-contact', 'summary-contact', '1'))[0];
    expect(confirmation).toContain('Dados confirmados e salvos');
    expect(confirmation).toContain('Nome do local: *Sala principal*');
    expect(confirmation).toContain('Endereço: Rua Principal, 100');
    const operatorMessages = await ds.getRepository(WorkflowOutboxMessage).find({
      where: { chatId: '5531988887777@c.us' },
    });
    expect(operatorMessages).toHaveLength(1);
    expect(operatorMessages[0].body).toContain('Nova entrevista marcada');
    expect(operatorMessages[0].body).toContain('Sala principal');
    expect(await ds.getRepository(WorkflowOutboxMessage).count({ where: { chatId: '5531977776666@c.us' } })).toBe(0);
  });

  it('removes unused interview slots and hides slots that retain cancelled history', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const [unused, used] = await service.createSlots(sessionId, flow.id, {
      slots: [
        { startsAt: new Date(Date.now() + 86_400_000).toISOString() },
        { startsAt: new Date(Date.now() + 172_800_000).toISOString() },
      ],
    });
    await ds.getRepository(WorkflowAppointment).save({
      slotId: used.id,
      instanceId: flow.id,
      contactId: 'slot-history',
      recordId: null,
      status: AppointmentStatus.CANCELLED,
      cancelledAt: new Date(),
      reminderSentAt: null,
    });

    await expect(service.deleteSlot(sessionId, flow.id, unused.id)).resolves.toEqual({ deleted: true });
    expect(await ds.getRepository(WorkflowAppointmentSlot).exists({ where: { id: unused.id } })).toBe(false);
    await expect(service.deleteSlot(sessionId, flow.id, used.id)).resolves.toEqual({ deleted: true });
    expect((await ds.getRepository(WorkflowAppointmentSlot).findOneByOrFail({ id: used.id })).status).toBe(
      AppointmentSlotStatus.REMOVED,
    );
    expect((await service.listSlots(sessionId, flow.id)).map(slot => slot.id)).not.toContain(used.id);
  });

  it('clears a stale saved interview when removing a slot that only has historical appointments', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString() }],
    });
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'removed-slot-history',
      phone: null,
      data: { nome: 'Pessoa', entrevista: slot.id },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    await ds.getRepository(WorkflowAppointment).save({
      slotId: slot.id,
      instanceId: flow.id,
      contactId: record.contactId,
      recordId: record.id,
      status: AppointmentStatus.COMPLETED,
      cancelledAt: null,
      reminderSentAt: new Date(),
    });

    await service.deleteSlot(sessionId, flow.id, slot.id);

    expect((await ds.getRepository(WorkflowRecord).findOneByOrFail({ id: record.id })).data).toEqual({
      nome: 'Pessoa',
    });
    expect(
      await ds.getRepository(WorkflowRecordVersion).exists({
        where: { recordId: record.id, versionNumber: 2, source: 'APPOINTMENT_SLOT_REMOVED' },
      }),
    ).toBe(true);
    expect((await ds.getRepository(WorkflowAppointmentSlot).findOneByOrFail({ id: slot.id })).status).toBe(
      AppointmentSlotStatus.REMOVED,
    );
  });

  it('moves confirmed candidates to a replacement slot and queues one notification each', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const [oldSlot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        {
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          capacity: 2,
          location: 'Sala 1',
          address: 'Rua das Flores, 100',
          instruction: 'Apresente-se na recepção',
          responsible: 'Amanda',
          mapsUrl: 'https://maps.google.com/?q=Sala+1',
        },
      ],
    });
    oldSlot.bookedCount = 1;
    oldSlot.status = AppointmentSlotStatus.AVAILABLE;
    await ds.getRepository(WorkflowAppointmentSlot).save(oldSlot);
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: oldSlot.id,
      instanceId: flow.id,
      contactId: 'reschedule-contact',
      recordId: null,
      status: AppointmentStatus.CONFIRMED,
      cancelledAt: null,
      reminderSentAt: new Date(),
    });
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: appointment.contactId,
      phone: null,
      data: { entrevista: oldSlot.id },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const replacementDate = new Date(Date.now() + 172_800_000);

    const result = await service.rescheduleSlot(sessionId, flow.id, oldSlot.id, {
      startsAt: replacementDate.toISOString(),
      location: 'Sala 2',
      capacity: 3,
    });

    expect(result).toMatchObject({ movedAppointments: 1, notified: 1 });
    expect(result.slot.bookedCount).toBe(1);
    expect(result.slot.location).toBe('Sala 2');
    expect(result.slot.address).toBe('Rua das Flores, 100');
    expect(result.slot.instruction).toBe('Apresente-se na recepção');
    expect(result.slot.responsible).toBe('Amanda');
    expect(result.slot.mapsUrl).toBe('https://maps.google.com/?q=Sala+1');
    expect((await ds.getRepository(WorkflowAppointment).findOneByOrFail({ id: appointment.id })).status).toBe(
      AppointmentStatus.CANCELLED,
    );
    const replacementAppointment = await ds.getRepository(WorkflowAppointment).findOneByOrFail({
      slotId: result.slot.id,
      contactId: appointment.contactId,
    });
    expect(replacementAppointment.status).toBe(AppointmentStatus.CONFIRMED);
    expect(replacementAppointment.reminderSentAt).toBeNull();
    expect((await ds.getRepository(WorkflowRecord).findOneByOrFail({ id: record.id })).data.entrevista).toBe(
      result.slot.id,
    );
    expect((await ds.getRepository(WorkflowRecord).findOneByOrFail({ id: record.id })).currentVersion).toBe(2);
    expect(
      await ds.getRepository(WorkflowRecordVersion).exists({
        where: { recordId: record.id, versionNumber: 2, source: 'APPOINTMENT_RESCHEDULED' },
      }),
    ).toBe(true);
    expect((await service.listSlots(sessionId, flow.id)).map(slot => slot.id)).not.toContain(oldSlot.id);
    const notification = await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({
      dedupeKey: `appointment-rescheduled:${appointment.id}:${result.slot.id}`,
    });
    expect(notification.body).toContain('Novo horário');
    expect(notification.body).toContain('Sala 2');
    expect(notification.body).toContain('Endereço: Rua das Flores, 100');
    expect(notification.body).toContain('Apresentar-se para: *Amanda*');
    expect(notification.body).toContain('Link do Google Maps: https://maps.google.com/?q=Sala+1');
    await ds.getRepository(WorkflowOutboxMessage).update(notification.id, {
      status: WorkflowOutboxStatus.FAILED,
      attempts: 4,
      maxAttempts: 3,
    });
    await expect(service.retryOutboxMessage(sessionId, notification.id)).resolves.toMatchObject({
      status: WorkflowOutboxStatus.RETRYING,
    });
  });

  it('reschedules one confirmed candidate and updates the saved answer and notification', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.updateInstance(sessionId, flow.id, {
      appointmentNotifications: [
        { id: 'reschedule-team', ddi: '55', ddd: '31', number: '966665555', events: ['REAGENDADA'] },
      ],
    });
    const [oldSlot, targetSlot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        { startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 2, location: 'Sala antiga' },
        { startsAt: new Date(Date.now() + 172_800_000).toISOString(), capacity: 2, location: 'Sala nova' },
      ],
    });
    await ds.getRepository(WorkflowAppointmentSlot).update(oldSlot.id, { bookedCount: 1 });
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'individual-reschedule',
      phone: '5531999999999',
      data: { nome: 'Amanda', entrevista: oldSlot.id },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: oldSlot.id,
      instanceId: flow.id,
      contactId: record.contactId,
      recordId: record.id,
      status: AppointmentStatus.CONFIRMED,
      cancelledAt: null,
      reminderSentAt: new Date(),
    });

    const replacement = await service.rescheduleAppointment(sessionId, flow.id, appointment.id, targetSlot.id);

    expect(replacement).toMatchObject({
      slotId: targetSlot.id,
      status: AppointmentStatus.CONFIRMED,
      reminderSentAt: null,
    });
    expect((await ds.getRepository(WorkflowAppointment).findOneByOrFail({ id: appointment.id })).status).toBe(
      AppointmentStatus.CANCELLED,
    );
    expect((await ds.getRepository(WorkflowRecord).findOneByOrFail({ id: record.id })).data.entrevista).toBe(
      targetSlot.id,
    );
    const notification = await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({
      dedupeKey: `appointment-rescheduled:${appointment.id}:${targetSlot.id}`,
    });
    expect(notification.body).toContain('Sala nova');
    const operatorNotification = await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({
      dedupeKey: `appointment-rescheduled:${appointment.id}:${targetSlot.id}:5531966665555`,
    });
    expect(operatorNotification.body).toContain('Entrevista reagendada');
    expect(operatorNotification.body).toContain('Horário anterior');
    const [application] = await service.listRecruitmentApplications(sessionId);
    const [rescheduleEvent] = await service.listRecruitmentEvents(sessionId, application.id);
    expect(rescheduleEvent).toMatchObject({
      type: 'APPOINTMENT_RESCHEDULED',
      metadata: {
        previousAppointmentStartsAt: oldSlot.startsAt.toISOString(),
        appointmentStartsAt: targetSlot.startsAt.toISOString(),
        previousLocation: 'Sala antiga',
        location: 'Sala nova',
      },
    });
  });

  it('rebuilds a missing confirmed appointment from the valid record before rescheduling', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        {
          id: 'entrevista',
          label: 'Entrevista',
          prompt: 'Escolha o horário:',
          type: 'appointment',
          required: true,
          order: 1,
        },
      ],
    });
    await service.publish(sessionId, flow.id);
    const [oldSlot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 3 }],
    });
    oldSlot.bookedCount = 1;
    await ds.getRepository(WorkflowAppointmentSlot).save(oldSlot);
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'orphaned-appointment',
      phone: null,
      data: { entrevista: oldSlot.id },
      validUntil: new Date(Date.now() + 86_400_000),
    });

    const result = await service.rescheduleSlot(sessionId, flow.id, oldSlot.id, {
      startsAt: new Date(Date.now() + 172_800_000).toISOString(),
      capacity: 3,
    });

    expect(result.movedAppointments).toBe(1);
    expect((await ds.getRepository(WorkflowRecord).findOneByOrFail({ id: record.id })).data.entrevista).toBe(
      result.slot.id,
    );
    expect(
      await ds.getRepository(WorkflowAppointment).exists({
        where: {
          slotId: result.slot.id,
          contactId: record.contactId,
          status: AppointmentStatus.CONFIRMED,
        },
      }),
    ).toBe(true);
  });

  it('queues the interview reminder once after 8am on the interview date', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        {
          startsAt: '2099-09-10T15:00:00.000Z',
          location: 'Ambrozini Floresta',
          address: 'Rua Floresta, 100',
          mapsUrl: 'https://maps.google.com/?q=Ambrozini+Floresta',
          instruction: 'Leve um documento com foto',
          responsible: 'Amanda',
          capacity: 3,
        },
      ],
    });
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: slot.id,
      instanceId: flow.id,
      contactId: 'reminder-contact',
      recordId: null,
      status: AppointmentStatus.CONFIRMED,
      cancelledAt: null,
      reminderSentAt: null,
    });

    await service.sweepDeadlines(new Date('2099-09-10T11:00:00.000Z'));
    await service.sweepDeadlines(new Date('2099-09-10T11:01:00.000Z'));

    const messages = await ds.getRepository(WorkflowOutboxMessage).find({
      where: { dedupeKey: `appointment-reminder:${appointment.id}` },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain('Sua entrevista é *hoje');
    expect(messages[0].body).toContain('Nome do local: *Ambrozini Floresta*');
    expect(messages[0].body).toContain('Endereço: Rua Floresta, 100');
    expect(messages[0].body).toContain('Link do Google Maps: https://maps.google.com/?q=Ambrozini+Floresta');
    expect(messages[0].body).toContain('Instrução: Leve um documento com foto');
    expect(messages[0].body).toContain('Apresentar-se para: *Amanda*');
    expect(
      (await ds.getRepository(WorkflowAppointment).findOneByOrFail({ id: appointment.id })).reminderSentAt,
    ).toBeTruthy();
  });

  it('clears the saved interview and notifies the candidate when an appointment is cancelled', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.updateInstance(sessionId, flow.id, {
      appointmentNotifications: [
        { id: 'booking-only', ddi: '55', ddd: '31', number: '988887777', events: ['CONFIRMADA'] },
        { id: 'cancellation-only', ddi: '55', ddd: '31', number: '977776666', events: ['CANCELADA'] },
      ],
    });
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 2, location: 'Sala 3' }],
    });
    slot.bookedCount = 1;
    await ds.getRepository(WorkflowAppointmentSlot).save(slot);
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'cancel-contact',
      phone: '5531999999999',
      data: { nome: 'Pessoa Teste', entrevista: slot.id },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: slot.id,
      instanceId: flow.id,
      contactId: record.contactId,
      recordId: record.id,
      status: AppointmentStatus.CONFIRMED,
      cancelledAt: null,
      reminderSentAt: null,
    });

    await service.updateAppointmentStatus(sessionId, flow.id, appointment.id, AppointmentStatus.CANCELLED);
    await service.updateAppointmentStatus(sessionId, flow.id, appointment.id, AppointmentStatus.CANCELLED);

    const savedRecord = await ds.getRepository(WorkflowRecord).findOneByOrFail({ id: record.id });
    expect(savedRecord.data).toEqual({ nome: 'Pessoa Teste' });
    expect(savedRecord.currentVersion).toBe(2);
    expect((await ds.getRepository(WorkflowAppointmentSlot).findOneByOrFail({ id: slot.id })).bookedCount).toBe(0);
    expect(
      await ds.getRepository(WorkflowOutboxMessage).count({
        where: { dedupeKey: `appointment-cancelled:${appointment.id}` },
      }),
    ).toBe(1);
    const operatorMessages = await ds.getRepository(WorkflowOutboxMessage).find({
      where: { chatId: '5531977776666@c.us' },
    });
    expect(operatorMessages).toHaveLength(1);
    expect(operatorMessages[0].dedupeKey).toBe(`appointment-cancelled:${appointment.id}:5531977776666`);
    expect(operatorMessages[0].body).toContain('Entrevista cancelada');
    expect(await ds.getRepository(WorkflowOutboxMessage).count({ where: { chatId: '5531988887777@c.us' } })).toBe(0);
    expect(
      await ds.getRepository(WorkflowRecordVersion).count({
        where: { recordId: record.id, source: 'APPOINTMENT_CANCELLED' },
      }),
    ).toBe(1);
  });

  it('notifies free-form location contacts and only manual recipients matching their filters', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const department = await ds.getRepository(WorkflowDepartment).findOneByOrFail({ id: flow.departmentId });
    department.schedule = {
      ...(department.schedule ?? {}),
      locations: [
        {
          id: 'location-1',
          internalName: 'Unidade Floresta',
          name: 'Floresta',
          address: 'Rua Floresta, 100',
          mapsUrl: '',
          notificationContacts: [
            {
              id: 'location-1-gerente',
              role: 'RH',
              name: 'Amanda',
              ddi: '55',
              ddd: '31',
              number: '955554444',
              enabled: true,
            },
            {
              id: 'location-1-subgerente',
              role: 'DP',
              name: 'Priscila',
              ddi: '55',
              ddd: '31',
              number: '911110000',
              enabled: true,
            },
          ],
        },
        {
          id: 'location-2',
          internalName: 'Unidade Centro',
          name: 'Centro',
          address: 'Rua Centro, 200',
          mapsUrl: '',
        },
      ],
    };
    await ds.getRepository(WorkflowDepartment).save(department);
    await service.updateInstance(sessionId, flow.id, {
      appointmentNotifications: [
        {
          id: 'completion-team',
          name: 'Gestora Floresta',
          ddi: '55',
          ddd: '31',
          number: '955554444',
          events: ['CONCLUIDA'],
          locationIds: ['location-1'],
          interviewPhases: [WorkflowInterviewPhase.FOCUSED],
          enabled: true,
        },
        {
          id: 'other-location',
          name: 'Gestor Centro',
          ddi: '55',
          ddd: '31',
          number: '933332222',
          events: ['CONCLUIDA'],
          locationIds: ['location-2'],
          interviewPhases: [WorkflowInterviewPhase.FOCUSED],
          enabled: true,
        },
        {
          id: 'other-phase',
          name: 'Gestor primeira fase',
          ddi: '55',
          ddd: '31',
          number: '922221111',
          events: ['CONCLUIDA'],
          locationIds: ['location-1'],
          interviewPhases: [WorkflowInterviewPhase.SIMPLE],
          enabled: true,
        },
        { id: 'booking-team', ddi: '55', ddd: '31', number: '944443333', events: ['CONFIRMADA'] },
      ],
    });
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        {
          startsAt: new Date(Date.now() + 86_400_000).toISOString(),
          capacity: 1,
          locationId: 'location-1',
          location: 'Floresta',
          interviewPhase: WorkflowInterviewPhase.FOCUSED,
        },
      ],
    });
    await ds.getRepository(WorkflowAppointmentSlot).update(slot.id, {
      bookedCount: 1,
      status: AppointmentSlotStatus.CONFIRMED,
    });
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: slot.id,
      instanceId: flow.id,
      contactId: 'completed-contact',
      recordId: null,
      status: AppointmentStatus.CONFIRMED,
      cancelledAt: null,
      reminderSentAt: null,
    });

    await service.updateAppointmentStatus(sessionId, flow.id, appointment.id, AppointmentStatus.COMPLETED);

    expect(
      await ds.getRepository(WorkflowOutboxMessage).count({
        where: { dedupeKey: `appointment-completed:${appointment.id}:5531955554444` },
      }),
    ).toBe(1);
    expect(
      (await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({ chatId: '5531955554444@c.us' })).body,
    ).toContain('*Fase:* Entrevista teste');
    expect(await ds.getRepository(WorkflowOutboxMessage).count({ where: { chatId: '5531955554444@c.us' } })).toBe(1);
    expect(await ds.getRepository(WorkflowOutboxMessage).count({ where: { chatId: '5531911110000@c.us' } })).toBe(1);
    expect(await ds.getRepository(WorkflowOutboxMessage).count({ where: { chatId: '5531933332222@c.us' } })).toBe(0);
    expect(await ds.getRepository(WorkflowOutboxMessage).count({ where: { chatId: '5531922221111@c.us' } })).toBe(0);
    expect(await ds.getRepository(WorkflowOutboxMessage).count({ where: { chatId: '5531944443333@c.us' } })).toBe(0);
  });

  it('starts the selection process at the booked interview and advances it to evaluation', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 1 }],
    });
    await ds.getRepository(WorkflowAppointmentSlot).update(slot.id, {
      bookedCount: 1,
      status: AppointmentSlotStatus.CONFIRMED,
    });
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'selection-contact',
      phone: '5531999999999',
      data: { nome: 'Pessoa Selecionada' },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: slot.id,
      instanceId: flow.id,
      contactId: record.contactId,
      recordId: record.id,
      status: AppointmentStatus.CONFIRMED,
      cancelledAt: null,
      reminderSentAt: null,
    });

    const [application] = await service.listRecruitmentApplications(sessionId);
    expect(application.status).toBe(WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED);
    expect(application.appointmentId).toBe(appointment.id);

    const evaluated = await service.updateRecruitmentApplication(
      sessionId,
      application.id,
      { status: WorkflowRecruitmentStatus.EVALUATION, owner: 'Recrutamento', rating: 4, note: 'Compareceu.' },
      'operator-1',
    );

    expect(evaluated.status).toBe(WorkflowRecruitmentStatus.EVALUATION);
    expect(evaluated.owner).toBe('Recrutamento');
    expect(evaluated.rating).toBe(4);
    expect((await ds.getRepository(WorkflowAppointment).findOneByOrFail({ id: appointment.id })).status).toBe(
      AppointmentStatus.COMPLETED,
    );
    expect(await service.listRecruitmentEvents(sessionId, application.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'STATUS_CHANGED', note: 'Compareceu.', actorId: 'operator-1' }),
      ]),
    );

    await expect(
      service.updateRecruitmentApplication(
        sessionId,
        application.id,
        { status: WorkflowRecruitmentStatus.APPROVED },
        'operator-1',
      ),
    ).rejects.toThrow('Escolha uma nova data');

    const [focusedSlot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        {
          startsAt: new Date(Date.now() + 172_800_000).toISOString(),
          interviewPhase: WorkflowInterviewPhase.FOCUSED,
        },
      ],
    });
    const focusedAppointment = await service.scheduleRecordAppointment(sessionId, flow.id, record.id, focusedSlot.id);
    expect((await service.listRecruitmentApplications(sessionId))[0].status).toBe(WorkflowRecruitmentStatus.APPROVED);
    await expect(
      service.updateRecruitmentApplication(
        sessionId,
        application.id,
        { status: WorkflowRecruitmentStatus.EVALUATION },
        'operator-1',
      ),
    ).rejects.toThrow('Esta mudança de etapa não é permitida');
    expect((await service.listRecruitmentApplications(sessionId))[0].status).toBe(WorkflowRecruitmentStatus.APPROVED);

    await service.updateAppointmentStatus(sessionId, flow.id, focusedAppointment.id, AppointmentStatus.COMPLETED);
    expect((await service.listRecruitmentApplications(sessionId))[0].status).toBe(
      WorkflowRecruitmentStatus.SECOND_EVALUATION,
    );

    // Polling/list reconciliation must never regress a decision back to evaluation just because
    // the linked appointment remains completed.
    expect((await service.listRecruitmentApplications(sessionId))[0].status).toBe(
      WorkflowRecruitmentStatus.SECOND_EVALUATION,
    );
    const eventsAfterRefresh = await service.listRecruitmentEvents(sessionId, application.id);
    expect(eventsAfterRefresh.filter(event => event.toStatus === WorkflowRecruitmentStatus.EVALUATION)).toHaveLength(1);

    const [secondFocusedSlot] = await service.createSlots(sessionId, flow.id, {
      slots: [
        {
          startsAt: new Date(Date.now() + 259_200_000).toISOString(),
          interviewPhase: WorkflowInterviewPhase.FOCUSED,
          location: 'Loja 2',
        },
      ],
    });
    await service.scheduleRecordAppointment(sessionId, flow.id, record.id, secondFocusedSlot.id);
    const returnedToInterview = (await service.listRecruitmentApplications(sessionId))[0];
    expect(returnedToInterview.status).toBe(WorkflowRecruitmentStatus.APPROVED);
    expect(returnedToInterview.appointment?.slot?.location).toBe('Loja 2');
    const secondInterviewEvents = await service.listRecruitmentEvents(sessionId, application.id);
    expect(
      secondInterviewEvents.some(event => {
        const metadata = event.metadata as Record<string, unknown> | null;
        return event.type === 'APPOINTMENT_CONFIRMED' && metadata?.location === 'Loja 2';
      }),
    ).toBe(true);
  });

  it('lets the candidate confirm a cancellation and notifies only the configured operators once', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    await service.updateInstance(sessionId, flow.id, {
      appointmentNotificationNumbers: ['5531966665555'],
    });
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 1, location: 'Sala 4' }],
    });
    slot.bookedCount = 1;
    slot.status = AppointmentSlotStatus.CONFIRMED;
    await ds.getRepository(WorkflowAppointmentSlot).save(slot);
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'customer-cancel-contact',
      phone: '5531955554444',
      data: { nome: 'Pessoa Candidata', entrevista: slot.id },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: slot.id,
      instanceId: flow.id,
      contactId: record.contactId,
      recordId: record.id,
      status: AppointmentStatus.CONFIRMED,
      cancelledAt: null,
      reminderSentAt: null,
    });

    await service.processInbound(sessionId, record.contactId, record.contactId, 'oi');
    await service.processInbound(sessionId, record.contactId, record.contactId, '1');
    const prompt = (
      await service.processInbound(sessionId, record.contactId, record.contactId, 'cancelar entrevista')
    )[0];
    expect(prompt).toContain('realmente cancelar');
    const confirmation = (await service.processInbound(sessionId, record.contactId, record.contactId, 'sim'))[0];
    expect(confirmation).toContain('Sua entrevista foi cancelada');
    expect((await ds.getRepository(WorkflowAppointment).findOneByOrFail({ id: appointment.id })).status).toBe(
      AppointmentStatus.CANCELLED,
    );
    expect(
      await ds.getRepository(WorkflowOutboxMessage).count({
        where: { dedupeKey: `appointment-cancelled:${appointment.id}:5531966665555` },
      }),
    ).toBe(1);
    expect(
      await ds.getRepository(WorkflowOutboxMessage).count({
        where: { dedupeKey: `appointment-cancelled:${appointment.id}` },
      }),
    ).toBe(0);
  });

  it('repairs appointment answers left by cancellations made before the cleanup existed', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 172_800_000).toISOString() }],
    });
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'legacy-cancel-contact',
      phone: null,
      data: { nome: 'Cadastro antigo', entrevista: slot.id },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const appointment = await ds.getRepository(WorkflowAppointment).save({
      slotId: slot.id,
      instanceId: flow.id,
      contactId: record.contactId,
      recordId: record.id,
      status: AppointmentStatus.CANCELLED,
      cancelledAt: new Date(),
      reminderSentAt: null,
    });

    const listed = await service.listRecords(sessionId);

    expect(listed.find(item => item.id === record.id)?.data).toEqual({ nome: 'Cadastro antigo' });
    expect(
      await ds.getRepository(WorkflowOutboxMessage).count({
        where: { dedupeKey: `appointment-cancelled:${appointment.id}` },
      }),
    ).toBe(1);
  });

  it('reconciles renamed answer keys and versions manual candidate corrections', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const previousVersion = await ds
      .getRepository(WorkflowDefinitionVersion)
      .findOneByOrFail({ id: flow.currentVersionId! });
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'manual-correction',
      phone: '5531999999999',
      data: { nome: 'Cadastro antigo' },
      currentVersion: 1,
      definitionVersionId: previousVersion.id,
      validUntil: new Date(Date.now() + 86_400_000),
    });
    await service.saveDraft(sessionId, flow.id, {
      fields: previousVersion.fields.map(field => ({ ...field, answerKey: 'nome_completo' })),
    });
    await service.publish(sessionId, flow.id);

    const listed = (await service.listRecords(sessionId)).find(item => item.id === record.id)!;
    expect(listed.data).toEqual({ nome_completo: 'Cadastro antigo' });
    const updated = await service.updateRecord(
      sessionId,
      record.id,
      { data: { nome_completo: 'nome corrigido' }, expectedVersion: 1 },
      'operator-key',
    );

    expect(updated.data).toEqual({ nome_completo: 'NOME CORRIGIDO' });
    expect(updated.currentVersion).toBe(2);
    expect(
      await ds.getRepository(WorkflowRecordVersion).findOneByOrFail({ recordId: record.id, versionNumber: 2 }),
    ).toMatchObject({ source: 'CORRECAO_MANUAL', actorId: 'operator-key' });
    await expect(
      service.updateRecord(
        sessionId,
        record.id,
        { data: { nome_completo: 'sobrescrita' }, expectedVersion: 1 },
        'operator-key',
      ),
    ).rejects.toThrow('alterado por outra pessoa');
  });

  it('automatically queues a fresh proximity search when an address answer changes', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const published = await ds.getRepository(WorkflowDefinitionVersion).findOneByOrFail({ id: flow.currentVersionId! });
    const addressFields = [
      ['endereco_cep', 'cep'],
      ['endereco_logradouro', 'text'],
      ['endereco_numero', 'text'],
      ['endereco_bairro', 'text'],
      ['endereco_cidade', 'text'],
      ['endereco_estado', 'text'],
    ] as const;
    await service.saveDraft(sessionId, flow.id, {
      fields: [
        ...published.fields,
        ...addressFields.map(([key, type], index) => ({
          id: `address${index + 1}`,
          answerKey: key,
          label: key,
          prompt: key,
          type,
          required: true,
          order: index + 2,
        })),
      ],
    });
    const currentFlow = await service.publish(sessionId, flow.id);
    const department = await service.getDepartment(sessionId);
    await service.updateDepartment(sessionId, {
      schedule: {
        ...department.schedule,
        locations: [
          {
            id: 'matriz',
            name: 'Matriz',
            address: 'Rua Pouso Alegre, 888, Belo Horizonte, MG',
            latitude: -19.9,
            longitude: -43.9,
          },
        ],
      },
    });
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'address-correction',
      phone: '5531999999999',
      currentVersion: 1,
      definitionVersionId: currentFlow.currentVersionId,
      data: {
        nome: 'Pessoa Teste',
        endereco_cep: '31000000',
        endereco_logradouro: 'Rua Teste',
        endereco_numero: '10',
        endereco_bairro: 'Bairro Antigo',
        endereco_cidade: 'Belo Horizonte',
        endereco_estado: 'MG',
      },
      proximityStatus: WorkflowProximityStatus.COMPLETED,
      proximityRevision: 2,
      proximityAttempts: 0,
      proximityNextAttemptAt: null,
      proximityData: {
        originAddress: 'endereço anterior',
        destinationHash: 'anterior',
        results: [],
      },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const processSpy = jest
      .spyOn(service as unknown as { processProximityRecord: (id: string) => Promise<void> }, 'processProximityRecord')
      .mockResolvedValue();

    const updated = await service.updateRecord(
      sessionId,
      record.id,
      { data: { endereco_bairro: 'Floresta' }, expectedVersion: 1 },
      'operator-key',
    );

    expect(updated.proximityStatus).toBe(WorkflowProximityStatus.PENDING);
    expect(updated.proximityRevision).toBe(3);
    expect(updated.proximityData?.originAddress).toContain('Floresta');
    expect(processSpy).toHaveBeenCalledWith(record.id);
  });

  it('lets an administrator delete a candidate and queues a notification', async () => {
    await service.processInbound(sessionId, 'admin-delete', 'admin-delete', '1');
    await service.processInbound(sessionId, 'admin-delete', 'admin-delete', 'sim');
    await service.processInbound(sessionId, 'admin-delete', 'admin-delete', 'Rafael');
    await service.processInbound(sessionId, 'admin-delete', 'admin-delete', '1');
    const record = await ds.getRepository(WorkflowRecord).findOneByOrFail({ contactId: 'admin-delete' });
    const application = await ds.getRepository(WorkflowRecruitmentApplication).save({
      instanceId: record.instanceId,
      contactId: record.contactId,
      recordId: record.id,
      appointmentId: null,
      status: WorkflowRecruitmentStatus.EVALUATION,
      owner: null,
      rating: null,
      nextActionAt: null,
    });
    await ds.getRepository(WorkflowRecruitmentEvent).save({
      applicationId: application.id,
      type: 'STATUS_CHANGED',
      fromStatus: null,
      toStatus: WorkflowRecruitmentStatus.EVALUATION,
      actorId: 'admin-key',
      note: null,
      metadata: {},
    });

    await service.deleteRecord(sessionId, record.id, 'admin-key');

    expect(await ds.getRepository(WorkflowRecord).count({ where: { id: record.id } })).toBe(0);
    expect(await ds.getRepository(WorkflowRecruitmentApplication).count({ where: { id: application.id } })).toBe(0);
    expect(await ds.getRepository(WorkflowRecruitmentEvent).count({ where: { applicationId: application.id } })).toBe(
      0,
    );
    const notification = await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({
      dedupeKey: `record-admin-delete:${record.id}`,
    });
    expect(notification.body).toContain('excluídos por um administrador');
    expect(
      await ds
        .getRepository(WorkflowPrivacyEvent)
        .count({ where: { instanceId: record.instanceId, type: 'DATA_DELETION_BY_ADMIN' } }),
    ).toBe(1);
  });

  it('resolves and persists the real phone for an existing LID record', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const record = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: '171635617329265@lid',
      phone: null,
      data: { nome: 'Rafael' },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    resolveContactPhone.mockResolvedValue('5531999999999');

    const [listed] = await service.listRecords(sessionId, '', ['+5531999999999']);

    expect(resolveContactPhone).toHaveBeenCalledWith(record.contactId);
    expect(listed.phone).toBe('5531999999999');
    expect((await ds.getRepository(WorkflowRecord).findOneByOrFail({ id: record.id })).phone).toBe('5531999999999');
  });

  it('enforces chat scope for records, appointments and destructive actions', async () => {
    const flow = (await service.listInstances(sessionId))[0];
    const allowed = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'allowed@lid',
      phone: '5531999999999',
      data: { nome: 'Permitido' },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const hidden = await ds.getRepository(WorkflowRecord).save({
      instanceId: flow.id,
      contactId: 'hidden@lid',
      phone: '5531888888888',
      data: { nome: 'Oculto' },
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const [slot] = await service.createSlots(sessionId, flow.id, {
      slots: [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 2 }],
    });
    for (const record of [allowed, hidden])
      await ds.getRepository(WorkflowAppointment).save({
        slotId: slot.id,
        instanceId: flow.id,
        contactId: record.contactId,
        recordId: record.id,
        status: AppointmentStatus.CONFIRMED,
        cancelledAt: null,
        reminderSentAt: null,
      });

    expect((await service.listRecords(sessionId, '', ['+5531999999999'])).map(row => row.id)).toEqual([allowed.id]);
    expect((await service.listAppointments(sessionId, flow.id, ['5531999999999'])).map(row => row.recordId)).toEqual([
      allowed.id,
    ]);
    await expect(service.deleteRecord(sessionId, hidden.id, 'admin', ['5531999999999'])).rejects.toThrow(
      'Cadastro não encontrado',
    );
  });
});
