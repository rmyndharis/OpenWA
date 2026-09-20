import { DataSource, Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { HookManager } from '../../core/hooks';
import { PluginStatus } from '../../core/plugins';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import {
  TalentCandidate,
  TalentFlowSession,
  TalentPoolSettings,
  TalentProcessedMessage,
  TalentTicket,
  TalentTicketEvent,
  TalentTicketStatus,
} from './entities/talent-pool.entity';
import { TalentPoolService } from './talent-pool.service';
import { Session } from '../session/entities/session.entity';
import { WorkflowOutboxMessage, WorkflowOutboxStatus, WorkflowPrivacyEvent } from './entities/workflow-hub.entity';

describe('TalentPoolService', () => {
  let ds: DataSource;
  let service: TalentPoolService;
  let flows: Repository<TalentFlowSession>;
  let tickets: Repository<TalentTicket>;
  const sent: string[] = [];
  let seq = 0;
  let sendTextMock: jest.Mock;

  const incoming = (body: string): Message => ({
    id: 'db-' + ++seq,
    sessionId: 'session-1',
    waMessageId: 'wa-' + seq,
    chatId: '5511999999999@c.us',
    from: '5511999999999@c.us',
    to: '5511888888888@c.us',
    body,
    type: 'text',
    direction: MessageDirection.INCOMING,
    timestamp: Math.floor(Date.now() / 1000),
    status: MessageStatus.SENT,
    metadata: {},
    createdAt: new Date(),
  });

  beforeEach(async () => {
    sent.length = 0;
    seq = 0;
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Session,
        TalentPoolSettings,
        TalentCandidate,
        TalentFlowSession,
        TalentTicket,
        TalentTicketEvent,
        TalentProcessedMessage,
        WorkflowOutboxMessage,
        WorkflowPrivacyEvent,
      ],
      synchronize: true,
    });
    await ds.initialize();
    await ds.getRepository(Session).save(ds.getRepository(Session).create({ id: 'session-1', name: 'RH' }));
    flows = ds.getRepository(TalentFlowSession);
    tickets = ds.getRepository(TalentTicket);
    sendTextMock = jest.fn((_sessionId: string, input: { text: string }) => {
      sent.push(input.text);
      return Promise.resolve({ messageId: 'out-' + sent.length, timestamp: Date.now() });
    });
    const port = {
      sendText: sendTextMock,
    };
    const moduleRef = { get: jest.fn(() => port) };
    const audit = { logInfo: jest.fn(), logWarn: jest.fn() };
    service = new TalentPoolService(
      ds.getRepository(TalentPoolSettings),
      ds.getRepository(TalentCandidate),
      flows,
      tickets,
      ds.getRepository(TalentTicketEvent),
      ds.getRepository(TalentProcessedMessage),
      new HookManager(),
      audit as never,
      moduleRef as never,
      undefined,
      undefined,
      ds.getRepository(WorkflowOutboxMessage),
      ds.getRepository(WorkflowPrivacyEvent),
      { get: jest.fn((key: string) => (key === 'WORKFLOW_TECHNICAL_RETENTION_DAYS' ? '30' : undefined)) } as never,
    );
    await service.updateSettings('session-1', {
      enabled: true,
      fields: [
        { id: 'nome', label: 'Nome', prompt: 'Seu nome?', type: 'text', required: true, enabled: true, order: 1 },
      ],
    });
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it('deduplicates messages and only persists a candidate after the final valid answer', async () => {
    const start = incoming('oi');
    await service.processInbound('session-1', start);
    await service.processInbound('session-1', start);
    expect(sent).toHaveLength(1);
    expect(await service.listCandidates('session-1')).toHaveLength(0);

    await service.processInbound('session-1', incoming('Maria da Silva'));
    const candidates = await service.listCandidates('session-1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].data).toEqual({ nome: 'Maria da Silva' });
    expect(sent.at(-1)).toContain('Cadastro concluído');
  });

  it('reports whether the built-in workflow plugin is active for the selected session', () => {
    Object.assign(service, {
      pluginLoader: {
        getPlugin: jest.fn(() => ({
          manifest: { sessionScoped: true },
          status: PluginStatus.ENABLED,
          activeSessions: ['session-1'],
        })),
      },
    });

    expect(service.getWorkflowHubRuntimeStatus('session-1')).toMatchObject({
      installed: true,
      status: PluginStatus.ENABLED,
      activeForSession: true,
      technicalRetentionDays: 30,
    });
    expect(service.getWorkflowHubRuntimeStatus('another-session').activeForSession).toBe(false);
  });

  it('claims an outgoing outbox row before sending and never sends the same reply twice', async () => {
    const sendSystem = (
      service as unknown as {
        sendSystem: (sessionId: string, chatId: string, text: string, dedupeKey: string) => Promise<void>;
      }
    ).sendSystem.bind(service);
    await Promise.all([
      sendSystem('session-1', '5511999999999@c.us', 'Resposta única', 'same-reply'),
      sendSystem('session-1', '5511999999999@c.us', 'Resposta única', 'same-reply'),
    ]);
    expect(sent.filter(text => text === 'Resposta única')).toHaveLength(1);
    expect(sendTextMock).toHaveBeenCalledWith('session-1', {
      chatId: '5511999999999@c.us',
      text: 'Resposta única',
      linkPreview: false,
    });
    expect(await ds.getRepository(WorkflowOutboxMessage).count()).toBe(1);
  });

  it('retries a terminal outbox alert after WhatsApp becomes available again', async () => {
    const row = await ds.getRepository(WorkflowOutboxMessage).save({
      sessionId: 'session-1',
      chatId: '5511999999999@c.us',
      body: 'Aviso que não pode ser perdido',
      dedupeKey: 'recover-after-reconnect',
      status: WorkflowOutboxStatus.FAILED,
      attempts: 3,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1_000),
      sentAt: null,
      lastError: 'WhatsApp desconectado',
    });

    await service.runDeadlineSweep();

    expect(sent).toContain(row.body);
    expect(sendTextMock).toHaveBeenCalledWith('session-1', {
      chatId: '5511999999999@c.us',
      text: row.body,
      linkPreview: false,
    });
    expect(await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({ id: row.id })).toMatchObject({
      status: WorkflowOutboxStatus.SENT,
      attempts: 4,
    });
  });

  it('scrubs the destination and body after delivering a privacy deletion confirmation', async () => {
    const row = await ds.getRepository(WorkflowOutboxMessage).save({
      sessionId: 'session-1',
      chatId: '5511999999999@c.us',
      body: 'Seus dados pessoais foram excluídos.',
      dedupeKey: 'privacy-deletion:request-1',
      status: WorkflowOutboxStatus.PENDING,
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1_000),
      sentAt: null,
      lastError: null,
    });

    await service.runDeadlineSweep();

    const delivered = await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({ id: row.id });
    expect(delivered).toMatchObject({
      status: WorkflowOutboxStatus.SENT,
      chatId: `anonymized:${row.id}`,
      body: '[conteudo removido apos confirmacao de exclusao]',
    });
  });

  it('removes pseudonymous technical workflow records after the configured retention period', async () => {
    const now = new Date('2026-09-17T12:00:00.000Z');
    const old = new Date('2026-07-01T12:00:00.000Z');
    const recent = new Date('2026-09-10T12:00:00.000Z');
    await ds.getRepository(WorkflowPrivacyEvent).save([
      {
        instanceId: 'flow-1',
        type: 'DATA_DELETION_APPROVED',
        anonymousSubjectHash: 'a'.repeat(64),
        actorId: null,
        metadata: {},
        createdAt: old,
      },
      {
        instanceId: 'flow-1',
        type: 'DATA_DELETION_APPROVED',
        anonymousSubjectHash: 'b'.repeat(64),
        actorId: null,
        metadata: {},
        createdAt: recent,
      },
    ]);

    await (
      service as unknown as {
        runRetentionSweep: (at: Date) => Promise<void>;
      }
    ).runRetentionSweep(now);

    const remaining = await ds.getRepository(WorkflowPrivacyEvent).find();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].anonymousSubjectHash).toBe('b'.repeat(64));
  });

  it('defers a deadline notification without failing the sweep when its session is inactive', async () => {
    await service.processInbound('session-1', incoming('oi'));
    const flow = (await flows.find())[0];
    flow.deadlineAt = new Date(Date.now() - 1_000);
    await flows.save(flow);
    sendTextMock.mockRejectedValueOnce(
      new BadRequestException("Session 'session-1' is not active. Start the session first."),
    );

    await expect(service.runDeadlineSweep()).resolves.toBeUndefined();

    expect((await flows.findOneByOrFail({ id: flow.id })).state).toBe('CADASTRO_EXPIRADO');
    expect(
      await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({
        sessionId: 'session-1',
        status: WorkflowOutboxStatus.RETRYING,
      }),
    ).toMatchObject({ status: WorkflowOutboxStatus.RETRYING, attempts: 1 });
  });

  it('queues an inbound reply without leaking a rejection when Chromium closes during delivery', async () => {
    const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    sendTextMock.mockRejectedValueOnce(transportError);

    try {
      await expect(service.processInbound('session-1', incoming('oi'))).resolves.toBe(true);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
      expect(
        await ds.getRepository(WorkflowOutboxMessage).findOneByOrFail({
          sessionId: 'session-1',
          status: WorkflowOutboxStatus.RETRYING,
        }),
      ).toMatchObject({ attempts: 1, lastError: transportError.message });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('does not retry a terminal outbox alert forever after its recovery attempt also failed', async () => {
    await ds.getRepository(WorkflowOutboxMessage).save({
      sessionId: 'session-1',
      chatId: '5511999999999@c.us',
      body: 'Aviso antigo já esgotado',
      dedupeKey: 'exhausted-alert',
      status: WorkflowOutboxStatus.FAILED,
      attempts: 4,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1_000),
      sentAt: null,
      lastError: 'WhatsApp desconectado novamente',
    });

    await service.runDeadlineSweep();

    expect(sent).not.toContain('Aviso antigo já esgotado');
  });

  it('expires registration, deletes its draft and restarts from the first question', async () => {
    await service.processInbound('session-1', incoming('oi'));
    const flow = (await flows.find())[0];
    flow.deadlineAt = new Date(Date.now() - 1000);
    await flows.save(flow);
    await service.runDeadlineSweep();
    expect((await flows.find())[0]).toMatchObject({ state: 'CADASTRO_EXPIRADO', draft: {}, step: 0 });
    expect(await service.listCandidates('session-1')).toHaveLength(0);
    expect(sent.at(-1)).toContain('dados parciais foram apagados');

    await service.processInbound('session-1', incoming('voltei'));
    expect((await flows.find())[0].step).toBe(0);
    expect(sent.at(-1)).toContain('Pergunta 1 de 1');
  });

  it('does not let exhausted messages occupy the entire delivery batch and block new replies', async () => {
    const outbox = ds.getRepository(WorkflowOutboxMessage);
    await outbox.save(
      Array.from({ length: 30 }, (_, index) => ({
        sessionId: 'session-1',
        chatId: '5511999999999@c.us',
        body: 'Falha antiga',
        dedupeKey: `exhausted-${index}`,
        status: WorkflowOutboxStatus.FAILED,
        attempts: 4,
        maxAttempts: 3,
        nextAttemptAt: new Date(Date.now() - 60_000),
      })),
    );
    const pending = await outbox.save({
      sessionId: 'session-1',
      chatId: '5511999999999@c.us',
      body: 'Nova resposta pendente',
      dedupeKey: 'new-pending-reply',
      status: WorkflowOutboxStatus.PENDING,
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: new Date(Date.now() - 1_000),
    });

    await service.runDeadlineSweep();
    await service.runDeadlineSweep();

    expect(sent).toEqual(['Nova resposta pendente']);
    expect(await outbox.findOneByOrFail({ id: pending.id })).toMatchObject({
      status: WorkflowOutboxStatus.SENT,
      attempts: 1,
    });
  });

  it('discards an expired update without modifying the valid candidate', async () => {
    await service.processInbound('session-1', incoming('oi'));
    await service.processInbound('session-1', incoming('Nome original'));
    await service.processInbound('session-1', incoming('1'));
    await service.processInbound('session-1', incoming('1'));
    await service.processInbound('session-1', incoming('Nome novo'));
    const flow = (await flows.find())[0];
    flow.deadlineAt = new Date(Date.now() - 1000);
    await flows.save(flow);
    await service.runDeadlineSweep();
    const candidate = (await service.listCandidates('session-1'))[0];
    expect(candidate.data.nome).toBe('Nome original');
    expect(sent.at(-1)).toContain('cadastro anterior permanece intacto');
  });

  it('only commits an update after explicit confirmation', async () => {
    await service.processInbound('session-1', incoming('oi'));
    await service.processInbound('session-1', incoming('Nome original'));
    await service.processInbound('session-1', incoming('1'));
    await service.processInbound('session-1', incoming('1'));
    await service.processInbound('session-1', incoming('Nome novo'));
    expect((await service.listCandidates('session-1'))[0].data.nome).toBe('Nome original');

    await service.processInbound('session-1', incoming('SIM'));
    expect((await service.listCandidates('session-1'))[0].data.nome).toBe('Nome novo');
    expect((await flows.find())[0].state).toBe('MENU_CLIENTE');
  });

  it('expires only the menu and preserves an existing valid candidate', async () => {
    await service.processInbound('session-1', incoming('oi'));
    await service.processInbound('session-1', incoming('Maria'));
    const flow = (await flows.find())[0];
    flow.deadlineAt = new Date(Date.now() - 1000);
    await flows.save(flow);

    await service.runDeadlineSweep();
    expect((await flows.find())[0]).toMatchObject({ state: 'CHAT_ENCERRADO', draft: {} });
    expect((await service.listCandidates('session-1'))[0].data.nome).toBe('Maria');

    await service.processInbound('session-1', incoming('voltei'));
    expect(sent.at(-1)).toContain('Atualizar meus dados');
  });

  it('keeps the bot silent during human service, resets activity and closes after warning grace', async () => {
    await service.processInbound('session-1', incoming('oi'));
    await service.processInbound('session-1', incoming('Maria'));
    await service.processInbound('session-1', incoming('2'));
    const beforeClientMessage = sent.length;
    await service.processInbound('session-1', incoming('preciso de ajuda'));
    expect(sent).toHaveLength(beforeClientMessage);
    let ticket = (await tickets.find())[0];
    expect(ticket.status).toBe(TalentTicketStatus.HUMAN);

    ticket.nextActionAt = new Date(Date.now() - 1000);
    await tickets.save(ticket);
    await service.runDeadlineSweep();
    ticket = (await tickets.find())[0];
    expect(ticket.status).toBe(TalentTicketStatus.IDLE_WARNING);

    await service.processInbound('session-1', incoming('ainda estou aqui'));
    ticket = (await tickets.find())[0];
    expect(ticket.status).toBe(TalentTicketStatus.HUMAN);
    expect(ticket.warnedAt).toBeNull();
    expect(ticket.nextActionAt.getTime()).toBeGreaterThan(Date.now());

    ticket.nextActionAt = new Date(Date.now() - 1000);
    await tickets.save(ticket);
    await service.runDeadlineSweep();
    ticket = (await tickets.find())[0];
    expect(ticket.status).toBe(TalentTicketStatus.IDLE_WARNING);

    ticket.nextActionAt = new Date(Date.now() - 1000);
    await tickets.save(ticket);
    await service.runDeadlineSweep();
    ticket = (await tickets.find())[0];
    expect(ticket.status).toBe(TalentTicketStatus.CLOSED);
    expect(ticket.closeReason).toBe('ENCERRADO_AUTOMATICAMENTE_POR_INATIVIDADE');
    expect(ticket.openKey).toBeNull();
  });

  it('never creates two open human tickets for the same contact', async () => {
    await service.processInbound('session-1', incoming('oi'));
    await service.processInbound('session-1', incoming('Maria'));
    await service.processInbound('session-1', incoming('2'));
    const messagesBefore = sent.length;

    await service.processInbound('session-1', incoming('2'));
    expect(await tickets.count()).toBe(1);
    expect(sent).toHaveLength(messagesBefore);
  });
});
