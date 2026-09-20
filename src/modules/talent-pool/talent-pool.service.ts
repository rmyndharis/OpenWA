import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { HookManager } from '../../core/hooks';
import {
  type IPlugin,
  type PluginContext,
  PluginLoaderService,
  type PluginManifest,
  PluginStatus,
  PluginType,
} from '../../core/plugins';
import { isPluginActiveForSession } from '../../core/plugins/plugin-activation';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { createLogger } from '../../common/services/logger.service';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { MessageStatus } from '../message/entities/message.entity';
import {
  TalentCandidate,
  TalentCandidateStatus,
  TalentFieldDefinition,
  TalentFlowSession,
  TalentFlowState,
  TalentPoolSettings,
  TalentProcessedMessage,
  TalentTicket,
  TalentTicketCloseReason,
  TalentTicketEvent,
  TalentTicketStatus,
} from './entities/talent-pool.entity';
import { WorkflowHubService } from './workflow-hub.service';
import { WorkflowOutboxMessage, WorkflowOutboxStatus, WorkflowPrivacyEvent } from './entities/workflow-hub.entity';

const DEFAULT_FIELDS: TalentFieldDefinition[] = [
  {
    id: 'nome',
    label: 'Nome completo',
    prompt: 'Qual é o seu nome completo?',
    type: 'text',
    required: true,
    enabled: true,
    order: 1,
    min: 3,
    max: 150,
  },
  {
    id: 'email',
    label: 'E-mail',
    prompt: 'Qual é o seu e-mail?',
    type: 'email',
    required: true,
    enabled: true,
    order: 2,
  },
  {
    id: 'cidade',
    label: 'Cidade',
    prompt: 'Em qual cidade você mora?',
    type: 'text',
    required: true,
    enabled: true,
    order: 3,
    min: 2,
    max: 120,
  },
  {
    id: 'area_interesse',
    label: 'Área de interesse',
    prompt: 'Qual é sua área de interesse profissional?',
    type: 'text',
    required: true,
    enabled: true,
    order: 4,
    min: 2,
    max: 150,
  },
  {
    id: 'curriculo',
    label: 'Currículo',
    prompt: 'Envie seu currículo em PDF.',
    type: 'pdf',
    required: true,
    enabled: true,
    order: 5,
  },
];

const DEFAULT_MESSAGES: Record<string, string> = {
  opening: 'Olá! Vamos iniciar seu cadastro no nosso Banco de Talentos.',
  completed: 'Cadastro concluído com sucesso.',
  menu: '*Escolha uma opção:*\n1. Atualizar meus dados\n2. Falar com um atendente humano',
  registrationExpired:
    'Seu cadastro expirou por falta de resposta. Os dados parciais foram apagados. Envie uma nova mensagem para recomeçar.',
  updateExpired:
    'A atualização expirou e as alterações pendentes foram descartadas. Seu cadastro anterior permanece intacto.',
  humanStarted: 'Seu chamado foi encaminhado para a equipe de RH. A partir de agora o bot ficará em silêncio.',
  humanWarning:
    'Seu atendimento está sem atividade e será encerrado em 5 minutos. Envie uma mensagem para mantê-lo aberto.',
  humanClosed:
    'Seu atendimento foi encerrado automaticamente por inatividade. Envie uma nova mensagem para acessar o menu novamente.',
};

type ParsedValue = { ok: true; value: unknown } | { ok: false; error: string };

export const WORKFLOW_HUB_PLUGIN_ID = 'workflow-hub';

export const WORKFLOW_HUB_MANIFEST: PluginManifest = {
  id: WORKFLOW_HUB_PLUGIN_ID,
  name: 'Central de Recrutamento',
  version: '0.1.0',
  type: PluginType.EXTENSION,
  main: 'built-in',
  description: 'Recrutamento com formulários, candidatos, agenda, seleção e atendimento humano.',
  author: 'OpenWA local',
  license: 'MIT',
  sessionScoped: true,
  sessions: ['*'],
  hooks: ['message:received', 'message:persisted'],
  provides: ['workflow-hub', 'forms', 'appointments', 'human-handover'],
  permissions: ['messages:send'],
};

@Injectable()
export class TalentPoolService implements OnModuleInit, OnModuleDestroy, IPlugin {
  private readonly logger = createLogger('TalentPoolService');
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly systemSends = new Map<string, number>();
  private messagePort?: PluginMessagePort;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private lastRetentionSweepAt = 0;

  constructor(
    @InjectRepository(TalentPoolSettings, 'data') private readonly settingsRepo: Repository<TalentPoolSettings>,
    @InjectRepository(TalentCandidate, 'data') private readonly candidateRepo: Repository<TalentCandidate>,
    @InjectRepository(TalentFlowSession, 'data') private readonly flowRepo: Repository<TalentFlowSession>,
    @InjectRepository(TalentTicket, 'data') private readonly ticketRepo: Repository<TalentTicket>,
    @InjectRepository(TalentTicketEvent, 'data') private readonly eventRepo: Repository<TalentTicketEvent>,
    @InjectRepository(TalentProcessedMessage, 'data')
    private readonly processedRepo: Repository<TalentProcessedMessage>,
    private readonly hooks: HookManager,
    private readonly audit: AuditService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly pluginLoader?: PluginLoaderService,
    @Optional() private readonly workflowHub?: WorkflowHubService,
    @Optional()
    @InjectRepository(WorkflowOutboxMessage, 'data')
    private readonly workflowOutbox?: Repository<WorkflowOutboxMessage>,
    @Optional()
    @InjectRepository(WorkflowPrivacyEvent, 'data')
    private readonly workflowPrivacyEvents?: Repository<WorkflowPrivacyEvent>,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.pluginLoader && !this.pluginLoader.getPlugin(WORKFLOW_HUB_PLUGIN_ID)) {
      this.pluginLoader.registerBuiltInPlugin(WORKFLOW_HUB_MANIFEST, this);
    }
  }

  getWorkflowHubRuntimeStatus(sessionId: string): {
    pluginId: string;
    installed: boolean;
    status: PluginStatus | 'not_installed';
    activeForSession: boolean;
    technicalRetentionDays: number;
  } {
    const plugin = this.pluginLoader?.getPlugin(WORKFLOW_HUB_PLUGIN_ID);
    return {
      pluginId: WORKFLOW_HUB_PLUGIN_ID,
      installed: Boolean(plugin),
      status: plugin?.status ?? 'not_installed',
      activeForSession: Boolean(
        plugin &&
        plugin.status === PluginStatus.ENABLED &&
        isPluginActiveForSession(plugin.manifest.sessionScoped !== false, plugin.activeSessions ?? ['*'], sessionId),
      ),
      technicalRetentionDays: this.technicalRetentionDays(),
    };
  }

  async onEnable(context: PluginContext): Promise<void> {
    const purgedLegacySubjects = (await this.workflowHub?.purgeLegacyPrivacyResidue()) ?? 0;
    if (purgedLegacySubjects)
      this.logger.warn('Removed legacy records left behind by approved privacy deletions', {
        action: 'workflow_legacy_privacy_cleanup',
        count: purgedLegacySubjects,
      });
    const cancelledNotifications = (await this.workflowHub?.cancelStaleOutboxMessages()) ?? 0;
    if (cancelledNotifications)
      this.logger.warn('Cancelled stale workflow notifications before delivery', {
        action: 'workflow_outbox_stale_cleanup',
        count: cancelledNotifications,
      });
    context.registerHook(
      'message:received',
      async hook => {
        const data = hook.data as Record<string, unknown>;
        const contact = data.chatId ?? data.from;
        const chatId = typeof contact === 'string' ? contact : '';
        if (
          !hook.sessionId ||
          !chatId ||
          data.fromMe === true ||
          data.isGroup === true ||
          data.isStatusBroadcast === true
        ) {
          return { continue: true };
        }
        const settings = await this.settingsRepo.findOne({ where: { sessionId: hook.sessionId, enabled: true } });
        const genericEnabled = (await this.workflowHub?.isEnabledForSession(hook.sessionId)) ?? false;
        return { continue: !settings && !genericEnabled };
      },
      0,
    );
    context.registerHook(
      'message:persisted',
      async hook => {
        const payload = hook.data as { message?: Message };
        if (
          hook.sessionId &&
          payload.message?.direction === MessageDirection.OUTGOING &&
          payload.message.status === MessageStatus.SENT
        ) {
          await this.processOutbound(hook.sessionId, payload.message);
        }
        return { continue: true };
      },
      0,
    );
    this.sweepTimer = setInterval(() => void this.runDeadlineSweep(), 10_000);
    this.sweepTimer.unref?.();
    void this.runDeadlineSweep();
  }

  onDisable(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    return Promise.resolve();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async getSettings(sessionId: string): Promise<TalentPoolSettings> {
    let row = await this.settingsRepo.findOne({ where: { sessionId } });
    if (!row) {
      row = await this.settingsRepo.save(
        this.settingsRepo.create({
          sessionId,
          enabled: false,
          fields: DEFAULT_FIELDS,
          messages: DEFAULT_MESSAGES,
        }),
      );
    }
    return row;
  }

  async updateSettings(sessionId: string, patch: Partial<TalentPoolSettings>): Promise<TalentPoolSettings> {
    const row = await this.getSettings(sessionId);
    const keys = [
      'registrationTimeoutMinutes',
      'updateTimeoutMinutes',
      'menuTimeoutMinutes',
      'humanInactivityMinutes',
      'humanGraceMinutes',
    ] as const;
    for (const key of keys) if (patch[key] !== undefined) row[key] = Math.max(1, Math.min(10_080, Number(patch[key])));
    if (patch.enabled !== undefined) row.enabled = Boolean(patch.enabled);
    if (patch.queueName !== undefined) row.queueName = String(patch.queueName).trim().slice(0, 100) || 'RH';
    if (patch.fields !== undefined) row.fields = this.validateFields(patch.fields);
    if (patch.messages !== undefined) row.messages = { ...DEFAULT_MESSAGES, ...patch.messages };
    if (row.enabled && this.activeFields(row).length === 0) {
      throw new BadRequestException('Ative pelo menos um campo antes de habilitar o Banco de Talentos.');
    }
    const saved = await this.settingsRepo.save(row);
    await this.audit.logInfo(AuditAction.TALENT_SETTINGS_UPDATED, { sessionId, metadata: { enabled: saved.enabled } });
    return saved;
  }

  async listCandidates(sessionId: string, search?: string): Promise<TalentCandidate[]> {
    const rows = await this.candidateRepo.find({ where: { sessionId }, order: { updatedAt: 'DESC' }, take: 500 });
    const term = String(search ?? '')
      .trim()
      .toLocaleLowerCase('pt-BR');
    return term
      ? rows.filter(
          row => JSON.stringify(row.data).toLocaleLowerCase('pt-BR').includes(term) || row.phone?.includes(term),
        )
      : rows;
  }

  getCandidate(sessionId: string, id: string): Promise<TalentCandidate | null> {
    return this.candidateRepo.findOne({ where: { sessionId, id } });
  }

  listTickets(sessionId: string, openOnly = false): Promise<TalentTicket[]> {
    const active = [TalentTicketStatus.WAITING, TalentTicketStatus.HUMAN, TalentTicketStatus.IDLE_WARNING];
    return this.ticketRepo.find({
      where: openOnly ? { sessionId, status: In(active) } : { sessionId },
      order: { updatedAt: 'DESC' },
      take: 500,
    });
  }

  async ticketEvents(sessionId: string, ticketId: string): Promise<TalentTicketEvent[]> {
    if (!(await this.ticketRepo.exists({ where: { id: ticketId, sessionId } }))) return [];
    return this.eventRepo.find({ where: { ticketId }, order: { createdAt: 'ASC' } });
  }

  async touchTicket(sessionId: string, ticketId: string, actorId: string | null): Promise<TalentTicket | null> {
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId, sessionId } });
    if (!ticket?.openKey) return null;
    await this.resetTicketActivity(ticket, await this.getSettings(sessionId), 'MANUAL_ACTIVITY', actorId);
    return ticket;
  }

  async closeTicket(sessionId: string, ticketId: string, actorId: string | null): Promise<TalentTicket | null> {
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId, sessionId } });
    if (!ticket || ticket.status === TalentTicketStatus.CLOSED) return ticket;
    ticket.status = TalentTicketStatus.CLOSED;
    ticket.openKey = null;
    ticket.closedAt = new Date();
    ticket.closeReason = TalentTicketCloseReason.MANUAL;
    const saved = await this.ticketRepo.save(ticket);
    await this.addTicketEvent(saved.id, 'CLOSED_MANUALLY', actorId);
    await this.audit.logInfo(AuditAction.TALENT_TICKET_CLOSED, {
      sessionId,
      metadata: { ticketId, reason: saved.closeReason },
    });
    return saved;
  }

  async processInbound(sessionId: string, message: Message): Promise<boolean> {
    if (!this.isPluginActiveForSession(sessionId)) return false;
    const settings = await this.settingsRepo.findOne({ where: { sessionId, enabled: true } });
    const genericEnabled = (await this.workflowHub?.isEnabledForSession(sessionId)) ?? false;
    if ((!settings && !genericEnabled) || message.direction !== MessageDirection.INCOMING || !message.chatId)
      return false;
    return this.serial(sessionId + ':' + message.chatId, async () => {
      const sourceMessageId =
        message.waMessageId ||
        createHash('sha256')
          .update(`${message.chatId}\0${message.timestamp ?? ''}\0${message.type}\0${message.body ?? ''}`)
          .digest('hex');
      if (!(await this.claimMessage(sessionId, sourceMessageId))) return true;
      if (genericEnabled && this.workflowHub) {
        const replies = await this.workflowHub.processInbound(
          sessionId,
          message.chatId,
          message.chatId,
          message.body ?? '',
          {
            type: message.type,
            metadata: message.metadata,
            messageId: message.id,
            waMessageId: message.waMessageId,
          },
        );
        for (const [index, reply] of replies.entries())
          await this.sendSystem(sessionId, message.chatId, reply, `workflow-reply:${sourceMessageId}:${index}`);
      } else if (settings) {
        await this.handleInbound(settings, message);
      }
      return true;
    });
  }

  async processOutbound(sessionId: string, message: Message): Promise<void> {
    if (!this.isPluginActiveForSession(sessionId)) return;
    if (message.direction !== MessageDirection.OUTGOING || !message.chatId) return;
    const guard = sessionId + ':' + message.chatId + ':' + (message.body ?? '');
    if ((this.systemSends.get(guard) ?? 0) > Date.now()) return;
    if (await this.workflowHub?.touchHumanActivity(sessionId, message.chatId, 'AGENT_MESSAGE', null)) return;
    const settings = await this.settingsRepo.findOne({ where: { sessionId, enabled: true } });
    if (!settings) return;
    const ticket = await this.ticketRepo.findOne({ where: { openKey: sessionId + ':' + message.chatId } });
    if (ticket) await this.resetTicketActivity(ticket, settings, 'AGENT_MESSAGE', null);
  }

  private async handleInbound(settings: TalentPoolSettings, message: Message): Promise<void> {
    const contactId = message.chatId;
    const openTicket = await this.ticketRepo.findOne({ where: { openKey: message.sessionId + ':' + contactId } });
    if (openTicket) {
      await this.resetTicketActivity(openTicket, settings, 'CLIENT_MESSAGE', null);
      return;
    }
    const candidate = await this.validCandidate(message.sessionId, contactId);
    const flow = await this.flowRepo.findOne({ where: { sessionId: message.sessionId, contactId } });
    if (!flow) {
      if (candidate) {
        await this.newFlow(settings, message, TalentFlowState.MENU, candidate.id);
        await this.sendSystem(message.sessionId, message.chatId, this.msg(settings, 'menu'));
      } else {
        await this.newFlow(settings, message, TalentFlowState.REGISTRATION, null);
        const fields = this.activeFields(settings);
        await this.sendSystem(
          message.sessionId,
          message.chatId,
          this.msg(settings, 'opening') + '\n\n' + this.renderField(fields[0], 0, fields.length),
        );
      }
      return;
    }
    if (!candidate && flow.state !== TalentFlowState.REGISTRATION) {
      flow.candidateId = null;
      flow.state = TalentFlowState.REGISTRATION;
      flow.step = 0;
      flow.draft = {};
      flow.lastMessageId = message.waMessageId || message.id;
      flow.deadlineAt = this.plusMinutes(new Date(), settings.registrationTimeoutMinutes);
      await this.flowRepo.save(flow);
      const fields = this.activeFields(settings);
      await this.sendSystem(
        message.sessionId,
        message.chatId,
        this.msg(settings, 'opening') + '\n\n' + this.renderField(fields[0], 0, fields.length),
      );
      return;
    }
    if (flow.state === TalentFlowState.REGISTRATION_EXPIRED || flow.state === TalentFlowState.CHAT_CLOSED) {
      flow.candidateId = candidate?.id ?? null;
      flow.state = candidate ? TalentFlowState.MENU : TalentFlowState.REGISTRATION;
      flow.step = 0;
      flow.draft = {};
      flow.lastMessageId = message.waMessageId || message.id;
      flow.deadlineAt = this.plusMinutes(
        new Date(),
        candidate ? settings.menuTimeoutMinutes : settings.registrationTimeoutMinutes,
      );
      await this.flowRepo.save(flow);
      if (candidate) {
        await this.sendSystem(message.sessionId, message.chatId, this.msg(settings, 'menu'));
      } else {
        const fields = this.activeFields(settings);
        await this.sendSystem(
          message.sessionId,
          message.chatId,
          this.msg(settings, 'opening') + '\n\n' + this.renderField(fields[0], 0, fields.length),
        );
      }
      return;
    }
    flow.lastMessageId = message.waMessageId || message.id;
    if (flow.state === TalentFlowState.MENU) return this.handleMenu(settings, message, flow, candidate);
    if (flow.state === TalentFlowState.REGISTRATION) return this.handleRegistration(settings, message, flow);
    return this.handleUpdate(settings, message, flow, candidate);
  }

  private async handleRegistration(
    settings: TalentPoolSettings,
    message: Message,
    flow: TalentFlowSession,
  ): Promise<void> {
    const fields = this.activeFields(settings);
    const field = fields[flow.step];
    if (!field) return;
    const parsed = this.parseValue(field, message);
    if (!parsed.ok) {
      await this.sendSystem(
        flow.sessionId,
        flow.chatId,
        parsed.error + '\n\n' + this.renderField(field, flow.step, fields.length),
      );
      return;
    }
    flow.draft = { ...flow.draft, [field.id]: parsed.value };
    flow.step += 1;
    flow.deadlineAt = this.plusMinutes(new Date(), settings.registrationTimeoutMinutes);
    if (flow.step < fields.length) {
      await this.flowRepo.save(flow);
      await this.sendSystem(flow.sessionId, flow.chatId, this.renderField(fields[flow.step], flow.step, fields.length));
      return;
    }
    let candidate = await this.candidateRepo.findOne({
      where: { sessionId: flow.sessionId, contactId: flow.contactId },
    });
    if (!candidate) candidate = this.candidateRepo.create({ sessionId: flow.sessionId, contactId: flow.contactId });
    candidate.status = TalentCandidateStatus.VALID;
    candidate.data = flow.draft;
    candidate.phone = this.phoneFromContact(flow.contactId);
    candidate = await this.candidateRepo.save(candidate);
    flow.candidateId = candidate.id;
    flow.state = TalentFlowState.MENU;
    flow.step = 0;
    flow.draft = {};
    flow.deadlineAt = this.plusMinutes(new Date(), settings.menuTimeoutMinutes);
    await this.flowRepo.save(flow);
    await this.audit.logInfo(AuditAction.TALENT_CANDIDATE_CREATED, {
      sessionId: flow.sessionId,
      metadata: { candidateId: candidate.id },
    });
    await this.sendSystem(
      flow.sessionId,
      flow.chatId,
      this.msg(settings, 'completed') + '\n\n' + this.msg(settings, 'menu'),
    );
  }

  private async handleMenu(
    settings: TalentPoolSettings,
    message: Message,
    flow: TalentFlowSession,
    candidate: TalentCandidate | null,
  ): Promise<void> {
    const choice = String(message.body ?? '').trim();
    if (choice === '1') {
      const fields = this.activeFields(settings);
      flow.state = TalentFlowState.UPDATE_FIELD;
      flow.draft = {};
      flow.deadlineAt = this.plusMinutes(new Date(), settings.updateTimeoutMinutes);
      await this.flowRepo.save(flow);
      await this.sendSystem(
        flow.sessionId,
        flow.chatId,
        'Qual dado deseja atualizar?\n\n' + fields.map((f, i) => String(i + 1) + '. ' + f.label).join('\n'),
      );
      return;
    }
    if (choice === '2' && candidate) return this.openTicket(settings, candidate, flow);
    await this.sendSystem(flow.sessionId, flow.chatId, 'Opção inválida.\n\n' + this.msg(settings, 'menu'));
  }

  private async handleUpdate(
    settings: TalentPoolSettings,
    message: Message,
    flow: TalentFlowSession,
    candidate: TalentCandidate | null,
  ): Promise<void> {
    if (!candidate) {
      await this.flowRepo.delete(flow.id);
      return;
    }
    const fields = this.activeFields(settings);
    if (flow.state === TalentFlowState.UPDATE_FIELD) {
      const field = fields[Number(String(message.body ?? '').trim()) - 1];
      if (!field) {
        await this.sendSystem(flow.sessionId, flow.chatId, 'Escolha um número entre 1 e ' + fields.length + '.');
        return;
      }
      flow.state = TalentFlowState.UPDATE_VALUE;
      flow.draft = { fieldId: field.id };
      flow.deadlineAt = this.plusMinutes(new Date(), settings.updateTimeoutMinutes);
      await this.flowRepo.save(flow);
      await this.sendSystem(flow.sessionId, flow.chatId, field.prompt);
      return;
    }
    if (flow.state === TalentFlowState.UPDATE_VALUE) {
      const field = fields.find(item => item.id === flow.draft.fieldId);
      if (!field) return;
      const parsed = this.parseValue(field, message);
      if (!parsed.ok) {
        await this.sendSystem(flow.sessionId, flow.chatId, parsed.error);
        return;
      }
      flow.state = TalentFlowState.UPDATE_CONFIRM;
      flow.draft = { fieldId: field.id, value: parsed.value };
      flow.deadlineAt = this.plusMinutes(new Date(), settings.updateTimeoutMinutes);
      await this.flowRepo.save(flow);
      await this.sendSystem(
        flow.sessionId,
        flow.chatId,
        'Confirma a alteração de *' + field.label + '*? Responda *SIM* ou *NÃO*.',
      );
      return;
    }
    const yes = ['sim', 's'].includes(this.normalize(message.body));
    const no = ['nao', 'n'].includes(this.normalize(message.body));
    if (!yes && !no) {
      await this.sendSystem(flow.sessionId, flow.chatId, 'Responda SIM para salvar ou NÃO para cancelar.');
      return;
    }
    if (yes) {
      candidate.data = { ...candidate.data, [String(flow.draft.fieldId)]: flow.draft.value };
      await this.candidateRepo.save(candidate);
      await this.audit.logInfo(AuditAction.TALENT_CANDIDATE_UPDATED, {
        sessionId: flow.sessionId,
        metadata: { candidateId: candidate.id, fieldId: flow.draft.fieldId },
      });
    }
    flow.state = TalentFlowState.MENU;
    flow.draft = {};
    flow.deadlineAt = this.plusMinutes(new Date(), settings.menuTimeoutMinutes);
    await this.flowRepo.save(flow);
    await this.sendSystem(
      flow.sessionId,
      flow.chatId,
      (yes ? 'Dados atualizados.' : 'Alteração cancelada.') + '\n\n' + this.msg(settings, 'menu'),
    );
  }

  private async openTicket(
    settings: TalentPoolSettings,
    candidate: TalentCandidate,
    flow: TalentFlowSession,
  ): Promise<void> {
    const now = new Date();
    let ticket = this.ticketRepo.create({
      sessionId: flow.sessionId,
      candidateId: candidate.id,
      contactId: flow.contactId,
      chatId: flow.chatId,
      openKey: flow.sessionId + ':' + flow.contactId,
      status: TalentTicketStatus.HUMAN,
      queueName: settings.queueName,
      lastRelevantAt: now,
      nextActionAt: this.plusMinutes(now, settings.humanInactivityMinutes),
    });
    try {
      ticket = await this.ticketRepo.save(ticket);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      ticket = (await this.ticketRepo.findOne({ where: { openKey: flow.sessionId + ':' + flow.contactId } }))!;
    }
    await this.flowRepo.delete(flow.id);
    await this.addTicketEvent(ticket.id, 'OPENED', null, { queueName: ticket.queueName });
    await this.audit.logInfo(AuditAction.TALENT_TICKET_CREATED, {
      sessionId: flow.sessionId,
      metadata: { ticketId: ticket.id },
    });
    await this.sendSystem(flow.sessionId, flow.chatId, this.msg(settings, 'humanStarted'));
  }

  private async resetTicketActivity(
    ticket: TalentTicket,
    settings: TalentPoolSettings,
    type: string,
    actorId: string | null,
  ): Promise<void> {
    const now = new Date();
    ticket.status = TalentTicketStatus.HUMAN;
    ticket.warnedAt = null;
    ticket.lastRelevantAt = now;
    ticket.nextActionAt = this.plusMinutes(now, settings.humanInactivityMinutes);
    await this.ticketRepo.save(ticket);
    await this.addTicketEvent(ticket.id, type, actorId);
  }

  /** Public for deterministic operational checks/tests; the lifecycle timer calls the same path. */
  async runDeadlineSweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = new Date();
      const activeFlowStates = [
        TalentFlowState.REGISTRATION,
        TalentFlowState.MENU,
        TalentFlowState.UPDATE_FIELD,
        TalentFlowState.UPDATE_VALUE,
        TalentFlowState.UPDATE_CONFIRM,
      ];
      for (const flow of await this.flowRepo.find({
        where: { state: In(activeFlowStates), deadlineAt: LessThanOrEqual(now) },
        take: 100,
      })) {
        await this.expireFlow(flow, now);
      }
      const statuses = [TalentTicketStatus.HUMAN, TalentTicketStatus.IDLE_WARNING];
      for (const ticket of await this.ticketRepo.find({
        where: { status: In(statuses), nextActionAt: LessThanOrEqual(now) },
        take: 100,
      })) {
        await this.advanceTicketTimeout(ticket, now);
      }
      for (const notification of (await this.workflowHub?.sweepDeadlines(now)) ?? []) {
        await this.sendDeadlineSystem(notification.sessionId, notification.chatId, notification.text);
      }
      await this.drainWorkflowOutbox(now);
      await this.runRetentionSweep(now);
    } catch (error) {
      this.logger.error('Talent-pool deadline sweep failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.sweeping = false;
    }
  }

  private async expireFlow(flow: TalentFlowSession, now: Date): Promise<void> {
    const registration = flow.state === TalentFlowState.REGISTRATION;
    const updateStates = [TalentFlowState.UPDATE_FIELD, TalentFlowState.UPDATE_VALUE, TalentFlowState.UPDATE_CONFIRM];
    const update = updateStates.includes(flow.state);
    const result = await this.flowRepo.update(
      { id: flow.id, version: flow.version, state: flow.state, deadlineAt: LessThanOrEqual(now) },
      {
        state: registration ? TalentFlowState.REGISTRATION_EXPIRED : TalentFlowState.CHAT_CLOSED,
        step: 0,
        draft: {},
        deadlineAt: now,
      },
    );
    if (!result.affected) return;
    const settings = await this.getSettings(flow.sessionId);
    if (registration || update) {
      await this.sendDeadlineSystem(
        flow.sessionId,
        flow.chatId,
        this.msg(settings, registration ? 'registrationExpired' : 'updateExpired'),
      );
      await this.audit.logWarn(
        registration ? AuditAction.TALENT_REGISTRATION_EXPIRED : AuditAction.TALENT_UPDATE_EXPIRED,
        {
          sessionId: flow.sessionId,
          metadata: { contactId: flow.contactId },
        },
      );
    } else {
      await this.audit.logInfo(AuditAction.TALENT_CHAT_CLOSED, {
        sessionId: flow.sessionId,
        metadata: { reason: 'MENU_TIMEOUT' },
      });
    }
  }

  private async advanceTicketTimeout(ticket: TalentTicket, now: Date): Promise<void> {
    const settings = await this.getSettings(ticket.sessionId);
    if (ticket.status === TalentTicketStatus.HUMAN) {
      const result = await this.ticketRepo.update(
        {
          id: ticket.id,
          version: ticket.version,
          status: TalentTicketStatus.HUMAN,
          nextActionAt: LessThanOrEqual(now),
        },
        {
          status: TalentTicketStatus.IDLE_WARNING,
          warnedAt: now,
          nextActionAt: this.plusMinutes(now, settings.humanGraceMinutes),
        },
      );
      if (!result.affected) return;
      await this.addTicketEvent(ticket.id, 'INACTIVITY_WARNING', null);
      await this.sendDeadlineSystem(ticket.sessionId, ticket.chatId, this.msg(settings, 'humanWarning'));
      return;
    }
    const result = await this.ticketRepo.update(
      {
        id: ticket.id,
        version: ticket.version,
        status: TalentTicketStatus.IDLE_WARNING,
        nextActionAt: LessThanOrEqual(now),
      },
      {
        status: TalentTicketStatus.CLOSED,
        openKey: null,
        closedAt: now,
        closeReason: TalentTicketCloseReason.AUTOMATIC_INACTIVITY,
      },
    );
    if (!result.affected) return;
    await this.addTicketEvent(ticket.id, 'CLOSED_AUTOMATICALLY', null, {
      reason: TalentTicketCloseReason.AUTOMATIC_INACTIVITY,
    });
    await this.audit.logWarn(AuditAction.TALENT_TICKET_CLOSED, {
      sessionId: ticket.sessionId,
      metadata: { ticketId: ticket.id, reason: TalentTicketCloseReason.AUTOMATIC_INACTIVITY },
    });
    await this.sendDeadlineSystem(ticket.sessionId, ticket.chatId, this.msg(settings, 'humanClosed'));
  }

  private newFlow(
    settings: TalentPoolSettings,
    message: Message,
    state: TalentFlowState,
    candidateId: string | null,
  ): Promise<TalentFlowSession> {
    const timeout = state === TalentFlowState.MENU ? settings.menuTimeoutMinutes : settings.registrationTimeoutMinutes;
    return this.flowRepo.save(
      this.flowRepo.create({
        sessionId: message.sessionId,
        contactId: message.chatId,
        chatId: message.chatId,
        candidateId,
        state,
        step: 0,
        draft: {},
        lastMessageId: message.waMessageId || message.id,
        deadlineAt: this.plusMinutes(new Date(), timeout),
      }),
    );
  }

  private async validCandidate(sessionId: string, contactId: string): Promise<TalentCandidate | null> {
    const row = await this.candidateRepo.findOne({
      where: { sessionId, contactId, status: TalentCandidateStatus.VALID },
    });
    return !row || (row.validUntil && row.validUntil <= new Date()) ? null : row;
  }

  private parseValue(field: TalentFieldDefinition, message: Message): ParsedValue {
    const text = String(message.body ?? '').trim();
    if (field.type === 'pdf') {
      const media = (message.metadata as { media?: Record<string, unknown> } | null)?.media;
      const mimetype = typeof media?.mimetype === 'string' ? media.mimetype : '';
      const filename = typeof media?.filename === 'string' ? media.filename : 'curriculo.pdf';
      if (message.type !== 'document' || (!mimetype.includes('pdf') && !filename.toLowerCase().endsWith('.pdf'))) {
        return { ok: false, error: 'Envie um documento no formato PDF.' };
      }
      return { ok: true, value: { messageId: message.id, waMessageId: message.waMessageId, filename, mimetype } };
    }
    if (!text && field.required) return { ok: false, error: 'Este dado é obrigatório.' };
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
      return { ok: false, error: 'Informe um e-mail válido.' };
    if (field.type === 'number') {
      const value = Number(text.replace(',', '.'));
      if (!Number.isFinite(value)) return { ok: false, error: 'Informe um número válido.' };
      if (field.min != null && value < field.min) return { ok: false, error: 'O valor mínimo é ' + field.min + '.' };
      if (field.max != null && value > field.max) return { ok: false, error: 'O valor máximo é ' + field.max + '.' };
      return { ok: true, value };
    }
    if (field.type === 'date') {
      const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
      if (!match) return { ok: false, error: 'Use o formato DD/MM/AAAA.' };
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = Number(match[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return { ok: false, error: 'Informe uma data válida no formato DD/MM/AAAA.' };
      }
    }
    if (field.type === 'select' && field.options?.length) {
      const value =
        field.options[Number(text) - 1] ?? field.options.find(x => this.normalize(x) === this.normalize(text));
      return value ? { ok: true, value } : { ok: false, error: 'Escolha uma das opções apresentadas.' };
    }
    if (field.type === 'multiselect' && field.options?.length) {
      const selections = text
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
      const values = selections.map(
        item =>
          field.options?.[Number(item) - 1] ??
          field.options?.find(option => this.normalize(option) === this.normalize(item)),
      );
      if (!values.length || values.some(item => !item)) {
        return { ok: false, error: 'Escolha uma ou mais opções separadas por vírgula.' };
      }
      return { ok: true, value: [...new Set(values as string[])] };
    }
    if (field.min != null && text.length < field.min)
      return { ok: false, error: 'Informe pelo menos ' + field.min + ' caracteres.' };
    if (field.max != null && text.length > field.max)
      return { ok: false, error: 'Informe no máximo ' + field.max + ' caracteres.' };
    return { ok: true, value: text };
  }

  private renderField(field: TalentFieldDefinition | undefined, index: number, total: number): string {
    if (!field) return 'O cadastro ainda não possui campos configurados. Fale com o RH.';
    const options = field.options?.length
      ? '\n\n' + field.options.map((x, i) => String(i + 1) + '. ' + x).join('\n')
      : '';
    return '*Pergunta ' + (index + 1) + ' de ' + total + '*\n' + field.prompt + options;
  }

  private activeFields(settings: TalentPoolSettings): TalentFieldDefinition[] {
    return settings.fields.filter(field => field.enabled).sort((a, b) => a.order - b.order);
  }

  private validateFields(value: TalentFieldDefinition[]): TalentFieldDefinition[] {
    if (!Array.isArray(value)) throw new BadRequestException('A configuração de campos deve ser uma lista.');
    const ids = new Set<string>();
    const allowedTypes = new Set(['text', 'email', 'number', 'date', 'select', 'multiselect', 'pdf']);
    return value.map((field, index) => {
      const id = String(field.id ?? '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_');
      if (!id || ids.has(id)) throw new BadRequestException('Campo inválido ou duplicado: ' + (id || index + 1));
      ids.add(id);
      const type = allowedTypes.has(field.type) ? field.type : 'text';
      const label = String(field.label ?? id).trim();
      const prompt = String(field.prompt ?? '').trim();
      const options = Array.isArray(field.options)
        ? field.options.map(option => String(option).trim()).filter(Boolean)
        : undefined;
      if (!label || !prompt) throw new BadRequestException('Nome e pergunta são obrigatórios no campo ' + id + '.');
      if ((type === 'select' || type === 'multiselect') && !options?.length) {
        throw new BadRequestException('Informe opções para o campo ' + label + '.');
      }
      return {
        ...field,
        id,
        label,
        prompt,
        type,
        options,
        order: Number.isFinite(Number(field.order)) ? Number(field.order) : index + 1,
        required: Boolean(field.required),
        enabled: field.enabled !== false,
      };
    });
  }

  private async claimMessage(sessionId: string, waMessageId: string): Promise<boolean> {
    try {
      await this.processedRepo.insert({ sessionId, waMessageId });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  private async sendSystem(sessionId: string, chatId: string, text: string, stableDedupeKey?: string): Promise<void> {
    const key = sessionId + ':' + chatId + ':' + text;
    this.systemSends.set(key, Date.now() + 30_000);
    let outbox: WorkflowOutboxMessage | undefined;
    try {
      if (this.workflowOutbox) {
        const dedupeKey = createHash('sha256')
          .update(stableDedupeKey ?? `${sessionId}\0${chatId}\0${randomUUID()}`)
          .digest('hex');
        try {
          outbox = await this.workflowOutbox.save(
            this.workflowOutbox.create({
              sessionId,
              chatId,
              body: text,
              dedupeKey,
              status: WorkflowOutboxStatus.PROCESSING,
              nextAttemptAt: new Date(),
            }),
          );
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          outbox = (await this.workflowOutbox.findOne({ where: { dedupeKey } })) ?? undefined;
          if (!outbox || ![WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING].includes(outbox.status)) return;
          const claimed = await this.workflowOutbox.update(
            { id: outbox.id, version: outbox.version, status: outbox.status },
            { status: WorkflowOutboxStatus.PROCESSING },
          );
          if (!claimed.affected) return;
          outbox.status = WorkflowOutboxStatus.PROCESSING;
        }
      }
      const port = this.resolveMessagePort();
      if (!port) throw new Error('Message service unavailable');
      this.logger.debug('Workflow immediate send started', {
        sessionId,
        action: 'workflow_immediate_send',
        outboxId: outbox?.id,
        dedupeKey: outbox?.dedupeKey,
        chatId,
      });
      await port.sendText(sessionId, { chatId, text, linkPreview: false });
      if (outbox && this.workflowOutbox) {
        await this.workflowOutbox.update(outbox.id, {
          status: WorkflowOutboxStatus.SENT,
          sentAt: new Date(),
          attempts: outbox.attempts + 1,
          lastError: null,
        });
      }
      this.logger.debug('Workflow immediate send confirmed', {
        sessionId,
        action: 'workflow_immediate_sent',
        outboxId: outbox?.id,
        dedupeKey: outbox?.dedupeKey,
        chatId,
      });
    } catch (error) {
      if (outbox && this.workflowOutbox) {
        const attempts = outbox.attempts + 1;
        await this.workflowOutbox.update(outbox.id, {
          attempts,
          lastError: error instanceof Error ? error.message : String(error),
          status: attempts >= outbox.maxAttempts ? WorkflowOutboxStatus.FAILED : WorkflowOutboxStatus.RETRYING,
          nextAttemptAt: new Date(Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1))),
        });
        // The domain response is already durable. A disappearing Chromium target is an immediate
        // delivery failure, not an inbound-processing failure: the outbox sweep will retry after
        // the session recovers. Resolving here also prevents the projector from reporting the
        // successfully processed customer message as failed. If no outbox exists (standalone/old
        // wiring), retain the historical throw because there is then no durable recovery path.
        this.logger.warn('Workflow reply delivery deferred for automatic retry', {
          sessionId,
          action: 'workflow_reply_deferred',
          outboxId: outbox.id,
          attempt: attempts,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    } finally {
      setTimeout(() => this.systemSends.delete(key), 30_000).unref?.();
    }
  }

  private async sendDeadlineSystem(sessionId: string, chatId: string, text: string): Promise<void> {
    try {
      await this.sendSystem(sessionId, chatId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/session ['"].+['"] is not active/i.test(message)) {
        this.logger.warn('Workflow notification deferred because its session is inactive', {
          sessionId,
          action: 'workflow_notification_deferred',
        });
        return;
      }
      throw error;
    }
  }

  private async drainWorkflowOutbox(now: Date): Promise<void> {
    if (!this.workflowOutbox) return;
    await this.workflowOutbox.update(
      {
        status: WorkflowOutboxStatus.PROCESSING,
        updatedAt: LessThanOrEqual(new Date(now.getTime() - 120_000)),
      },
      {
        status: WorkflowOutboxStatus.RETRYING,
        nextAttemptAt: now,
        lastError: 'Envio interrompido antes da confirmação; reenfileirado automaticamente.',
      },
    );
    // Filter exhausted failures in SQL, before LIMIT. Filtering after loading
    // the batch lets old failures starve all newer messages indefinitely.
    const rows = await this.workflowOutbox
      .createQueryBuilder('outbox')
      .where({
        status: In([WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING, WorkflowOutboxStatus.FAILED]),
        nextAttemptAt: LessThanOrEqual(now),
      })
      .andWhere('(outbox.status != :failed OR outbox.attempts <= outbox.maxAttempts)', {
        failed: WorkflowOutboxStatus.FAILED,
      })
      .orderBy('outbox.nextAttemptAt', 'ASC')
      .addOrderBy('outbox.id', 'ASC')
      .take(25)
      .getMany();
    const port = this.resolveMessagePort();
    if (!port) return;
    for (const row of rows) {
      if (this.workflowHub && !(await this.workflowHub.isOutboxMessageCurrent(row))) {
        await this.workflowOutbox.update(
          { id: row.id, version: row.version, status: row.status },
          {
            status: WorkflowOutboxStatus.CANCELLED,
            lastError: 'Notificação descartada porque a informação relacionada não está mais vigente.',
          },
        );
        continue;
      }
      const claimed = await this.workflowOutbox.update(
        { id: row.id, version: row.version, status: row.status },
        { status: WorkflowOutboxStatus.PROCESSING },
      );
      if (!claimed.affected) continue;
      try {
        this.logger.debug('Workflow outbox send started', {
          sessionId: row.sessionId,
          action: 'workflow_outbox_send',
          outboxId: row.id,
          dedupeKey: row.dedupeKey,
          attempt: row.attempts + 1,
        });
        await port.sendText(row.sessionId, {
          chatId: row.chatId,
          text: row.body,
          linkPreview: false,
        });
        await this.workflowOutbox.update(row.id, {
          status: WorkflowOutboxStatus.SENT,
          sentAt: new Date(),
          attempts: row.attempts + 1,
          ...(row.dedupeKey.startsWith('privacy-deletion:')
            ? {
                chatId: `anonymized:${row.id}`,
                body: '[conteudo removido apos confirmacao de exclusao]',
                lastError: null,
              }
            : {}),
        });
        this.logger.debug('Workflow outbox send confirmed', {
          sessionId: row.sessionId,
          action: 'workflow_outbox_sent',
          outboxId: row.id,
          dedupeKey: row.dedupeKey,
          attempt: row.attempts + 1,
        });
      } catch (error) {
        const attempts = row.attempts + 1;
        await this.workflowOutbox.update(row.id, {
          attempts,
          status: attempts >= row.maxAttempts ? WorkflowOutboxStatus.FAILED : WorkflowOutboxStatus.RETRYING,
          lastError: error instanceof Error ? error.message : String(error),
          nextAttemptAt: new Date(Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1))),
        });
      }
    }
  }

  private async runRetentionSweep(now: Date): Promise<void> {
    if (now.getTime() - this.lastRetentionSweepAt < 24 * 60 * 60_000) return;
    this.lastRetentionSweepAt = now.getTime();
    const retentionDays = this.technicalRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000);
    const processed = await this.processedRepo.delete({ createdAt: LessThanOrEqual(cutoff) });
    const outbox = this.workflowOutbox
      ? await this.workflowOutbox.delete({
          status: In([WorkflowOutboxStatus.SENT, WorkflowOutboxStatus.CANCELLED]),
          updatedAt: LessThanOrEqual(cutoff),
        })
      : undefined;
    const privacyEvents = this.workflowPrivacyEvents
      ? await this.workflowPrivacyEvents.delete({ createdAt: LessThanOrEqual(cutoff) })
      : undefined;
    if ((processed.affected ?? 0) + (outbox?.affected ?? 0) + (privacyEvents?.affected ?? 0) > 0)
      this.logger.log('Workflow retention cleanup completed', {
        action: 'workflow_retention_cleanup',
        retentionDays,
        processedMessages: processed.affected ?? 0,
        outboxMessages: outbox?.affected ?? 0,
        privacyEvents: privacyEvents?.affected ?? 0,
        cutoff: cutoff.toISOString(),
      });
  }

  private technicalRetentionDays(): number {
    const configured = Number(
      this.configService?.get<string>('WORKFLOW_TECHNICAL_RETENTION_DAYS') ??
        process.env.WORKFLOW_TECHNICAL_RETENTION_DAYS ??
        365,
    );
    if (!Number.isFinite(configured)) return 365;
    return Math.min(3650, Math.max(30, Math.trunc(configured)));
  }

  private resolveMessagePort(): PluginMessagePort | undefined {
    if (!this.messagePort) this.messagePort = this.moduleRef?.get(PLUGIN_MESSAGE_PORT, { strict: false });
    return this.messagePort;
  }

  private async addTicketEvent(
    ticketId: string,
    type: string,
    actorId: string | null,
    metadata: Record<string, unknown> | null = null,
  ): Promise<void> {
    await this.eventRepo.save(this.eventRepo.create({ ticketId, type, actorId, metadata }));
  }

  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(key, next);
    // Do not use an ownerless `next.finally(...)` here. `finally` creates a second promise that
    // mirrors `next`'s rejection; the caller correctly handles `next`, but that derived promise
    // would still reach `unhandledRejection` when Chromium closes during a send. Observe both
    // settlement branches explicitly so cleanup never manufactures a second rejection, while the
    // original promise keeps rejecting to its real caller (which records/logs the send failure).
    void next.then(
      () => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      },
      () => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      },
    );
    return next;
  }

  private msg(settings: TalentPoolSettings, key: string): string {
    return settings.messages[key] || DEFAULT_MESSAGES[key];
  }

  private normalize(value: unknown): string {
    const text = ['string', 'number', 'boolean', 'bigint'].includes(typeof value) ? String(value) : '';
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
  }

  private plusMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
  }

  private phoneFromContact(contactId: string): string | null {
    if (contactId.endsWith('@lid')) return null;
    const digits = contactId.split('@')[0].replace(/\D/g, '');
    return digits || null;
  }

  private isPluginActiveForSession(sessionId: string): boolean {
    if (!this.pluginLoader) return true;
    const plugin = this.pluginLoader.getPlugin(WORKFLOW_HUB_PLUGIN_ID);
    return Boolean(
      plugin &&
      plugin.status === PluginStatus.ENABLED &&
      isPluginActiveForSession(plugin.manifest.sessionScoped !== false, plugin.activeSessions ?? ['*'], sessionId),
    );
  }
}
