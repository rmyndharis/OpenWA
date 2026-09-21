import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { createContext, Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { completeWorkflowMessages, DEFAULT_WORKFLOW_MESSAGES, placeWorkflowQuestionChoices } from './workflow-messages';
import {
  AppointmentSlotStatus,
  AppointmentStatus,
  DEFAULT_WORKFLOW_RECORD_MENU,
  DeletionRequestStatus,
  WorkflowAppointment,
  WorkflowAppointmentNotification,
  WorkflowAppointmentNotificationEvent,
  WorkflowAppointmentSlot,
  WorkflowConsent,
  WorkflowDeletionRequest,
  WorkflowDefinitionVersion,
  WorkflowDepartment,
  WorkflowFieldDefinition,
  WorkflowFieldType,
  WorkflowGraphDefinition,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowInstance,
  WorkflowInstanceStatus,
  WorkflowIdentity,
  WorkflowIdentityContact,
  WorkflowInterviewPhase,
  WorkflowRecord,
  WorkflowRecordIngestEvent,
  WorkflowRecordMenuAction,
  WorkflowRecordMenuConfig,
  WorkflowProximityStatus,
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
  WorkflowTicketCloseReason,
  WorkflowTicketEvent,
  WorkflowTicketStatus,
  WorkflowPrivacyEvent,
  WorkflowOutboxMessage,
  WorkflowOutboxStatus,
  WorkflowVersionStatus,
  WorkflowVersionDefinition,
} from './entities/workflow-hub.entity';
import {
  CreateAppointmentSlotsDto,
  RescheduleAppointmentSlotDto,
  CreateWorkflowInstanceDto,
  SaveWorkflowDraftDto,
  UpdateWorkflowDepartmentDto,
  UpdateWorkflowInstanceDto,
  UpdateAppointmentSlotDto,
  UpdateRecruitmentApplicationDto,
  UpdateTalentPoolEntryDto,
  UpdateWorkflowRecordDto,
} from './dto/workflow-hub.dto';
import { TalentCandidate, TalentFlowSession, TalentPoolSettings } from './entities/talent-pool.entity';
import { Message } from '../message/entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { createLogger } from '../../common/services/logger.service';
import {
  encontrarLocaisPorProximidade,
  ProximityServiceError,
  type BrazilianPostalAddress,
  type ProximityDestination,
} from './workflow-proximity';
import { reconcileWorkflowRecordData } from './workflow-record-schema';
import { isChatAllowedByScope } from '../../common/utils/chat-id';

const EMPTY_SCHEDULE = { timezone: 'America/Sao_Paulo', weekdays: {}, exceptions: [] };
const SKIPPED_VALUE = '__OPENWA_SKIPPED__';
const ADDRESS_ANSWER_KEYS = new Set([
  'endereco_cep',
  'cep',
  'endereco_logradouro',
  'logradouro',
  'rua',
  'endereco_numero',
  'numero',
  'endereco_complemento',
  'complemento',
  'endereco_bairro',
  'bairro',
  'endereco_cidade',
  'cidade',
  'endereco_estado',
  'endereco_uf',
  'estado',
  'uf',
]);

@Injectable()
export class WorkflowHubService {
  private readonly logger = createLogger('WorkflowHubService');
  private readonly phoneResolutionAttemptedAt = new Map<string, number>();
  private readonly proximityGeocodeCache = new Map<string, { latitude: number; longitude: number }>();
  private readonly ingestQueues = new Map<string, Promise<void>>();
  private proximityRequestQueue: Promise<void> = Promise.resolve();
  private nextNominatimRequestAt = 0;
  private proximitySweepRunning = false;

  constructor(
    @InjectDataSource('data') private readonly dataSource: DataSource,
    @InjectRepository(WorkflowDepartment, 'data') private readonly departments: Repository<WorkflowDepartment>,
    @InjectRepository(WorkflowInstance, 'data') private readonly instances: Repository<WorkflowInstance>,
    @InjectRepository(WorkflowDefinitionVersion, 'data')
    private readonly versions: Repository<WorkflowDefinitionVersion>,
    @InjectRepository(WorkflowRun, 'data') private readonly runs: Repository<WorkflowRun>,
    @InjectRepository(WorkflowRecord, 'data') private readonly records: Repository<WorkflowRecord>,
    @InjectRepository(WorkflowRecordVersion, 'data')
    private readonly recordVersions: Repository<WorkflowRecordVersion>,
    @InjectRepository(WorkflowConsent, 'data') private readonly consents: Repository<WorkflowConsent>,
    @InjectRepository(WorkflowDeletionRequest, 'data')
    private readonly deletionRequests: Repository<WorkflowDeletionRequest>,
    @InjectRepository(WorkflowAppointmentSlot, 'data') private readonly slots: Repository<WorkflowAppointmentSlot>,
    @InjectRepository(WorkflowAppointment, 'data') private readonly appointments: Repository<WorkflowAppointment>,
    @InjectRepository(WorkflowRecruitmentApplication, 'data')
    private readonly recruitmentApplications: Repository<WorkflowRecruitmentApplication>,
    @InjectRepository(WorkflowRecruitmentEvent, 'data')
    private readonly recruitmentEvents: Repository<WorkflowRecruitmentEvent>,
    @InjectRepository(WorkflowTicket, 'data') private readonly tickets: Repository<WorkflowTicket>,
    @InjectRepository(WorkflowTicketEvent, 'data') private readonly ticketEvents: Repository<WorkflowTicketEvent>,
    @InjectRepository(WorkflowPrivacyEvent, 'data') private readonly privacyEvents: Repository<WorkflowPrivacyEvent>,
    @InjectRepository(WorkflowOutboxMessage, 'data') private readonly outbox: Repository<WorkflowOutboxMessage>,
    @Optional() private readonly engines?: EngineRegistry,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async isEnabledForSession(sessionId: string): Promise<boolean> {
    const department = await this.departments.findOne({ where: { sessionId, enabled: true } });
    if (!department) return false;
    return this.instances.exists({ where: { departmentId: department.id, status: WorkflowInstanceStatus.PUBLISHED } });
  }

  /** Prevents delayed notifications from being delivered after their underlying state changed. */
  async isOutboxMessageCurrent(row: Pick<WorkflowOutboxMessage, 'dedupeKey'>): Promise<boolean> {
    const parts = row.dedupeKey.split(':');
    if (parts[0] === 'appointment-reminder' && parts[1])
      return this.appointments.exists({ where: { id: parts[1], status: AppointmentStatus.CONFIRMED } });
    if (parts[0] === 'appointment-confirmed' && parts[1])
      return this.appointments.exists({ where: { id: parts[1], status: AppointmentStatus.CONFIRMED } });
    if (parts[0] === 'appointment-cancelled' && parts[1])
      return this.appointments.exists({ where: { id: parts[1], status: AppointmentStatus.CANCELLED } });
    if (parts[0] === 'appointment-completed' && parts[1])
      return this.appointments.exists({ where: { id: parts[1], status: AppointmentStatus.COMPLETED } });
    if (parts[0] === 'appointment-rescheduled' && parts[1] && parts[2]) {
      const original = await this.appointments.findOneBy({ id: parts[1] });
      return original
        ? this.appointments.exists({
            where: { slotId: parts[2], contactId: original.contactId, status: AppointmentStatus.CONFIRMED },
          })
        : false;
    }
    if (parts[0] === 'ticket-manual-close' && parts[1])
      return this.tickets.exists({ where: { id: parts[1], status: WorkflowTicketStatus.CLOSED } });
    return true;
  }

  async cancelStaleOutboxMessages(): Promise<number> {
    const rows = await this.outbox.find({
      where: {
        status: In([WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING, WorkflowOutboxStatus.FAILED]),
      },
      take: 500,
    });
    let cancelled = 0;
    for (const row of rows) {
      if (await this.isOutboxMessageCurrent(row)) continue;
      const result = await this.outbox.update(
        { id: row.id, version: row.version, status: row.status },
        {
          status: WorkflowOutboxStatus.CANCELLED,
          lastError: 'Notificação descartada porque a informação relacionada não está mais vigente.',
        },
      );
      cancelled += result.affected ?? 0;
    }
    return cancelled;
  }

  async outboxHealth(sessionId: string): Promise<{
    counts: Record<WorkflowOutboxStatus, number>;
    pendingDue: number;
    failures: Array<{
      id: string;
      status: WorkflowOutboxStatus;
      attempts: number;
      maxAttempts: number;
      nextAttemptAt: Date;
      updatedAt: Date;
      reason: 'SEM_CONEXAO' | 'TIMEOUT' | 'DESTINO_INVALIDO' | 'FALHA_ENVIO';
      exhausted: boolean;
    }>;
    unsent: Array<{
      id: string;
      status: WorkflowOutboxStatus;
      attempts: number;
      maxAttempts: number;
      nextAttemptAt: Date;
      updatedAt: Date;
      reason: 'SEM_CONEXAO' | 'TIMEOUT' | 'DESTINO_INVALIDO' | 'FALHA_ENVIO' | null;
      exhausted: boolean;
    }>;
  }> {
    const statuses = Object.values(WorkflowOutboxStatus);
    const entries = await Promise.all(
      statuses.map(async status => [status, await this.outbox.countBy({ sessionId, status })] as const),
    );
    const counts = Object.fromEntries(entries) as Record<WorkflowOutboxStatus, number>;
    const pendingDue = await this.outbox.count({
      where: {
        sessionId,
        status: In([WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING]),
        nextAttemptAt: LessThanOrEqual(new Date()),
      },
    });
    const rows = await this.outbox.find({
      where: { sessionId, status: In([WorkflowOutboxStatus.FAILED, WorkflowOutboxStatus.RETRYING]) },
      order: { updatedAt: 'DESC' },
      take: 50,
    });
    const unsent = await this.outbox.find({
      where: {
        sessionId,
        status: In([WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING, WorkflowOutboxStatus.FAILED]),
      },
      order: { updatedAt: 'DESC' },
      take: 100,
    });
    return {
      counts,
      pendingDue,
      failures: rows.map(row => ({
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        nextAttemptAt: row.nextAttemptAt,
        updatedAt: row.updatedAt,
        reason: this.classifyOutboxError(row.lastError),
        exhausted: row.status === WorkflowOutboxStatus.FAILED && row.attempts > row.maxAttempts,
      })),
      unsent: unsent.map(row => ({
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        nextAttemptAt: row.nextAttemptAt,
        updatedAt: row.updatedAt,
        reason: row.lastError ? this.classifyOutboxError(row.lastError) : null,
        exhausted: row.status === WorkflowOutboxStatus.FAILED && row.attempts > row.maxAttempts,
      })),
    };
  }

  async retryOutboxMessage(sessionId: string, id: string): Promise<{ id: string; status: WorkflowOutboxStatus }> {
    const row = await this.outbox.findOne({ where: { id, sessionId } });
    if (!row) throw new NotFoundException('Envio não encontrado.');
    if (![WorkflowOutboxStatus.RETRYING, WorkflowOutboxStatus.FAILED].includes(row.status))
      throw new ConflictException('Somente um envio em falha ou nova tentativa pode ser reenfileirado.');
    if (!(await this.isOutboxMessageCurrent(row))) {
      await this.outbox.update(
        { id: row.id, sessionId, version: row.version, status: row.status },
        {
          status: WorkflowOutboxStatus.CANCELLED,
          lastError: 'Notificação descartada porque a informação relacionada não está mais vigente.',
        },
      );
      throw new ConflictException('Este envio ficou obsoleto e foi descartado sem enviar mensagem.');
    }
    const result = await this.outbox.update(
      { id: row.id, sessionId, version: row.version, status: row.status },
      {
        status: WorkflowOutboxStatus.RETRYING,
        maxAttempts:
          row.status === WorkflowOutboxStatus.FAILED ? Math.max(row.attempts, row.maxAttempts) : row.maxAttempts,
        nextAttemptAt: new Date(),
        lastError: 'Nova tentativa solicitada pelo administrador.',
      },
    );
    if (!result.affected) throw new ConflictException('O envio mudou enquanto era reenfileirado. Atualize a tela.');
    await this.audit?.logWarn(AuditAction.WORKFLOW_OUTBOX_RETRIED, {
      sessionId,
      metadata: { outboxId: row.id, previousStatus: row.status },
    });
    return { id: row.id, status: WorkflowOutboxStatus.RETRYING };
  }

  async discardOutboxMessage(sessionId: string, id: string): Promise<{ id: string; status: WorkflowOutboxStatus }> {
    const row = await this.outbox.findOne({ where: { id, sessionId } });
    if (!row) throw new NotFoundException('Envio não encontrado.');
    if (
      ![WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING, WorkflowOutboxStatus.FAILED].includes(row.status)
    )
      throw new ConflictException('Somente um envio ainda não concluído pode ser descartado.');
    const result = await this.outbox.update(
      { id: row.id, sessionId, version: row.version, status: row.status },
      {
        status: WorkflowOutboxStatus.CANCELLED,
        lastError: 'Envio descartado manualmente pelo administrador.',
      },
    );
    if (!result.affected) throw new ConflictException('O envio mudou enquanto era descartado. Atualize a tela.');
    await this.audit?.logWarn(AuditAction.WORKFLOW_OUTBOX_CANCELLED, {
      sessionId,
      metadata: { outboxId: row.id, previousStatus: row.status },
    });
    return { id: row.id, status: WorkflowOutboxStatus.CANCELLED };
  }

  private classifyOutboxError(error: string | null): 'SEM_CONEXAO' | 'TIMEOUT' | 'DESTINO_INVALIDO' | 'FALHA_ENVIO' {
    const value = (error ?? '').toLocaleLowerCase('en-US');
    if (/timeout|timed out|prazo/.test(value)) return 'TIMEOUT';
    if (/not connected|disconnected|unavailable|sem conex|não conect/.test(value)) return 'SEM_CONEXAO';
    if (/invalid.*(chat|recipient|number)|destino|número inválido/.test(value)) return 'DESTINO_INVALIDO';
    return 'FALHA_ENVIO';
  }

  /** Removes legacy copies for subjects whose deletion was already approved in workflow-hub. */
  async purgeLegacyPrivacyResidue(): Promise<number> {
    const candidates = await this.dataSource.getRepository(TalentCandidate).find();
    if (!candidates.length) return 0;
    const departments = await this.departments.find();
    const instances = departments.length
      ? await this.instances.find({ where: { departmentId: In(departments.map(row => row.id)) } })
      : [];
    const privacyEvents = instances.length
      ? await this.privacyEvents.find({ where: { instanceId: In(instances.map(row => row.id)) } })
      : [];
    const deletedHashes = new Set(
      privacyEvents
        .filter(event => ['DATA_DELETION_APPROVED', 'DATA_DELETION_BY_ADMIN'].includes(event.type))
        .map(event => `${event.instanceId}:${event.anonymousSubjectHash}`),
    );
    let purged = 0;
    for (const candidate of candidates) {
      const department = departments.find(row => row.sessionId === candidate.sessionId);
      if (!department) continue;
      const matched = instances
        .filter(instance => instance.departmentId === department.id)
        .some(instance => {
          const hash = createHash('sha256').update(`${instance.id}:${candidate.contactId}`).digest('hex');
          return deletedHashes.has(`${instance.id}:${hash}`);
        });
      if (!matched) continue;
      await this.dataSource.transaction(async manager => {
        await manager
          .getRepository(TalentFlowSession)
          .delete({ sessionId: candidate.sessionId, contactId: candidate.contactId });
        await manager.getRepository(TalentCandidate).delete({ id: candidate.id });
      });
      purged += 1;
    }
    return purged;
  }

  listTemplates(): Array<{ key: string; name: string; description: string; fields: WorkflowFieldDefinition[] }> {
    return [
      {
        key: 'cadastro',
        name: 'Cadastro geral',
        description: 'Nome, telefone e e-mail.',
        fields: [
          { id: 'nome', label: 'Nome', prompt: 'Qual é o seu nome completo?', type: 'text', required: true, order: 1 },
          {
            id: 'telefone',
            label: 'Telefone',
            prompt: 'Qual é o seu telefone com DDD?',
            type: 'phone',
            required: true,
            order: 2,
          },
          { id: 'email', label: 'E-mail', prompt: 'Qual é o seu e-mail?', type: 'email', required: true, order: 3 },
        ],
      },
      {
        key: 'talentos',
        name: 'Banco de talentos',
        description: 'Cadastro profissional com currículo em PDF.',
        fields: [
          { id: 'nome', label: 'Nome', prompt: 'Qual é o seu nome completo?', type: 'text', required: true, order: 1 },
          { id: 'email', label: 'E-mail', prompt: 'Qual é o seu e-mail?', type: 'email', required: true, order: 2 },
          {
            id: 'area',
            label: 'Área de interesse',
            prompt: 'Qual é sua área de interesse?',
            type: 'text',
            required: true,
            order: 3,
          },
          {
            id: 'curriculo',
            label: 'Currículo',
            prompt: 'Envie seu currículo em PDF.',
            type: 'pdf',
            required: true,
            order: 4,
            confidential: true,
          },
        ],
      },
      {
        key: 'agenda',
        name: 'Agendamento',
        description: 'Cadastro simples e escolha de horário disponível.',
        fields: [
          { id: 'nome', label: 'Nome', prompt: 'Qual é o seu nome?', type: 'text', required: true, order: 1 },
          {
            id: 'horario',
            label: 'Horário',
            prompt: 'Escolha um horário disponível:',
            type: 'appointment',
            required: true,
            order: 2,
          },
        ],
      },
      {
        key: 'roadmap',
        name: 'Coleta para roadmap',
        description: 'Coleta de sugestões e prioridade.',
        fields: [
          {
            id: 'titulo',
            label: 'Título',
            prompt: 'Qual é o título da sugestão?',
            type: 'text',
            required: true,
            order: 1,
          },
          {
            id: 'descricao',
            label: 'Descrição',
            prompt: 'Descreva a sugestão:',
            type: 'textarea',
            required: true,
            order: 2,
          },
          {
            id: 'prioridade',
            label: 'Prioridade',
            prompt: 'Escolha a prioridade:',
            type: 'select',
            required: true,
            order: 3,
            options: ['Baixa', 'Média', 'Alta'],
          },
        ],
      },
    ];
  }

  async createFromTemplate(sessionId: string, key: string, name?: string): Promise<WorkflowInstance> {
    const template = this.listTemplates().find(row => row.key === key);
    if (!template) throw new NotFoundException('Modelo de fluxo não encontrado.');
    return this.createInstance(sessionId, {
      name: name?.trim() || template.name,
      description: template.description,
      keywords: [key],
      fields: template.fields,
    });
  }

  /** Executes the generic WhatsApp state machine and returns the messages the plugin must send. */
  async processInbound(
    sessionId: string,
    contactId: string,
    chatId: string,
    body: string,
    attachment?: { type: string; metadata?: Record<string, unknown>; messageId: string; waMessageId?: string },
  ): Promise<string[]> {
    const department = await this.departments.findOne({ where: { sessionId, enabled: true } });
    if (!department) return [];
    const instances = await this.instances.find({
      where: { departmentId: department.id, status: WorkflowInstanceStatus.PUBLISHED },
      order: { createdAt: 'ASC' },
    });
    if (!instances.length) return [];
    const identity = await this.ensureWorkflowIdentity(department.id, sessionId, contactId);
    const key = `${department.id}:${contactId}`;
    let run = await this.runs.findOne({ where: { openKey: key } });
    const answer = body.trim();
    if (run && [WorkflowRunState.HUMAN, WorkflowRunState.IDLE_WARNING].includes(run.state)) {
      await this.touchHumanActivity(sessionId, chatId, 'CLIENT_MESSAGE', null);
      return [];
    }
    if (!run) {
      run = await this.runs.save(
        this.runs.create({
          departmentId: department.id,
          identityId: identity.id,
          contactId,
          chatId,
          openKey: key,
          state: WorkflowRunState.SECTOR_MENU,
          deadlineAt: this.plusMinutes(new Date(), department.menuTimeoutMinutes),
        }),
      );
      const byKeyword = this.findInstance(instances, answer);
      if (byKeyword) return this.startInstance(run, byKeyword, contactId);
      return [this.renderSectorMenu(department, instances)];
    }
    if (run.identityId !== identity.id) {
      run.identityId = identity.id;
      await this.runs.save(run);
    }
    if (run.state === WorkflowRunState.SECTOR_MENU) {
      const selected = this.findInstance(instances, answer);
      if (!selected) return [`Opção inválida.\n\n${this.renderSectorMenu(department, instances)}`];
      return this.startInstance(run, selected, contactId);
    }
    const instance = run.instanceId ? await this.instances.findOneBy({ id: run.instanceId }) : null;
    const version = run.versionId ? await this.versions.findOneBy({ id: run.versionId }) : null;
    if (!instance || !version || instance.status !== WorkflowInstanceStatus.PUBLISHED) {
      await this.runs.delete(run.id);
      return ['Este fluxo não está mais disponível. Envie uma nova mensagem para abrir o menu.'];
    }
    const effectiveContactId = await this.canonicalRecordContactId(run, instance.id, contactId);
    if (this.contextMode(run) === 'schema_update') {
      const requested = this.contextStringArray(run, 'collectFieldIds');
      const reachable = this.reachableSchemaUpdateFields(version, run.draft, requested);
      const applicable = requested.filter(fieldId => reachable.has(fieldId));
      if (!applicable.length) {
        await this.records.update(
          { instanceId: instance.id, contactId: effectiveContactId, status: WorkflowRecordStatus.VALID },
          { definitionVersionId: version.id },
        );
        run.state = WorkflowRunState.REGISTERED_MENU;
        run.draft = {};
        run.context = {};
        run.deadlineAt = this.plusMinutes(new Date(), department.menuTimeoutMinutes);
        await this.runs.save(run);
        return [await this.renderRecordMenu(instance, effectiveContactId)];
      }
      if (applicable.length !== requested.length) {
        run.context = { ...run.context, collectFieldIds: applicable };
        await this.runs.save(run);
      }
    }
    if (run.state === WorkflowRunState.REGISTERED_MENU && instance.currentVersionId !== run.versionId)
      return this.startInstance(run, instance, contactId);
    if (/^menu$/i.test(answer)) {
      await this.releaseRunHolds(run.id);
      run.instanceId = null;
      run.versionId = null;
      run.state = WorkflowRunState.SECTOR_MENU;
      run.step = 0;
      run.draft = {};
      run.context = {};
      run.deadlineAt = this.plusMinutes(new Date(), department.menuTimeoutMinutes);
      await this.runs.save(run);
      return [this.renderSectorMenu(department, instances)];
    }
    const keywordTarget = this.findInstance(instances, answer);
    if (keywordTarget && keywordTarget.id !== instance.id && run.state !== WorkflowRunState.SWITCH_CONFIRM) {
      const previousState = run.state;
      run.state = WorkflowRunState.SWITCH_CONFIRM;
      run.context = { ...run.context, switchTo: keywordTarget.id, previousState };
      await this.runs.save(run);
      return [
        `Deseja interromper “${instance.name}”, apagar as respostas temporárias e abrir “${keywordTarget.name}”? Responda SIM ou NÃO.`,
      ];
    }
    if (run.state === WorkflowRunState.SWITCH_CONFIRM) {
      if (this.isYes(answer)) {
        const target = instances.find(row => row.id === run.context.switchTo);
        if (target) return this.startInstance(run, target, contactId);
      }
      run.state = (run.context.previousState as WorkflowRunState) || WorkflowRunState.FILLING;
      run.context = { ...run.context, switchTo: undefined, previousState: undefined };
      await this.runs.save(run);
      return ['Troca cancelada. Continue respondendo ao fluxo atual.'];
    }
    if (run.state === WorkflowRunState.CONSENT) {
      if (!this.isYes(answer)) {
        run.openKey = null;
        run.state = WorkflowRunState.CLOSED;
        await this.runs.save(run);
        return ['Sem o consentimento não é possível continuar. O atendimento foi encerrado.'];
      }
      run.state = WorkflowRunState.FILLING;
      run.step = this.nextFieldIndex(version.fields, 0, run.draft, this.contextMode(run), this.contextFieldIds(run));
      run.context = { ...run.context, consentAccepted: true };
      run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
      await this.runs.save(run);
      if (run.context.mode === 'renewal') return this.moveToReview(run, instance, version);
      if (run.context.mode === 'update') {
        run.state = WorkflowRunState.CORRECTION_FIELD;
        await this.runs.save(run);
        return [`Qual dado deseja atualizar?\n${this.renderCorrectionMenu(version.fields, run.draft, true)}`];
      }
      const graph = this.workflowGraph(version);
      if (graph) {
        run.context = { ...run.context, currentNodeId: undefined, graphHistory: [] };
        return this.advanceGraph(run, instance, version, graph.startNodeId);
      }
      if (run.step >= version.fields.length) return this.moveToReview(run, instance, version);
      return [await this.renderQuestion(version.fields[run.step], instance.id, run.id)];
    }
    if (run.state === WorkflowRunState.FILLING) return this.handleField(run, instance, version, answer, attachment);
    if (run.state === WorkflowRunState.REVIEW)
      return this.handleReview(run, instance, version, answer, effectiveContactId);
    if (run.state === WorkflowRunState.CORRECTION_FIELD)
      return this.handleCorrectionSelection(run, instance, version, answer);
    if (run.state === WorkflowRunState.APPOINTMENT_RESCHEDULE)
      return this.handleCustomerAppointmentReschedule(run, instance, answer, effectiveContactId);
    if (run.state === WorkflowRunState.APPOINTMENT_CANCEL_CONFIRM)
      return this.handleCustomerAppointmentCancellation(run, instance, answer, effectiveContactId);
    if (run.state === WorkflowRunState.REGISTERED_MENU) {
      return this.handleRecordMenu(run, instance, version, answer, effectiveContactId);
    }
    if (run.state === WorkflowRunState.DELETION_PENDING)
      return ['Seu cadastro está bloqueado enquanto a solicitação de exclusão aguarda decisão do administrador.'];
    return [];
  }

  async getDepartment(sessionId: string): Promise<WorkflowDepartment> {
    let row = await this.departments.findOne({ where: { sessionId } });
    if (!row) {
      row = await this.departments.save(
        this.departments.create({
          sessionId,
          name: 'Meu setor',
          timezone: 'America/Sao_Paulo',
          schedule: EMPTY_SCHEDULE,
          messages: {},
          candidateTableColumns: [],
        }),
      );
    }
    return row;
  }

  async updateDepartment(sessionId: string, dto: UpdateWorkflowDepartmentDto): Promise<WorkflowDepartment> {
    const row = await this.getDepartment(sessionId);
    const previousDestinationHash = this.destinationHash(this.proximityDestinations(row));
    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.timezone !== undefined) {
      const timezone = dto.timezone.trim();
      this.assertValidTimezone(timezone);
      row.timezone = timezone;
    }
    if (dto.menuTimeoutMinutes !== undefined) row.menuTimeoutMinutes = dto.menuTimeoutMinutes;
    if (dto.messages !== undefined) {
      const messages = this.normalizeMessages(dto.messages);
      if (messages.sectorMenu && !messages.sectorMenu.includes('{fluxos}'))
        throw new BadRequestException('A mensagem do menu inicial precisa manter a variável {fluxos}.');
      row.messages = messages;
    }
    if (dto.candidateTableColumns !== undefined) {
      const seen = new Set<string>();
      row.candidateTableColumns = dto.candidateTableColumns.filter(column => {
        if (seen.has(column.id)) return false;
        seen.add(column.id);
        return true;
      });
    }
    if (dto.schedule !== undefined) {
      const normalizedSchedule: WorkflowDepartment['schedule'] = {
        ...dto.schedule,
        locations: dto.schedule.locations?.map(location => {
          const notificationContacts = (location.notificationContacts ?? []).map((contact, index) => ({
            id: String(contact.id ?? '').trim() || `${location.id}-contact-${index + 1}`,
            role: String(contact.role ?? '').trim(),
            name: String(contact.name ?? '').trim(),
            ddi: String(contact.ddi ?? '').replace(/\D/g, ''),
            ddd: String(contact.ddd ?? '').replace(/\D/g, ''),
            number: String(contact.number ?? '').replace(/\D/g, ''),
            enabled: contact.enabled !== false,
          }));
          return {
            id: location.id,
            ...(location.internalName?.trim() ? { internalName: location.internalName.trim() } : {}),
            name: location.name.trim(),
            ...(location.address?.trim() ? { address: location.address.trim() } : {}),
            ...(location.mapsUrl?.trim() ? { mapsUrl: location.mapsUrl.trim() } : {}),
            ...(Number.isFinite(location.latitude) ? { latitude: location.latitude } : {}),
            ...(Number.isFinite(location.longitude) ? { longitude: location.longitude } : {}),
            ...(notificationContacts.length ? { notificationContacts } : {}),
          };
        }),
      };
      this.assertValidSchedule(normalizedSchedule);
      row.schedule = normalizedSchedule;
    }
    const saved = await this.departments.save(row);
    if (
      dto.schedule !== undefined &&
      previousDestinationHash !== this.destinationHash(this.proximityDestinations(saved))
    )
      await this.refreshDepartmentProximityQueue(saved);
    return saved;
  }

  async setHumanServiceEnabled(sessionId: string, enabled: boolean): Promise<{ department: WorkflowDepartment }> {
    return this.dataSource.transaction(async manager => {
      const departmentRepo = manager.getRepository(WorkflowDepartment);
      const departmentQuery = departmentRepo
        .createQueryBuilder('department')
        .where('department.sessionId = :sessionId', { sessionId });
      if (!['sqlite', 'better-sqlite3'].includes(String(manager.connection.options.type)))
        departmentQuery.setLock('pessimistic_write');
      const department = await departmentQuery.getOne();
      if (!department) throw new NotFoundException('Setor não encontrado.');
      department.humanServiceEnabled = enabled;
      const saved = await departmentRepo.save(department);
      return { department: saved };
    });
  }

  async listInstances(sessionId: string): Promise<Array<WorkflowInstance & { versions: WorkflowDefinitionVersion[] }>> {
    const department = await this.getDepartment(sessionId);
    const rows = await this.instances.find({ where: { departmentId: department.id }, order: { createdAt: 'ASC' } });
    if (!rows.length) return [];
    const versions = await this.versions.find({ where: { instanceId: In(rows.map(row => row.id)) } });
    return rows.map(row =>
      Object.assign(row, {
        messages: completeWorkflowMessages(row.messages),
        versions: versions.filter(version => version.instanceId === row.id),
      }),
    );
  }

  async createInstance(sessionId: string, dto: CreateWorkflowInstanceDto): Promise<WorkflowInstance> {
    const department = await this.getDepartment(sessionId);
    const slug = await this.uniqueSlug(department.id, dto.name);
    return this.dataSource.transaction(async manager => {
      const instanceRepo = manager.getRepository(WorkflowInstance);
      const versionRepo = manager.getRepository(WorkflowDefinitionVersion);
      const instance = await instanceRepo.save(
        instanceRepo.create({
          departmentId: department.id,
          name: dto.name.trim(),
          slug,
          description: dto.description?.trim() || null,
          keywords: this.normalizeKeywords(dto.keywords),
          messages: completeWorkflowMessages(undefined),
          recordMenu: this.normalizeRecordMenu(dto.recordMenu),
          status: WorkflowInstanceStatus.DRAFT,
        }),
      );
      await versionRepo.save(
        versionRepo.create({
          instanceId: instance.id,
          versionNumber: 1,
          status: WorkflowVersionStatus.DRAFT,
          fields: this.validateFields(dto.fields ?? []),
          definition: {},
        }),
      );
      return instance;
    });
  }

  /** One-time bridge that incorporates the existing RH project into the generic engine. */
  async importLegacyTalentPool(sessionId: string): Promise<WorkflowInstance> {
    const settingsRepo = this.dataSource.getRepository(TalentPoolSettings);
    const candidateRepo = this.dataSource.getRepository(TalentCandidate);
    const department = await this.getDepartment(sessionId);
    const existing = await this.instances.findOne({
      where: { departmentId: department.id, slug: 'banco-de-talentos' },
    });
    if (existing) return existing;
    const settings = await settingsRepo.findOne({ where: { sessionId } });
    if (!settings) throw new NotFoundException('Não existe configuração antiga do Banco de Talentos para importar.');
    const fields: WorkflowFieldDefinition[] = settings.fields
      .filter(field => field.enabled !== false)
      .map(({ enabled, ...field }, index) => {
        void enabled;
        return { ...field, order: index + 1 };
      });
    const instance = await this.createInstance(sessionId, {
      name: 'Banco de Talentos',
      description: 'Fluxo importado do módulo original de RH.',
      keywords: ['talentos', 'curriculo', 'currículo'],
      fields,
    });
    instance.flowTimeoutMinutes = settings.registrationTimeoutMinutes;
    instance.humanInactivityMinutes = settings.humanInactivityMinutes;
    instance.humanGraceMinutes = settings.humanGraceMinutes;
    await this.instances.save(instance);
    const published = await this.publish(sessionId, instance.id);
    for (const candidate of await candidateRepo.find({ where: { sessionId } })) {
      const validUntil = candidate.validUntil ?? new Date(new Date().setMonth(new Date().getMonth() + 12));
      const record = await this.records.save(
        this.records.create({
          instanceId: instance.id,
          contactId: candidate.contactId,
          phone: candidate.phone,
          data: candidate.data,
          validUntil,
          currentVersion: 1,
          definitionVersionId: published.currentVersionId,
        }),
      );
      await this.recordVersions.save(
        this.recordVersions.create({
          recordId: record.id,
          versionNumber: 1,
          data: candidate.data,
          source: 'IMPORTACAO_LEGADA',
          actorId: null,
        }),
      );
    }
    settings.enabled = false;
    await settingsRepo.save(settings);
    return published;
  }

  async updateInstance(sessionId: string, id: string, dto: UpdateWorkflowInstanceDto): Promise<WorkflowInstance> {
    const row = await this.requireInstance(sessionId, id);
    Object.assign(row, dto);
    if (dto.name !== undefined) row.name = dto.name.trim();
    if (dto.description !== undefined) row.description = dto.description.trim() || null;
    if (dto.keywords !== undefined) row.keywords = this.normalizeKeywords(dto.keywords);
    if (dto.appointmentNotificationNumbers !== undefined) {
      row.appointmentNotificationNumbers = this.normalizeAppointmentNotificationNumbers(
        dto.appointmentNotificationNumbers,
      );
      if (dto.appointmentNotifications === undefined) row.appointmentNotifications = [];
    }
    if (dto.appointmentNotifications !== undefined) {
      const notifications = this.normalizeAppointmentNotifications(dto.appointmentNotifications);
      const department = await this.departments.findOneBy({ id: row.departmentId });
      const validLocationIds = new Set((department?.schedule?.locations ?? []).map(location => location.id));
      const unknownLocation = notifications
        .flatMap(item => item.locationIds)
        .find(value => !validLocationIds.has(value));
      if (unknownLocation)
        throw new BadRequestException('Um dos locais selecionados para avisos não existe mais. Revise os gestores.');
      row.appointmentNotifications = notifications;
      row.appointmentNotificationNumbers = [];
    }
    if (dto.messages !== undefined) {
      const messages = this.normalizeMessages(dto.messages);
      if (messages.review && !messages.review.includes('{resumo}'))
        throw new BadRequestException('A mensagem de revisão precisa manter a variável {resumo}.');
      row.messages = completeWorkflowMessages(messages);
    }
    if (dto.recordMenu !== undefined) row.recordMenu = this.normalizeRecordMenu(dto.recordMenu);
    return this.instances.save(row);
  }

  async saveDraft(sessionId: string, id: string, dto: SaveWorkflowDraftDto): Promise<WorkflowDefinitionVersion> {
    await this.requireInstance(sessionId, id);
    let draft = await this.versions.findOne({ where: { instanceId: id, status: WorkflowVersionStatus.DRAFT } });
    if (!draft) {
      const latest = await this.versions.findOne({ where: { instanceId: id }, order: { versionNumber: 'DESC' } });
      draft = this.versions.create({ instanceId: id, versionNumber: (latest?.versionNumber ?? 0) + 1 });
    }
    draft.fields = this.validateFields(dto.fields);
    draft.definition = this.validateVersionDefinition(dto.definition ?? draft.definition ?? {}, draft.fields);
    return this.versions.save(draft);
  }

  async publish(sessionId: string, id: string): Promise<WorkflowInstance> {
    await this.requireInstance(sessionId, id);
    return this.dataSource.transaction(async manager => {
      const versionRepo = manager.getRepository(WorkflowDefinitionVersion);
      const instanceRepo = manager.getRepository(WorkflowInstance);
      const draft = await versionRepo.findOne({ where: { instanceId: id, status: WorkflowVersionStatus.DRAFT } });
      if (!draft) throw new BadRequestException('Não existe uma versão em rascunho para publicar.');
      if (!draft.fields.length) throw new BadRequestException('Adicione pelo menos um campo ao fluxo.');
      draft.definition = this.validateVersionDefinition(draft.definition ?? {}, draft.fields);
      await versionRepo.update(
        { instanceId: id, status: WorkflowVersionStatus.PUBLISHED },
        { status: WorkflowVersionStatus.RETIRED },
      );
      draft.status = WorkflowVersionStatus.PUBLISHED;
      draft.publishedAt = new Date();
      await versionRepo.save(draft);
      const row = await instanceRepo.findOneByOrFail({ id });
      row.currentVersionId = draft.id;
      row.status = WorkflowInstanceStatus.PUBLISHED;
      return instanceRepo.save(row);
    });
  }

  async pause(sessionId: string, id: string): Promise<WorkflowInstance> {
    const row = await this.requireInstance(sessionId, id);
    if (row.status !== WorkflowInstanceStatus.PUBLISHED)
      throw new ConflictException('Somente um fluxo publicado pode ser pausado.');
    row.status = WorkflowInstanceStatus.PAUSED;
    const activeRuns = await this.runs.find({ where: { instanceId: id } });
    if (activeRuns.length)
      await this.slots.update(
        { heldByRunId: In(activeRuns.map(run => run.id)), status: AppointmentSlotStatus.HELD },
        { status: AppointmentSlotStatus.AVAILABLE, heldByRunId: null, holdUntil: null },
      );
    await this.runs.delete({ instanceId: id });
    return this.instances.save(row);
  }

  async resume(sessionId: string, id: string): Promise<WorkflowInstance> {
    const row = await this.requireInstance(sessionId, id);
    if (row.status !== WorkflowInstanceStatus.PAUSED)
      throw new ConflictException('Somente um fluxo pausado pode ser reativado.');
    if (!row.currentVersionId) throw new ConflictException('O fluxo não possui uma versão publicada para reativar.');
    const publishedVersionExists = await this.versions.exists({
      where: {
        id: row.currentVersionId,
        instanceId: row.id,
        status: WorkflowVersionStatus.PUBLISHED,
      },
    });
    if (!publishedVersionExists)
      throw new ConflictException('A versão publicada atual não está disponível para reativação.');
    row.status = WorkflowInstanceStatus.PUBLISHED;
    return this.instances.save(row);
  }

  async archive(sessionId: string, id: string): Promise<WorkflowInstance> {
    const row = await this.requireInstance(sessionId, id);
    row.status = WorkflowInstanceStatus.ARCHIVED;
    const activeRuns = await this.runs.find({ where: { instanceId: id } });
    if (activeRuns.length)
      await this.slots.update(
        { heldByRunId: In(activeRuns.map(run => run.id)), status: AppointmentSlotStatus.HELD },
        { status: AppointmentSlotStatus.AVAILABLE, heldByRunId: null, holdUntil: null },
      );
    await this.runs.delete({ instanceId: id });
    return this.instances.save(row);
  }

  async duplicate(sessionId: string, id: string): Promise<WorkflowInstance> {
    const source = await this.requireInstance(sessionId, id);
    const sourceVersion = await this.versions.findOne({ where: { instanceId: id }, order: { versionNumber: 'DESC' } });
    return this.createInstance(sessionId, {
      name: `${source.name} (cópia)`,
      description: source.description ?? undefined,
      keywords: [],
      fields: sourceVersion?.fields ?? [],
      recordMenu: this.recordMenu(source),
    });
  }

  async listSlots(sessionId: string, instanceId: string, availableOnly = false): Promise<WorkflowAppointmentSlot[]> {
    await this.requireInstance(sessionId, instanceId);
    await this.slots.update(
      {
        instanceId,
        startsAt: LessThanOrEqual(new Date()),
        status: In([AppointmentSlotStatus.AVAILABLE, AppointmentSlotStatus.BLOCKED, AppointmentSlotStatus.HELD]),
      },
      {
        status: AppointmentSlotStatus.COMPLETED,
        heldByRunId: null,
        holdUntil: null,
      },
    );
    const rows = await this.slots.find({
      where: availableOnly ? { instanceId, status: AppointmentSlotStatus.AVAILABLE } : { instanceId },
      order: { startsAt: 'ASC' },
    });
    const visible = rows.filter(slot => slot.status !== AppointmentSlotStatus.REMOVED);
    if (!visible.length) return visible;
    const confirmed = await this.appointments.find({
      where: { slotId: In(visible.map(slot => slot.id)), status: AppointmentStatus.CONFIRMED },
    });
    const counts = new Map<string, number>();
    for (const appointment of confirmed) counts.set(appointment.slotId, (counts.get(appointment.slotId) ?? 0) + 1);
    for (const slot of visible) {
      const actual = counts.get(slot.id) ?? 0;
      if (slot.bookedCount === actual) continue;
      slot.bookedCount = actual;
      if (slot.status === AppointmentSlotStatus.AVAILABLE || slot.status === AppointmentSlotStatus.CONFIRMED)
        slot.status = actual >= slot.capacity ? AppointmentSlotStatus.CONFIRMED : AppointmentSlotStatus.AVAILABLE;
      await this.slots.update(slot.id, { bookedCount: slot.bookedCount, status: slot.status });
    }
    return availableOnly ? visible.filter(slot => slot.status === AppointmentSlotStatus.AVAILABLE) : visible;
  }

  async createSlots(sessionId: string, instanceId: string, dto: CreateAppointmentSlotsDto) {
    const instance = await this.requireInstance(sessionId, instanceId);
    if (!dto.slots.length) throw new BadRequestException('Informe pelo menos um horário.');
    const now = new Date();
    if (dto.slots.some(slot => new Date(slot.startsAt) <= now))
      throw new BadRequestException('Todos os horários devem estar no futuro.');
    const department = await this.departments.findOneBy({ id: instance.departmentId });
    const validLocationIds = new Set((department?.schedule?.locations ?? []).map(location => location.id));
    if (dto.slots.some(slot => slot.locationId && !validLocationIds.has(slot.locationId)))
      throw new BadRequestException('Selecione um local cadastrado válido para o horário.');
    const rows = dto.slots.map(slot =>
      this.slots.create({
        instanceId,
        startsAt: new Date(slot.startsAt),
        label: slot.label?.trim() || null,
        locationId: slot.locationId?.trim() || null,
        location: slot.location?.trim() || null,
        address: slot.address?.trim() || null,
        instruction: slot.instruction?.trim() || null,
        responsible: slot.responsible?.trim() || null,
        mapsUrl: slot.mapsUrl?.trim() || null,
        interviewPhase: slot.interviewPhase ?? WorkflowInterviewPhase.SIMPLE,
        capacity: slot.capacity ?? 1,
      }),
    );
    return this.slots.save(rows);
  }

  async updateSlot(
    sessionId: string,
    instanceId: string,
    slotId: string,
    dto: UpdateAppointmentSlotDto,
  ): Promise<WorkflowAppointmentSlot> {
    await this.requireInstance(sessionId, instanceId);
    return this.dataSource.transaction(async manager => {
      const slotRepo = manager.getRepository(WorkflowAppointmentSlot);
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const slot = await slotRepo.findOne({ where: { id: slotId, instanceId } });
      if (!slot || slot.status === AppointmentSlotStatus.REMOVED)
        throw new NotFoundException('Horário não encontrado.');

      if (dto.capacity !== undefined && dto.capacity < slot.capacity)
        throw new BadRequestException('O limite de pessoas só pode ser mantido ou aumentado nesta edição.');

      const previousInterviewPhase = slot.interviewPhase;
      const bookedCount = await appointmentRepo.count({
        where: { slotId, instanceId, status: AppointmentStatus.CONFIRMED },
      });
      slot.bookedCount = bookedCount;
      if (dto.capacity !== undefined) slot.capacity = dto.capacity;
      if (dto.instruction !== undefined) slot.instruction = dto.instruction.trim() || null;
      if (dto.responsible !== undefined) slot.responsible = dto.responsible.trim() || null;
      if (dto.interviewPhase !== undefined) slot.interviewPhase = dto.interviewPhase;
      if (slot.status === AppointmentSlotStatus.CONFIRMED && bookedCount < slot.capacity)
        slot.status = AppointmentSlotStatus.AVAILABLE;
      const saved = await slotRepo.save(slot);
      if (dto.interviewPhase !== undefined && dto.interviewPhase !== previousInterviewPhase) {
        const confirmedAppointments = await appointmentRepo.find({
          where: { slotId: saved.id, instanceId, status: AppointmentStatus.CONFIRMED },
        });
        for (const appointment of confirmedAppointments) {
          await this.syncRecruitmentApplication(
            manager,
            appointment,
            this.recruitmentStatusForAppointment(appointment, saved),
            null,
            'INTERVIEW_PHASE_CHANGED',
            { interviewPhase: saved.interviewPhase, appointmentStartsAt: saved.startsAt.toISOString() },
          );
        }
      }
      return saved;
    });
  }

  async deleteSlot(sessionId: string, instanceId: string, slotId: string): Promise<{ deleted: true }> {
    await this.requireInstance(sessionId, instanceId);
    return this.dataSource.transaction(async manager => {
      const slotRepo = manager.getRepository(WorkflowAppointmentSlot);
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const recordRepo = manager.getRepository(WorkflowRecord);
      const slot = await slotRepo.findOne({ where: { id: slotId, instanceId } });
      if (!slot) throw new NotFoundException('Horário não encontrado.');
      if (
        slot.bookedCount > 0 ||
        (await appointmentRepo.exists({ where: { slotId, status: AppointmentStatus.CONFIRMED } }))
      ) {
        throw new ConflictException(
          'Este horário possui candidatos confirmados. Informe uma nova data para reagendá-los antes da remoção.',
        );
      }
      const records = await recordRepo.find({ where: { instanceId } });
      for (const record of records) {
        if (Object.values(record.data).includes(slotId))
          await this.clearAppointmentAnswer(manager, record, slotId, 'APPOINTMENT_SLOT_REMOVED');
      }
      if (await appointmentRepo.exists({ where: { slotId } })) {
        slot.status = AppointmentSlotStatus.REMOVED;
        slot.heldByRunId = null;
        slot.holdUntil = null;
        await slotRepo.save(slot);
      } else {
        await slotRepo.delete(slot.id);
      }
      return { deleted: true };
    });
  }

  async rescheduleSlot(
    sessionId: string,
    instanceId: string,
    slotId: string,
    dto: RescheduleAppointmentSlotDto,
  ): Promise<{ slot: WorkflowAppointmentSlot; movedAppointments: number; notified: number }> {
    const instance = await this.requireInstance(sessionId, instanceId);
    const startsAt = new Date(dto.startsAt);
    if (startsAt <= new Date()) throw new BadRequestException('A nova data deve estar no futuro.');

    return this.dataSource.transaction(async manager => {
      const slotRepo = manager.getRepository(WorkflowAppointmentSlot);
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const recordRepo = manager.getRepository(WorkflowRecord);
      const oldSlot = await slotRepo.findOne({ where: { id: slotId, instanceId } });
      if (!oldSlot || oldSlot.status === AppointmentSlotStatus.REMOVED)
        throw new NotFoundException('Horário não encontrado.');
      if (dto.locationId) {
        const department = await manager.getRepository(WorkflowDepartment).findOneBy({ id: instance.departmentId });
        if (!(department?.schedule?.locations ?? []).some(location => location.id === dto.locationId))
          throw new BadRequestException('Selecione um local cadastrado válido para o novo horário.');
      }

      let activeAppointments = await appointmentRepo.find({
        where: { slotId, instanceId, status: AppointmentStatus.CONFIRMED },
      });
      // bookedCount is a fast, denormalized counter. Older releases could leave it ahead of the
      // appointment table. A valid record that still points at this slot is enough to safely rebuild
      // the missing relation before a reschedule; a real cancellation clears both the record value
      // and the counter, so it is never resurrected here.
      if (!activeAppointments.length && oldSlot.bookedCount > 0) {
        const definition = instance.currentVersionId
          ? await manager.getRepository(WorkflowDefinitionVersion).findOneBy({ id: instance.currentVersionId })
          : null;
        const appointmentKeys = (definition?.fields ?? [])
          .filter(field => field.type === 'appointment')
          .map(field => this.answerKey(field));
        const records = await recordRepo.find({ where: { instanceId, status: WorkflowRecordStatus.VALID } });
        const candidates = records.filter(record => appointmentKeys.some(key => record.data[key] === slotId));
        for (const record of candidates.slice(0, oldSlot.bookedCount)) {
          let appointment = await appointmentRepo.findOne({ where: { slotId, contactId: record.contactId } });
          if (!appointment) {
            appointment = appointmentRepo.create({
              slotId,
              instanceId,
              contactId: record.contactId,
              recordId: record.id,
            });
          } else {
            appointment.status = AppointmentStatus.CONFIRMED;
            appointment.cancelledAt = null;
            appointment.recordId = record.id;
          }
          await appointmentRepo.save(appointment);
        }
        activeAppointments = await appointmentRepo.find({
          where: { slotId, instanceId, status: AppointmentStatus.CONFIRMED },
        });
      }
      if (!activeAppointments.length) {
        throw new BadRequestException('Este horário não possui candidatos confirmados; use a remoção simples.');
      }

      const claimed = await slotRepo.update(
        { id: oldSlot.id, instanceId, version: oldSlot.version },
        {
          status: AppointmentSlotStatus.REMOVED,
          bookedCount: 0,
          heldByRunId: null,
          holdUntil: null,
        },
      );
      if (!claimed.affected)
        throw new ConflictException('Este horário já foi alterado. Atualize a agenda e tente novamente.');

      const capacity = dto.capacity ?? Math.max(oldSlot.capacity, activeAppointments.length);
      if (capacity < activeAppointments.length)
        throw new BadRequestException(
          `O novo limite deve comportar os ${activeAppointments.length} candidatos confirmados.`,
        );

      const replacement = slotRepo.create({
        instanceId,
        startsAt,
        label: dto.label?.trim() || oldSlot.label,
        locationId: dto.locationId?.trim() || oldSlot.locationId,
        location: dto.location?.trim() || oldSlot.location,
        address: dto.address?.trim() || oldSlot.address,
        instruction: dto.instruction?.trim() || oldSlot.instruction,
        responsible: dto.responsible?.trim() || oldSlot.responsible,
        mapsUrl: dto.mapsUrl?.trim() || oldSlot.mapsUrl,
        interviewPhase: dto.interviewPhase ?? oldSlot.interviewPhase ?? WorkflowInterviewPhase.SIMPLE,
        capacity,
        bookedCount: activeAppointments.length,
        status:
          activeAppointments.length >= capacity ? AppointmentSlotStatus.CONFIRMED : AppointmentSlotStatus.AVAILABLE,
      });
      await slotRepo.save(replacement);

      const replacementAppointments = activeAppointments.map(appointment =>
        appointmentRepo.create({
          slotId: replacement.id,
          instanceId,
          contactId: appointment.contactId,
          recordId: appointment.recordId,
          status: AppointmentStatus.CONFIRMED,
          cancelledAt: null,
          reminderSentAt: null,
        }),
      );
      for (const appointment of activeAppointments) {
        appointment.status = AppointmentStatus.CANCELLED;
        appointment.cancelledAt = new Date();
      }
      await appointmentRepo.save(activeAppointments);
      const savedReplacementAppointments = await appointmentRepo.save(replacementAppointments);
      for (const appointment of savedReplacementAppointments) {
        await this.syncRecruitmentApplication(
          manager,
          appointment,
          this.recruitmentStatusForAppointment(appointment, replacement),
          null,
          'APPOINTMENT_RESCHEDULED',
          {
            previousAppointmentStartsAt: oldSlot.startsAt.toISOString(),
            appointmentStartsAt: replacement.startsAt.toISOString(),
            previousLocation: oldSlot.location,
            location: replacement.location,
          },
        );
      }

      const contacts = [...new Set(activeAppointments.map(item => item.contactId))];
      const affectedRecords = contacts.length
        ? await recordRepo.find({ where: { instanceId, contactId: In(contacts) } })
        : [];
      for (const record of affectedRecords) {
        let changed = false;
        const nextData = Object.fromEntries(
          Object.entries(record.data).map(([key, value]) => {
            if (value !== oldSlot.id) return [key, value];
            changed = true;
            return [key, replacement.id];
          }),
        );
        if (changed) {
          const previousVersion = record.currentVersion;
          const nextVersion = previousVersion + 1;
          const claimedRecord = await recordRepo.update(
            { id: record.id, currentVersion: previousVersion },
            { data: nextData as never, currentVersion: nextVersion },
          );
          if (!claimedRecord.affected)
            throw new ConflictException('O cadastro foi alterado durante o reagendamento. Tente novamente.');
          await manager.getRepository(WorkflowRecordVersion).insert({
            recordId: record.id,
            versionNumber: nextVersion,
            data: nextData as never,
            source: 'APPOINTMENT_RESCHEDULED',
            actorId: null,
          });
        }
      }
      const activeRuns = await manager.getRepository(WorkflowRun).find({ where: { instanceId } });
      for (const run of activeRuns) {
        let changed = false;
        const nextDraft = Object.fromEntries(
          Object.entries(run.draft).map(([key, value]) => {
            if (value !== oldSlot.id) return [key, value];
            changed = true;
            return [key, replacement.id];
          }),
        );
        if (changed) await manager.getRepository(WorkflowRun).update(run.id, { draft: nextDraft as never });
      }

      const department = await manager.getRepository(WorkflowDepartment).findOneByOrFail({ id: instance.departmentId });
      const timezone = department.timezone || 'America/Sao_Paulo';
      let notified = 0;
      for (const appointment of activeAppointments) {
        if (
          await this.enqueueAppointmentReschedule(
            manager,
            sessionId,
            instance,
            appointment,
            oldSlot,
            replacement,
            timezone,
          )
        )
          notified += 1;
      }
      return { slot: replacement, movedAppointments: activeAppointments.length, notified };
    });
  }

  async blockSlot(sessionId: string, instanceId: string, slotId: string): Promise<WorkflowAppointmentSlot> {
    await this.requireInstance(sessionId, instanceId);
    const slot = await this.slots.findOne({ where: { id: slotId, instanceId } });
    if (!slot) throw new NotFoundException('Horário não encontrado.');
    if (
      slot.bookedCount > 0 ||
      (await this.appointments.exists({ where: { slotId, status: AppointmentStatus.CONFIRMED } }))
    )
      throw new ConflictException('O horário já possui agendamento.');
    slot.status = AppointmentSlotStatus.BLOCKED;
    return this.slots.save(slot);
  }

  async listAppointments(
    sessionId: string,
    instanceId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowAppointment[]> {
    await this.requireInstance(sessionId, instanceId);
    const rows = await this.appointments.find({
      where: { instanceId },
      relations: { slot: true, record: true },
      order: { createdAt: 'DESC' },
    });
    return rows.filter(row => this.isChatAllowed(row.contactId, allowedChats, row.record?.phone));
  }

  async listRecruitmentApplications(
    sessionId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowRecruitmentApplication[]> {
    const department = await this.getDepartment(sessionId);
    const flows = await this.instances.find({ where: { departmentId: department.id } });
    if (!flows.length) return [];
    const instanceIds = flows.map(flow => flow.id);

    // Compatibility repair for appointments created before the recruitment pipeline existed.
    await this.dataSource.transaction(async manager => {
      const appointments = await manager.getRepository(WorkflowAppointment).find({
        where: {
          instanceId: In(instanceIds),
          status: In([AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED]),
        },
        relations: { record: true, slot: true },
        order: { updatedAt: 'ASC' },
      });
      const latestAppointments = new Map<string, WorkflowAppointment>();
      for (const appointment of appointments) {
        const key = `${appointment.instanceId}\0${appointment.contactId}`;
        const current = latestAppointments.get(key);
        // A currently confirmed interview is always the active cycle. Otherwise keep the newest completed one.
        if (
          !current ||
          appointment.status === AppointmentStatus.CONFIRMED ||
          current.status !== AppointmentStatus.CONFIRMED
        )
          latestAppointments.set(key, appointment);
      }
      for (const appointment of latestAppointments.values()) {
        await this.syncRecruitmentApplication(
          manager,
          appointment,
          this.recruitmentStatusForAppointment(appointment, appointment.slot),
          null,
          'APPOINTMENT_IMPORTED',
          {
            appointmentStartsAt: appointment.slot?.startsAt?.toISOString(),
            location: appointment.slot?.location,
          },
          appointment.createdAt,
        );
      }
    });

    const rows = await this.recruitmentApplications.find({
      where: { instanceId: In(instanceIds) },
      relations: { instance: true, record: true, appointment: { slot: true } },
      order: { updatedAt: 'DESC' },
    });
    return rows.filter(row => this.isChatAllowed(row.contactId, allowedChats, row.record?.phone));
  }

  async listRecruitmentEvents(
    sessionId: string,
    applicationId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowRecruitmentEvent[]> {
    const application = await this.requireRecruitmentApplication(sessionId, applicationId, allowedChats);
    return this.recruitmentEvents.find({
      where: { applicationId: application.id },
      order: { createdAt: 'DESC' },
    });
  }

  async listTalentPoolEntries(
    sessionId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowTalentPoolEntry[]> {
    const department = await this.getDepartment(sessionId);
    const flows = await this.instances.find({ where: { departmentId: department.id } });
    if (!flows.length) return [];
    const instanceIds = flows.map(flow => flow.id);
    await this.dataSource.transaction(async manager => {
      const recordRepo = manager.getRepository(WorkflowRecord);
      const entryRepo = manager.getRepository(WorkflowTalentPoolEntry);
      const eventRepo = manager.getRepository(WorkflowTalentPoolEvent);
      const records = await recordRepo.find({ where: { instanceId: In(instanceIds) } });
      const definitionIds = [
        ...new Set(
          records
            .map(record => record.definitionVersionId)
            .concat(flows.map(flow => flow.currentVersionId))
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      const definitions = definitionIds.length
        ? await manager.getRepository(WorkflowDefinitionVersion).find({ where: { id: In(definitionIds) } })
        : [];
      const definitionsById = new Map(definitions.map(definition => [definition.id, definition]));
      const flowById = new Map(flows.map(flow => [flow.id, flow]));
      const existing = await entryRepo.find({ where: { instanceId: In(instanceIds) } });
      const entriesByRecord = new Map(existing.map(entry => [entry.recordId, entry]));
      const applications = await manager
        .getRepository(WorkflowRecruitmentApplication)
        .find({ where: { instanceId: In(instanceIds) } });
      const applicationRecordIds = new Set(
        applications.map(application => application.recordId).filter((value): value is string => Boolean(value)),
      );

      for (const record of records) {
        const flow = flowById.get(record.instanceId);
        const currentDefinition = definitionsById.get(flow?.currentVersionId ?? '');
        const recordDefinition = definitionsById.get(record.definitionVersionId ?? '');
        const definition = currentDefinition?.fields.some(field => field.talentPoolOption)
          ? currentDefinition
          : recordDefinition;
        if (!definition || !this.recordSelectsTalentPool(record, definition)) continue;
        let entry = entriesByRecord.get(record.id);
        if (!entry) {
          entry = await entryRepo.save(
            entryRepo.create({
              instanceId: record.instanceId,
              recordId: record.id,
              contactId: record.contactId,
              status: applicationRecordIds.has(record.id)
                ? WorkflowTalentPoolStatus.CONVERTED
                : WorkflowTalentPoolStatus.AVAILABLE,
              owner: null,
              convertedAt: applicationRecordIds.has(record.id) ? new Date() : null,
            }),
          );
          entriesByRecord.set(record.id, entry);
          await eventRepo.save(
            eventRepo.create({
              entryId: entry.id,
              type: applicationRecordIds.has(record.id) ? 'IMPORTED_AS_CANDIDATE' : 'TALENT_POOL_REGISTERED',
              fromStatus: null,
              toStatus: entry.status,
              actorId: null,
              note: null,
            }),
          );
        } else if (applicationRecordIds.has(record.id) && entry.status !== WorkflowTalentPoolStatus.CONVERTED) {
          await this.markTalentPoolConverted(
            manager,
            record.id,
            null,
            'Candidatura já vinculada durante a sincronização.',
          );
        }
      }
    });

    const rows = await this.dataSource.getRepository(WorkflowTalentPoolEntry).find({
      where: { instanceId: In(instanceIds) },
      relations: { instance: true, record: true },
      order: { updatedAt: 'DESC' },
    });
    return rows.filter(
      row =>
        row.status !== WorkflowTalentPoolStatus.CONVERTED &&
        this.isChatAllowed(row.contactId, allowedChats, row.record?.phone),
    );
  }

  async listTalentPoolEvents(
    sessionId: string,
    entryId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowTalentPoolEvent[]> {
    const entry = await this.requireTalentPoolEntry(sessionId, entryId, allowedChats);
    return this.dataSource.getRepository(WorkflowTalentPoolEvent).find({
      where: { entryId: entry.id },
      order: { createdAt: 'DESC' },
    });
  }

  async updateTalentPoolEntry(
    sessionId: string,
    entryId: string,
    dto: UpdateTalentPoolEntryDto,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowTalentPoolEntry> {
    await this.requireTalentPoolEntry(sessionId, entryId, allowedChats);
    const manuallyAllowed = new Set([
      WorkflowTalentPoolStatus.AVAILABLE,
      WorkflowTalentPoolStatus.CONTACTED,
      WorkflowTalentPoolStatus.WAITING,
      WorkflowTalentPoolStatus.UNAVAILABLE,
    ]);
    if (dto.status && !manuallyAllowed.has(dto.status))
      throw new BadRequestException('A conversão em candidato acontece automaticamente ao marcar uma entrevista.');
    await this.dataSource.transaction(async manager => {
      const entryRepo = manager.getRepository(WorkflowTalentPoolEntry);
      const eventRepo = manager.getRepository(WorkflowTalentPoolEvent);
      const entry = await entryRepo.findOneByOrFail({ id: entryId });
      if (entry.version !== dto.expectedVersion)
        throw new ConflictException('O cadastro foi alterado por outro operador. Atualize a lista e tente novamente.');
      if (entry.status === WorkflowTalentPoolStatus.CONVERTED)
        throw new ConflictException('Este cadastro já foi convertido em candidato.');
      const previousStatus = entry.status;
      if (dto.status) entry.status = dto.status;
      if (dto.owner !== undefined) entry.owner = dto.owner?.trim() || null;
      const changed = previousStatus !== entry.status || dto.owner !== undefined;
      if (changed) {
        const result = await entryRepo.update(
          { id: entry.id, version: dto.expectedVersion },
          { status: entry.status, owner: entry.owner, version: dto.expectedVersion + 1 },
        );
        if (result.affected !== 1)
          throw new ConflictException(
            'O cadastro foi alterado por outro operador. Atualize a lista e tente novamente.',
          );
        entry.version = dto.expectedVersion + 1;
      }
      if (changed || dto.note?.trim())
        await eventRepo.save(
          eventRepo.create({
            entryId: entry.id,
            type:
              previousStatus !== entry.status ? 'STATUS_CHANGED' : dto.note?.trim() ? 'NOTE_ADDED' : 'DETAILS_UPDATED',
            fromStatus: previousStatus !== entry.status ? previousStatus : null,
            toStatus: previousStatus !== entry.status ? entry.status : null,
            actorId,
            note: dto.note?.trim() || null,
          }),
        );
    });
    return this.dataSource.getRepository(WorkflowTalentPoolEntry).findOneOrFail({
      where: { id: entryId },
      relations: { instance: true, record: true },
    });
  }

  private async requireTalentPoolEntry(
    sessionId: string,
    entryId: string,
    allowedChats: string[] | null,
  ): Promise<WorkflowTalentPoolEntry> {
    const entry = await this.dataSource.getRepository(WorkflowTalentPoolEntry).findOne({
      where: { id: entryId },
      relations: { instance: { department: true }, record: true },
    });
    if (
      !entry ||
      entry.instance.department.sessionId !== sessionId ||
      !this.isChatAllowed(entry.contactId, allowedChats, entry.record?.phone)
    )
      throw new NotFoundException('Cadastro do Banco de Talentos não encontrado.');
    return entry;
  }

  private recordSelectsTalentPool(record: WorkflowRecord, definition: WorkflowDefinitionVersion): boolean {
    return definition.fields.some(field => {
      if (!field.talentPoolOption) return false;
      const value = record.data[this.answerKey(field)];
      return Array.isArray(value) ? value.includes(field.talentPoolOption) : value === field.talentPoolOption;
    });
  }

  async updateRecruitmentApplication(
    sessionId: string,
    applicationId: string,
    dto: UpdateRecruitmentApplicationDto,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowRecruitmentApplication> {
    await this.requireRecruitmentApplication(sessionId, applicationId, allowedChats);
    await this.dataSource.transaction(async manager => {
      const applicationRepo = manager.getRepository(WorkflowRecruitmentApplication);
      const eventRepo = manager.getRepository(WorkflowRecruitmentEvent);
      const application = await applicationRepo.findOne({
        where: { id: applicationId },
        relations: { appointment: { slot: true } },
      });
      if (!application) throw new NotFoundException('Candidatura não encontrada.');
      if (application.version !== dto.expectedVersion)
        throw new ConflictException(
          'A candidatura foi alterada por outro operador. Atualize a lista e tente novamente.',
        );

      const previousStatus = application.status;
      if (dto.status && dto.status !== previousStatus) {
        this.assertRecruitmentTransition(previousStatus, dto.status);
        const requiredPhase =
          dto.status === WorkflowRecruitmentStatus.APPROVED
            ? WorkflowInterviewPhase.FOCUSED
            : dto.status === WorkflowRecruitmentStatus.DOCUMENTATION
              ? WorkflowInterviewPhase.HIRING
              : null;
        if (
          requiredPhase &&
          (application.appointment?.status !== AppointmentStatus.CONFIRMED ||
            application.appointment.slot?.interviewPhase !== requiredPhase)
        )
          throw new ConflictException('Escolha uma nova data de entrevista da próxima fase antes de avançar.');
        application.status = dto.status;
        if (
          [
            WorkflowRecruitmentStatus.EVALUATION,
            WorkflowRecruitmentStatus.SECOND_EVALUATION,
            WorkflowRecruitmentStatus.NO_SHOW,
          ].includes(dto.status) &&
          application.appointment?.status === AppointmentStatus.CONFIRMED
        ) {
          await manager
            .getRepository(WorkflowAppointment)
            .update(
              { id: application.appointment.id, status: AppointmentStatus.CONFIRMED },
              { status: AppointmentStatus.COMPLETED },
            );
        }
      }
      if (dto.owner !== undefined) application.owner = dto.owner?.trim() || null;
      if (dto.rating !== undefined) application.rating = dto.rating && dto.rating > 0 ? dto.rating : null;
      if (dto.nextActionAt !== undefined)
        application.nextActionAt = dto.nextActionAt ? new Date(dto.nextActionAt) : null;

      const changed =
        application.status !== previousStatus ||
        dto.owner !== undefined ||
        dto.rating !== undefined ||
        dto.nextActionAt !== undefined;
      if (changed) {
        const result = await applicationRepo.update(
          { id: application.id, version: dto.expectedVersion },
          {
            status: application.status,
            owner: application.owner,
            rating: application.rating,
            nextActionAt: application.nextActionAt,
            version: dto.expectedVersion + 1,
          },
        );
        if (result.affected !== 1)
          throw new ConflictException(
            'A candidatura foi alterada por outro operador. Atualize a lista e tente novamente.',
          );
        application.version = dto.expectedVersion + 1;
      }
      if (changed || dto.note?.trim()) {
        await eventRepo.save(
          eventRepo.create({
            applicationId: application.id,
            type:
              application.status !== previousStatus
                ? 'STATUS_CHANGED'
                : dto.note?.trim()
                  ? 'NOTE_ADDED'
                  : 'DETAILS_UPDATED',
            fromStatus: application.status !== previousStatus ? previousStatus : null,
            toStatus: application.status !== previousStatus ? application.status : null,
            actorId,
            note: dto.note?.trim() || null,
            metadata: {},
          }),
        );
      }
    });
    return this.recruitmentApplications.findOneOrFail({
      where: { id: applicationId },
      relations: { instance: true, record: true, appointment: { slot: true } },
    });
  }

  private async requireRecruitmentApplication(
    sessionId: string,
    applicationId: string,
    allowedChats: string[] | null,
  ): Promise<WorkflowRecruitmentApplication> {
    const application = await this.recruitmentApplications.findOne({
      where: { id: applicationId },
      relations: { instance: { department: true }, record: true },
    });
    if (
      !application ||
      application.instance.department.sessionId !== sessionId ||
      !this.isChatAllowed(application.contactId, allowedChats, application.record?.phone)
    )
      throw new NotFoundException('Candidatura não encontrada.');
    return application;
  }

  private assertRecruitmentTransition(from: WorkflowRecruitmentStatus, to: WorkflowRecruitmentStatus): void {
    const allowed: Record<WorkflowRecruitmentStatus, WorkflowRecruitmentStatus[]> = {
      [WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED]: [
        WorkflowRecruitmentStatus.EVALUATION,
        WorkflowRecruitmentStatus.NO_SHOW,
        WorkflowRecruitmentStatus.CANCELLED,
      ],
      [WorkflowRecruitmentStatus.EVALUATION]: [
        WorkflowRecruitmentStatus.APPROVED,
        WorkflowRecruitmentStatus.REJECTED,
        WorkflowRecruitmentStatus.WITHDRAWN,
      ],
      [WorkflowRecruitmentStatus.APPROVED]: [
        WorkflowRecruitmentStatus.SECOND_EVALUATION,
        WorkflowRecruitmentStatus.NO_SHOW,
        WorkflowRecruitmentStatus.REJECTED,
        WorkflowRecruitmentStatus.WITHDRAWN,
      ],
      [WorkflowRecruitmentStatus.SECOND_EVALUATION]: [
        WorkflowRecruitmentStatus.DOCUMENTATION,
        WorkflowRecruitmentStatus.REJECTED,
        WorkflowRecruitmentStatus.WITHDRAWN,
        WorkflowRecruitmentStatus.APPROVED,
      ],
      [WorkflowRecruitmentStatus.DOCUMENTATION]: [
        WorkflowRecruitmentStatus.HIRED,
        WorkflowRecruitmentStatus.REJECTED,
        WorkflowRecruitmentStatus.WITHDRAWN,
        WorkflowRecruitmentStatus.APPROVED,
      ],
      [WorkflowRecruitmentStatus.HIRED]: [WorkflowRecruitmentStatus.WITHDRAWN],
      [WorkflowRecruitmentStatus.REJECTED]: [WorkflowRecruitmentStatus.EVALUATION],
      [WorkflowRecruitmentStatus.NO_SHOW]: [WorkflowRecruitmentStatus.EVALUATION],
      [WorkflowRecruitmentStatus.WITHDRAWN]: [WorkflowRecruitmentStatus.EVALUATION],
      [WorkflowRecruitmentStatus.CANCELLED]: [],
    };
    if (!allowed[from].includes(to)) throw new ConflictException('Esta mudança de etapa não é permitida.');
  }

  private recruitmentStatusForAppointment(
    appointment: Pick<WorkflowAppointment, 'status'>,
    slot?: Pick<WorkflowAppointmentSlot, 'interviewPhase'> | null,
  ): WorkflowRecruitmentStatus {
    if (slot?.interviewPhase === WorkflowInterviewPhase.FOCUSED)
      return appointment.status === AppointmentStatus.COMPLETED
        ? WorkflowRecruitmentStatus.SECOND_EVALUATION
        : WorkflowRecruitmentStatus.APPROVED;
    if (slot?.interviewPhase === WorkflowInterviewPhase.HIRING) return WorkflowRecruitmentStatus.DOCUMENTATION;
    return appointment.status === AppointmentStatus.COMPLETED
      ? WorkflowRecruitmentStatus.EVALUATION
      : WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED;
  }

  private async syncRecruitmentApplication(
    manager: EntityManager,
    appointment: WorkflowAppointment,
    desiredStatus: WorkflowRecruitmentStatus,
    actorId: string | null,
    eventType: string,
    metadata: Record<string, unknown> = {},
    eventCreatedAt?: Date,
  ): Promise<WorkflowRecruitmentApplication> {
    const applicationRepo = manager.getRepository(WorkflowRecruitmentApplication);
    const eventRepo = manager.getRepository(WorkflowRecruitmentEvent);
    let application = await applicationRepo.findOneBy({
      instanceId: appointment.instanceId,
      contactId: appointment.contactId,
    });
    const previousStatus = application?.status ?? null;
    const previousAppointmentId = application?.appointmentId ?? null;
    if (!application) {
      application = applicationRepo.create({
        instanceId: appointment.instanceId,
        contactId: appointment.contactId,
        recordId: appointment.recordId,
        appointmentId: appointment.id,
        status: desiredStatus,
        owner: null,
        rating: null,
        nextActionAt: null,
      });
    } else {
      application.recordId = appointment.recordId ?? application.recordId;
      application.appointmentId = appointment.id;
      const differentInterview = previousAppointmentId !== appointment.id;
      const shouldReopenScheduled =
        desiredStatus === WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED &&
        (differentInterview || application.status === WorkflowRecruitmentStatus.CANCELLED);
      const shouldAdvanceCompleted =
        desiredStatus === WorkflowRecruitmentStatus.EVALUATION &&
        (application.status === WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED || differentInterview);
      const shouldAdvanceFocusedCompleted =
        desiredStatus === WorkflowRecruitmentStatus.SECOND_EVALUATION &&
        application.status === WorkflowRecruitmentStatus.APPROVED;
      const shouldApplyCancellation =
        desiredStatus === WorkflowRecruitmentStatus.CANCELLED &&
        [
          WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED,
          WorkflowRecruitmentStatus.EVALUATION,
          WorkflowRecruitmentStatus.APPROVED,
          WorkflowRecruitmentStatus.SECOND_EVALUATION,
          WorkflowRecruitmentStatus.DOCUMENTATION,
        ].includes(application.status);
      const shouldAdoptInterviewPhase =
        (differentInterview || eventType === 'INTERVIEW_PHASE_CHANGED') &&
        [
          WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED,
          WorkflowRecruitmentStatus.EVALUATION,
          WorkflowRecruitmentStatus.APPROVED,
          WorkflowRecruitmentStatus.SECOND_EVALUATION,
          WorkflowRecruitmentStatus.DOCUMENTATION,
          WorkflowRecruitmentStatus.CANCELLED,
        ].includes(application.status) &&
        [
          WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED,
          WorkflowRecruitmentStatus.EVALUATION,
          WorkflowRecruitmentStatus.APPROVED,
          WorkflowRecruitmentStatus.SECOND_EVALUATION,
          WorkflowRecruitmentStatus.DOCUMENTATION,
        ].includes(desiredStatus);
      if (
        shouldReopenScheduled ||
        shouldAdvanceCompleted ||
        shouldAdvanceFocusedCompleted ||
        shouldApplyCancellation ||
        shouldAdoptInterviewPhase
      )
        application.status = desiredStatus;
    }
    application = await applicationRepo.save(application);
    if (previousStatus !== application.status || previousAppointmentId !== application.appointmentId) {
      await eventRepo.save(
        eventRepo.create({
          applicationId: application.id,
          type: eventType,
          fromStatus: previousStatus,
          toStatus: application.status,
          actorId,
          note: null,
          metadata,
          ...(eventCreatedAt ? { createdAt: eventCreatedAt } : {}),
        }),
      );
    } else if (eventType === 'APPOINTMENT_IMPORTED' && Object.keys(metadata).length) {
      const importedEvent = await eventRepo.findOne({
        where: { applicationId: application.id, type: 'APPOINTMENT_IMPORTED' },
        order: { createdAt: 'DESC' },
      });
      if (importedEvent && !Object.keys(importedEvent.metadata ?? {}).length) {
        importedEvent.metadata = metadata;
        if (eventCreatedAt) importedEvent.createdAt = eventCreatedAt;
        await eventRepo.save(importedEvent);
      }
    }
    if (application.recordId)
      await this.markTalentPoolConverted(
        manager,
        application.recordId,
        actorId,
        'Entrevista marcada; cadastro transferido para o processo seletivo.',
      );
    return application;
  }

  private async markTalentPoolConverted(
    manager: EntityManager,
    recordId: string,
    actorId: string | null,
    note: string,
  ): Promise<void> {
    const entryRepo = manager.getRepository(WorkflowTalentPoolEntry);
    const eventRepo = manager.getRepository(WorkflowTalentPoolEvent);
    const entry = await entryRepo.findOneBy({ recordId });
    if (!entry || entry.status === WorkflowTalentPoolStatus.CONVERTED) return;
    const previousStatus = entry.status;
    entry.status = WorkflowTalentPoolStatus.CONVERTED;
    entry.convertedAt = new Date();
    await entryRepo.save(entry);
    await eventRepo.save(
      eventRepo.create({
        entryId: entry.id,
        type: 'CONVERTED_TO_CANDIDATE',
        fromStatus: previousStatus,
        toStatus: WorkflowTalentPoolStatus.CONVERTED,
        actorId,
        note,
      }),
    );
  }

  private async syncTalentPoolRegistration(
    manager: EntityManager,
    record: WorkflowRecord,
    definition: WorkflowDefinitionVersion,
    actorId: string | null,
  ): Promise<void> {
    const entryRepo = manager.getRepository(WorkflowTalentPoolEntry);
    const existing = await entryRepo.findOneBy({ recordId: record.id });
    if (!this.recordSelectsTalentPool(record, definition)) {
      if (existing && existing.status !== WorkflowTalentPoolStatus.CONVERTED) {
        const previousStatus = existing.status;
        existing.status = WorkflowTalentPoolStatus.CONVERTED;
        existing.convertedAt = new Date();
        await entryRepo.save(existing);
        await manager.getRepository(WorkflowTalentPoolEvent).save({
          entryId: existing.id,
          type: 'REMOVED_FROM_TALENT_POOL',
          fromStatus: previousStatus,
          toStatus: WorkflowTalentPoolStatus.CONVERTED,
          actorId,
          note: 'A opção de cadastro foi alterada para uma vaga atual.',
        });
      }
      return;
    }
    if (existing) return;
    const entry = await entryRepo.save(
      entryRepo.create({
        instanceId: record.instanceId,
        recordId: record.id,
        contactId: record.contactId,
        status: WorkflowTalentPoolStatus.AVAILABLE,
        owner: null,
        convertedAt: null,
      }),
    );
    await manager.getRepository(WorkflowTalentPoolEvent).save({
      entryId: entry.id,
      type: 'TALENT_POOL_REGISTERED',
      fromStatus: null,
      toStatus: WorkflowTalentPoolStatus.AVAILABLE,
      actorId,
      note: null,
    });
  }

  /**
   * Creates or updates a WorkflowRecord from an external source (e.g. a plugin).
   * Uses the same record creation pattern as the internal conversation engine:
   * - Finds or creates a WorkflowIdentity + WorkflowRecord for the contact.
   * - Saves the provided answers into a new WorkflowRecordVersion.
   * - Returns a minimal summary {recordId, versionNumber, contactId}.
   *
   * This is intentionally simpler than the full conversation flow:
   * it does not send WhatsApp messages, manage runs, or handle appointments.
   */
  async ingestExternalRecord(
    sessionId: string,
    dto: import('./dto/workflow-hub.dto').IngestExternalRecordDto,
    apiKeyId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<{ recordId: string; versionNumber: number; contactId: string }> {
    const department = await this.departments.findOne({ where: { sessionId, enabled: true } });
    if (!department) throw new NotFoundException('Departamento não encontrado para esta sessão');

    const instance = await this.instances.findOne({
      where: { id: dto.instanceId, departmentId: department.id, status: WorkflowInstanceStatus.PUBLISHED },
      relations: { currentVersion: true },
    });
    if (!instance || !instance.currentVersion) {
      throw new NotFoundException('Instância publicada não encontrada ou sem versão ativa');
    }

    const definitionVersionId = instance.currentVersion.id;
    const contactId = dto.contactId.includes('@') ? dto.contactId : `${dto.contactId.replace(/\D/g, '')}@c.us`;
    const phone = contactId.split('@')[0].replace(/\D/g, '') || null;
    if (!this.isChatAllowed(contactId, allowedChats, phone))
      throw new NotFoundException('Contato não permitido para esta chave.');
    const payloadHash = createHash('sha256')
      .update(
        this.stableJson({
          definitionVersionId,
          context: { instanceId: instance.id, contactId, source: dto.source ?? 'PLUGIN' },
          answers: dto.answers,
        }),
      )
      .digest('hex');

    return this.runIngestSerialized(
      [`event:${instance.id}:${dto.eventKey}`, `contact:${instance.id}:${contactId}`],
      () =>
        this.withIngestTransactionRetry(async em => {
          await this.acquireIngestDatabaseLocks(em, instance.id, dto.eventKey, contactId);
          const currentInstance = await em.getRepository(WorkflowInstance).findOne({
            where: { id: instance.id, status: WorkflowInstanceStatus.PUBLISHED },
            relations: { currentVersion: true },
          });
          if (!currentInstance?.currentVersion || currentInstance.currentVersion.id !== definitionVersionId)
            throw new ConflictException('A versão publicada mudou; reenvie o evento com o contexto atualizado');
          const version = currentInstance.currentVersion;
          const eventRepo = em.getRepository(WorkflowRecordIngestEvent);
          let ingestEvent = await eventRepo.findOneBy({ instanceId: instance.id, eventKey: dto.eventKey });
          if (ingestEvent) {
            if (ingestEvent.payloadHash !== payloadHash)
              throw new ConflictException('A chave do evento já foi usada com outro conteúdo ou versão');
            if (ingestEvent.recordId && ingestEvent.versionNumber)
              return { recordId: ingestEvent.recordId, versionNumber: ingestEvent.versionNumber, contactId };
            throw new ConflictException('O evento ainda está sendo processado');
          }
          try {
            ingestEvent = await eventRepo.save(
              eventRepo.create({
                instanceId: instance.id,
                eventKey: dto.eventKey,
                payloadHash,
                recordId: null,
                versionNumber: null,
                contactId,
              }),
            );
          } catch (error) {
            if (!this.isIngestEventConstraintError(error)) throw error;
            const concurrent = await eventRepo.findOneBy({ instanceId: instance.id, eventKey: dto.eventKey });
            if (concurrent?.payloadHash !== payloadHash)
              throw new ConflictException('A chave do evento já foi usada com outro conteúdo ou versão');
            if (concurrent?.recordId && concurrent.versionNumber)
              return { recordId: concurrent.recordId, versionNumber: concurrent.versionNumber, contactId };
            throw error;
          }

          const contactRepo = em.getRepository(WorkflowIdentityContact);
          const recordRepo = em.getRepository(WorkflowRecord);
          const historyRepo = em.getRepository(WorkflowRecordVersion);
          let contact = await contactRepo.findOne({ where: { departmentId: department.id, contactId } });
          if (!contact) {
            const identity = await em.getRepository(WorkflowIdentity).save({ departmentId: department.id, cpf: null });
            contact = await contactRepo.save({
              departmentId: department.id,
              identityId: identity.id,
              contactId,
              phone,
              verifiedAt: new Date(),
            });
          } else if (phone && !contact.phone) {
            try {
              await contactRepo.update(contact.id, { phone, verifiedAt: new Date() });
              contact.phone = phone;
            } catch (error) {
              if (!this.isUniqueConstraintError(error)) throw error;
            }
          }

          let record = await recordRepo.findOne({ where: { instanceId: instance.id, contactId } });
          const nextVersion = (record?.currentVersion ?? 0) + 1;
          let existingData: Record<string, unknown> = {};
          if (record) {
            const previousDefinition = record.definitionVersionId
              ? await em.getRepository(WorkflowDefinitionVersion).findOneBy({ id: record.definitionVersionId })
              : null;
            existingData = reconcileWorkflowRecordData(
              record.data,
              previousDefinition?.fields ?? [],
              version.fields,
            ).data;
          }
          const sanitizedData = this.validateExternalRecordData(version, existingData, dto.answers);
          const validUntil = new Date();
          validUntil.setMonth(validUntil.getMonth() + currentInstance.validityMonths);
          if (!record) {
            record = await recordRepo.save(
              recordRepo.create({
                instanceId: instance.id,
                identityId: contact.identityId,
                contactId,
                phone,
                definitionVersionId,
                status: WorkflowRecordStatus.VALID,
                data: sanitizedData,
                currentVersion: nextVersion,
                validUntil,
              }),
            );
          } else {
            record.data = sanitizedData;
            record.definitionVersionId = definitionVersionId;
            record.status = WorkflowRecordStatus.VALID;
            record.currentVersion = nextVersion;
            record.validUntil = validUntil;
            record.identityId = contact.identityId;
            await recordRepo.save(record);
          }
          await historyRepo.save(
            historyRepo.create({
              recordId: record.id,
              versionNumber: nextVersion,
              data: sanitizedData,
              source: dto.source ?? 'PLUGIN',
              actorId: apiKeyId,
            }),
          );
          ingestEvent.recordId = record.id;
          ingestEvent.versionNumber = nextVersion;
          await eventRepo.save(ingestEvent);
          this.logger.log('Registro externo ingerido', {
            action: 'external_record_ingested',
            sessionId,
            instanceId: instance.id,
            recordId: record.id,
            versionNumber: nextVersion,
            source: dto.source ?? 'plugin',
          });
          return { recordId: record.id, versionNumber: nextVersion, contactId };
        }),
    );
  }

  async listRecords(
    sessionId: string,
    search = '',
    allowedChats: string[] | null = null,
  ): Promise<
    Array<
      WorkflowRecord & {
        instanceName: string;
        linkedContacts: Array<
          Pick<WorkflowIdentityContact, 'id' | 'contactId' | 'phone' | 'verifiedAt'> & { isPrimary: boolean }
        >;
      }
    >
  > {
    const department = await this.getDepartment(sessionId);
    const flows = await this.instances.find({ where: { departmentId: department.id } });
    if (!flows.length) return [];
    const rows = await this.records.find({
      where: { instanceId: In(flows.map(flow => flow.id)) },
      order: { updatedAt: 'DESC' },
    });
    await this.reconcileCancelledAppointmentAnswers(sessionId, rows);
    await this.resolveMissingRecordPhones(sessionId, rows);
    const identityIds = [
      ...new Set(rows.map(row => row.identityId).filter((value): value is string => Boolean(value))),
    ];
    const identityContacts = identityIds.length
      ? await this.dataSource.getRepository(WorkflowIdentityContact).find({ where: { identityId: In(identityIds) } })
      : [];
    const contactsByIdentity = new Map<string, WorkflowIdentityContact[]>();
    for (const contact of identityContacts)
      contactsByIdentity.set(contact.identityId, [...(contactsByIdentity.get(contact.identityId) ?? []), contact]);
    const versionIds = new Set(
      rows
        .map(row => row.definitionVersionId)
        .concat(flows.map(flow => flow.currentVersionId))
        .filter((value): value is string => Boolean(value)),
    );
    const definitions = versionIds.size ? await this.versions.find({ where: { id: In([...versionIds]) } }) : [];
    const definitionsById = new Map(definitions.map(definition => [definition.id, definition]));
    const needle = search.trim().toLocaleLowerCase('pt-BR');
    return rows
      .filter(
        row =>
          [
            { contactId: row.contactId, phone: row.phone },
            ...(row.identityId ? (contactsByIdentity.get(row.identityId) ?? []) : []),
          ].some(contact => this.isChatAllowed(contact.contactId, allowedChats, contact.phone)) &&
          (!needle ||
            `${row.contactId} ${row.phone ?? ''} ${(row.identityId
              ? (contactsByIdentity.get(row.identityId) ?? [])
              : []
            )
              .map(contact => `${contact.contactId} ${contact.phone ?? ''}`)
              .join(' ')} ${JSON.stringify(row.data)}`
              .toLocaleLowerCase('pt-BR')
              .includes(needle)),
      )
      .map(row => {
        const flow = flows.find(item => item.id === row.instanceId);
        const previous = row.definitionVersionId ? definitionsById.get(row.definitionVersionId) : null;
        const current = flow?.currentVersionId ? definitionsById.get(flow.currentVersionId) : null;
        const data = current
          ? reconcileWorkflowRecordData(row.data, previous?.fields ?? [], current.fields).data
          : row.data;
        return Object.assign(row, {
          data,
          instanceName: flow?.name ?? '',
          linkedContacts: row.identityId
            ? (contactsByIdentity.get(row.identityId) ?? []).map(contact => ({
                id: contact.id,
                contactId: contact.contactId,
                phone: contact.phone,
                verifiedAt: contact.verifiedAt,
                isPrimary: contact.contactId === row.contactId,
              }))
            : [
                {
                  id: row.id,
                  contactId: row.contactId,
                  phone: row.phone,
                  verifiedAt: row.createdAt,
                  isPrimary: true,
                },
              ],
        });
      });
  }

  private async requireRecordContactContext(
    manager: EntityManager,
    sessionId: string,
    recordId: string,
    contactLinkId: string,
    allowedChats: string[] | null,
  ): Promise<{ record: WorkflowRecord; contact: WorkflowIdentityContact; contacts: WorkflowIdentityContact[] }> {
    const record = await manager.getRepository(WorkflowRecord).findOne({
      where: { id: recordId },
      relations: { instance: { department: true } },
    });
    if (
      !record ||
      !record.identityId ||
      record.instance.department.sessionId !== sessionId ||
      !this.isChatAllowed(record.contactId, allowedChats, record.phone)
    )
      throw new NotFoundException('Candidato não encontrado.');
    const contacts = await manager.getRepository(WorkflowIdentityContact).find({
      where: { departmentId: record.instance.departmentId, identityId: record.identityId },
      order: { createdAt: 'ASC' },
    });
    const contact = contacts.find(item => item.id === contactLinkId);
    if (!contact) throw new NotFoundException('Número vinculado não encontrado.');
    return { record, contact, contacts };
  }

  async updateRecordContact(
    sessionId: string,
    recordId: string,
    contactLinkId: string,
    inputPhone: string,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<{ id: string; contactId: string; phone: string | null; verifiedAt: Date; isPrimary: boolean }> {
    const phone = this.normalizePhone(inputPhone);
    if (!phone || !/^\d{10,15}$/.test(phone))
      throw new BadRequestException('Informe um telefone internacional válido.');
    const result = await this.dataSource.transaction(async manager => {
      const { record, contact } = await this.requireRecordContactContext(
        manager,
        sessionId,
        recordId,
        contactLinkId,
        allowedChats,
      );
      const contactRepo = manager.getRepository(WorkflowIdentityContact);
      const duplicate = await contactRepo.findOneBy({ departmentId: contact.departmentId, phone });
      if (duplicate && duplicate.id !== contact.id)
        throw new ConflictException('Este telefone já está vinculado a outro usuário.');
      contact.phone = phone;
      contact.verifiedAt = new Date();
      await contactRepo.save(contact);
      if (record.contactId === contact.contactId) {
        record.phone = phone;
        await manager.getRepository(WorkflowRecord).save(record);
      }
      return { ...contact, isPrimary: record.contactId === contact.contactId };
    });
    await this.audit?.log(AuditAction.TALENT_CANDIDATE_UPDATED, {
      sessionId,
      metadata: { actorId, recordId, action: 'linked_contact_updated' },
    });
    return result;
  }

  async setPrimaryRecordContact(
    sessionId: string,
    recordId: string,
    contactLinkId: string,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowRecord> {
    const result = await this.dataSource.transaction(async manager => {
      const { record, contact } = await this.requireRecordContactContext(
        manager,
        sessionId,
        recordId,
        contactLinkId,
        allowedChats,
      );
      const conflict = await manager.getRepository(WorkflowRecord).findOneBy({
        instanceId: record.instanceId,
        contactId: contact.contactId,
      });
      if (conflict && conflict.id !== record.id)
        throw new ConflictException('Este número já possui outro cadastro neste fluxo.');
      record.contactId = contact.contactId;
      record.phone = contact.phone;
      return manager.getRepository(WorkflowRecord).save(record);
    });
    await this.audit?.log(AuditAction.TALENT_CANDIDATE_UPDATED, {
      sessionId,
      metadata: { actorId, recordId, action: 'primary_contact_changed' },
    });
    return result;
  }

  async deleteRecordContact(
    sessionId: string,
    recordId: string,
    contactLinkId: string,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<void> {
    await this.dataSource.transaction(async manager => {
      const { record, contact, contacts } = await this.requireRecordContactContext(
        manager,
        sessionId,
        recordId,
        contactLinkId,
        allowedChats,
      );
      if (contacts.length <= 1) throw new ConflictException('O último número vinculado não pode ser excluído.');
      if (record.contactId === contact.contactId)
        throw new ConflictException('Defina outro número como principal antes de excluir este vínculo.');
      await manager.getRepository(WorkflowIdentityContact).delete({ id: contact.id, identityId: contact.identityId });
    });
    await this.audit?.log(AuditAction.TALENT_CANDIDATE_UPDATED, {
      sessionId,
      metadata: { actorId, recordId, action: 'linked_contact_deleted' },
    });
  }

  async updateRecord(
    sessionId: string,
    recordId: string,
    dto: UpdateWorkflowRecordDto,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowRecord> {
    const saved = await this.dataSource.transaction(async manager => {
      const recordRepo = manager.getRepository(WorkflowRecord);
      const versionRepo = manager.getRepository(WorkflowDefinitionVersion);
      const historyRepo = manager.getRepository(WorkflowRecordVersion);
      const record = await recordRepo.findOne({
        where: { id: recordId },
        relations: { instance: { department: true } },
      });
      if (
        !record ||
        record.instance.department.sessionId !== sessionId ||
        !this.isChatAllowed(record.contactId, allowedChats, record.phone)
      )
        throw new NotFoundException('Candidato não encontrado.');
      if (record.currentVersion !== dto.expectedVersion)
        throw new ConflictException('Este cadastro foi alterado por outra pessoa. Atualize a ficha e tente novamente.');
      if (!record.instance.currentVersionId)
        throw new ConflictException('Este fluxo não possui uma versão atual para validar a correção.');

      const currentDefinition = await versionRepo.findOneByOrFail({ id: record.instance.currentVersionId });
      const previousDefinition = record.definitionVersionId
        ? await versionRepo.findOneBy({ id: record.definitionVersionId })
        : null;
      const reconciled = reconcileWorkflowRecordData(
        record.data,
        previousDefinition?.fields ?? [],
        currentDefinition.fields,
      ).data;
      const fieldsByKey = new Map<string, WorkflowFieldDefinition>();
      for (const field of currentDefinition.fields) {
        const key = this.answerKey(field);
        if (!fieldsByKey.has(key)) fieldsByKey.set(key, field);
      }
      const unknown = Object.keys(dto.data).filter(key => !fieldsByKey.has(key));
      if (unknown.length) throw new BadRequestException(`Campo de cadastro desconhecido: ${unknown[0]}.`);

      const nextData = { ...reconciled };
      let addressChanged = false;
      for (const [key, input] of Object.entries(dto.data)) {
        const field = fieldsByKey.get(key)!;
        if (field.type === 'appointment' || field.type === 'pdf')
          throw new BadRequestException(`O campo “${field.label}” deve ser alterado pelo controle específico.`);
        const normalized = this.normalizeAdministrativeRecordValue(field, input, nextData);
        if (ADDRESS_ANSWER_KEYS.has(key) && JSON.stringify(nextData[key]) !== JSON.stringify(normalized))
          addressChanged = true;
        if (normalized === undefined) delete nextData[key];
        else nextData[key] = normalized;
      }
      const editedCpf = Object.keys(dto.data).some(key => fieldsByKey.get(key)?.type === 'cpf');
      if (editedCpf) {
        const cpfValues = [
          ...new Set(
            [...fieldsByKey.entries()]
              .filter(([, field]) => field.type === 'cpf')
              .map(([key]) => (typeof nextData[key] === 'string' ? nextData[key].replace(/\D/g, '') : ''))
              .filter(value => value.length === 11),
          ),
        ];
        if (cpfValues.length > 1)
          throw new ConflictException('O cadastro possui respostas de CPF diferentes. Corrija antes de salvar.');
        const identities = manager.getRepository(WorkflowIdentity);
        const contacts = manager.getRepository(WorkflowIdentityContact);
        const nextCpf = cpfValues[0] ?? null;
        if (!record.identityId) {
          const existing = nextCpf
            ? await identities.findOneBy({ departmentId: record.instance.departmentId, cpf: nextCpf })
            : null;
          const identity =
            existing ?? (await identities.save({ departmentId: record.instance.departmentId, cpf: nextCpf }));
          record.identityId = identity.id;
          const linkedContact = await contacts.findOneBy({
            departmentId: record.instance.departmentId,
            contactId: record.contactId,
          });
          if (!linkedContact)
            await contacts.save({
              departmentId: record.instance.departmentId,
              identityId: identity.id,
              contactId: record.contactId,
              phone: this.normalizePhone(record.phone || record.contactId),
              verifiedAt: new Date(),
            });
        } else {
          const conflict = nextCpf
            ? await identities.findOneBy({ departmentId: record.instance.departmentId, cpf: nextCpf })
            : null;
          if (conflict && conflict.id !== record.identityId)
            throw new ConflictException('Este CPF já pertence a outro candidato. Os cadastros não foram duplicados.');
          await identities.update(record.identityId, { cpf: nextCpf });
        }
      }

      const nextVersion = record.currentVersion + 1;
      record.data = nextData;
      record.currentVersion = nextVersion;
      record.definitionVersionId = currentDefinition.id;
      if (addressChanged) this.prepareRecordProximity(record, record.instance.department, true);
      const claimed = await recordRepo.update(
        { id: record.id, currentVersion: dto.expectedVersion },
        {
          data: record.data as never,
          currentVersion: nextVersion,
          definitionVersionId: currentDefinition.id,
          identityId: record.identityId,
          proximityStatus: record.proximityStatus,
          proximityData: record.proximityData,
          proximityAttempts: record.proximityAttempts,
          proximityRevision: record.proximityRevision,
          proximityNextAttemptAt: record.proximityNextAttemptAt,
        },
      );
      if (!claimed.affected)
        throw new ConflictException('Este cadastro foi alterado por outra pessoa. Atualize a ficha e tente novamente.');
      await historyRepo.insert({
        recordId: record.id,
        versionNumber: nextVersion,
        data: record.data as never,
        source: 'CORRECAO_MANUAL',
        actorId,
      });
      await this.syncTalentPoolRegistration(manager, record, currentDefinition, actorId);
      return record;
    });
    if (saved.proximityStatus === WorkflowProximityStatus.PENDING)
      void this.processProximityRecord(saved.id).catch(error =>
        this.logger.warn(`Candidate proximity recalculation failed recordId=${saved.id}: ${this.errorName(error)}`),
      );
    return this.records.findOneByOrFail({ id: saved.id });
  }

  async recalculateRecordProximity(
    sessionId: string,
    recordId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowRecord> {
    const record = await this.records.findOne({
      where: { id: recordId },
      relations: { instance: { department: true } },
    });
    if (
      !record ||
      record.instance.department.sessionId !== sessionId ||
      !this.isChatAllowed(record.contactId, allowedChats, record.phone)
    )
      throw new NotFoundException('Candidato não encontrado.');
    this.prepareRecordProximity(record, record.instance.department, true);
    const saved = await this.records.save(record);
    if (saved.proximityStatus === WorkflowProximityStatus.PENDING)
      void this.processProximityRecord(saved.id, true).catch(error =>
        this.logger.warn(`Candidate proximity recalculation failed recordId=${saved.id}: ${this.errorName(error)}`),
      );
    return saved;
  }

  async testProximity(sessionId: string, address: string) {
    const startedAt = Date.now();
    const department = await this.getDepartment(sessionId);
    const destinations = this.proximityDestinations(department);
    if (!destinations.length) {
      return {
        success: false as const,
        errorCode: 'NO_GEOREFERENCED_LOCATIONS',
        message: 'Cadastre ao menos um local de entrevista com latitude e longitude.',
        destinationCount: 0,
        elapsedMs: Date.now() - startedAt,
      };
    }
    try {
      const calculation = await this.runProximityRequest(() =>
        encontrarLocaisPorProximidade(address, destinations, {
          timeoutMs: Math.max(1_000, Number.parseInt(process.env.PROXIMITY_HTTP_TIMEOUT_MS || '8000', 10) || 8_000),
          nominatimBaseUrl: process.env.NOMINATIM_BASE_URL,
          osrmBaseUrl: process.env.OSRM_BASE_URL,
          viacepBaseUrl: process.env.VIACEP_BASE_URL,
          userAgent: process.env.NOMINATIM_USER_AGENT,
          referer: process.env.BASE_URL,
        }),
      );
      this.logger.log(`Proximity diagnostic completed destinations=${destinations.length}`);
      return {
        success: true as const,
        origin: calculation.origin,
        ...(calculation.normalizedAddress ? { normalizedAddress: calculation.normalizedAddress } : {}),
        results: calculation.results,
        destinationCount: destinations.length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const errorCode = error instanceof ProximityServiceError ? error.code : 'ROUTING_UNAVAILABLE';
      const message =
        error instanceof ProximityServiceError ? error.message : 'Não foi possível concluir o diagnóstico de rotas.';
      this.logger.warn(`Proximity diagnostic failed code=${errorCode} destinations=${destinations.length}`);
      return {
        success: false as const,
        errorCode,
        message,
        destinationCount: destinations.length,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  private composeCandidateAddress(data: Record<string, unknown>): string | null {
    const read = (...keys: string[]) => {
      for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.trim() && value !== SKIPPED_VALUE) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      }
      return '';
    };
    const postalCode = read('endereco_cep', 'cep');
    const street = read('endereco_logradouro', 'logradouro', 'rua');
    const number = read('endereco_numero', 'numero');
    const complement = read('endereco_complemento', 'complemento');
    const neighborhood = read('endereco_bairro', 'bairro');
    const city = read('endereco_cidade', 'cidade');
    const state = read('endereco_estado', 'estado', 'uf');
    if (!postalCode || !street || !number || !neighborhood || !city || !state) return null;
    return [
      `${street}, ${number}`,
      complement,
      neighborhood,
      `${city}, ${state}`,
      `CEP ${postalCode.replace(/\D/g, '')}`,
      'Brasil',
    ]
      .filter(Boolean)
      .join(', ');
  }

  private recordDataWithPostalAddress(
    data: Record<string, unknown>,
    address: BrazilianPostalAddress,
  ): Record<string, unknown> {
    const next = { ...data };
    const setFirstExisting = (keys: string[], value: string) => {
      const key = keys.find(candidate => Object.prototype.hasOwnProperty.call(next, candidate));
      if (key) next[key] = value;
    };
    setFirstExisting(['endereco_cep', 'cep'], address.postalCode.replace(/\D/g, ''));
    setFirstExisting(['endereco_logradouro', 'logradouro', 'rua'], address.street);
    setFirstExisting(['endereco_numero', 'numero'], address.number.replace(/\D/g, ''));
    if (address.neighborhood) setFirstExisting(['endereco_bairro', 'bairro'], address.neighborhood);
    setFirstExisting(['endereco_cidade', 'cidade'], address.city);
    setFirstExisting(['endereco_estado', 'endereco_uf', 'estado', 'uf'], address.state);
    return next;
  }

  private proximityDestinations(department: WorkflowDepartment): ProximityDestination[] {
    return (department.schedule.locations ?? [])
      .filter(
        location =>
          Boolean(location.address?.trim()) &&
          Number.isFinite(location.latitude) &&
          Number.isFinite(location.longitude),
      )
      .map(location => ({
        id: location.id,
        name: location.name.trim(),
        address: location.address!.trim(),
        latitude: location.latitude!,
        longitude: location.longitude!,
      }));
  }

  private destinationHash(destinations: ProximityDestination[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify(
          [...destinations]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(destination => [
              destination.id,
              destination.name,
              destination.address,
              destination.latitude,
              destination.longitude,
            ]),
        ),
      )
      .digest('hex');
  }

  private prepareRecordProximity(record: WorkflowRecord, department: WorkflowDepartment, force = false): void {
    const originAddress = this.composeCandidateAddress(record.data);
    const destinations = this.proximityDestinations(department);
    const destinationHash = this.destinationHash(destinations);
    if (
      !force &&
      originAddress &&
      destinations.length &&
      record.proximityStatus === WorkflowProximityStatus.COMPLETED &&
      record.proximityData?.originAddress === originAddress &&
      record.proximityData.destinationHash === destinationHash
    )
      return;
    record.proximityRevision = (record.proximityRevision ?? 0) + 1;
    if (!originAddress || !destinations.length) {
      record.proximityStatus = WorkflowProximityStatus.MISSING_DATA;
      record.proximityData = {
        originAddress: originAddress ?? '',
        destinationHash,
        results: [],
        errorCode: !originAddress ? 'INCOMPLETE_ORIGIN' : 'NO_GEOREFERENCED_LOCATIONS',
      };
      record.proximityAttempts = 0;
      record.proximityNextAttemptAt = null;
      return;
    }
    record.proximityStatus = WorkflowProximityStatus.PENDING;
    record.proximityData = { originAddress, destinationHash, results: [] };
    record.proximityAttempts = 0;
    record.proximityNextAttemptAt = new Date();
  }

  private async refreshDepartmentProximityQueue(department: WorkflowDepartment): Promise<void> {
    const flows = await this.instances.find({ where: { departmentId: department.id }, select: { id: true } });
    if (!flows.length) return;
    const records = await this.records.find({ where: { instanceId: In(flows.map(flow => flow.id)) } });
    for (const record of records) this.prepareRecordProximity(record, department);
    if (records.length) await this.records.save(records);
  }

  private runProximityRequest<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.proximityRequestQueue.then(async () => {
      const delay = Math.max(0, this.nextNominatimRequestAt - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      this.nextNominatimRequestAt = Date.now() + 1_000;
      return operation();
    });
    this.proximityRequestQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async processProximityRecord(recordId: string, refreshOrigin = false): Promise<void> {
    const record = await this.records.findOne({
      where: { id: recordId },
      relations: { instance: { department: true } },
    });
    if (!record || !record.proximityData?.originAddress) return;
    if (
      record.proximityStatus !== WorkflowProximityStatus.PENDING &&
      record.proximityStatus !== WorkflowProximityStatus.PROCESSING
    )
      return;
    const expectedStatus = record.proximityStatus;
    const destinations = this.proximityDestinations(record.instance.department);
    if (!destinations.length) {
      this.prepareRecordProximity(record, record.instance.department, true);
      await this.records.save(record);
      return;
    }
    const revision = record.proximityRevision ?? 0;
    const claimed = await this.records.update(
      { id: record.id, proximityStatus: expectedStatus, proximityRevision: revision },
      {
        proximityStatus: WorkflowProximityStatus.PROCESSING,
        proximityNextAttemptAt: this.plusMinutes(new Date(), 2),
      },
    );
    if (!claimed.affected) return;
    const attempts = record.proximityAttempts + 1;
    try {
      const addressHash = createHash('sha256').update(record.proximityData.originAddress).digest('hex');
      const cachedOrigin = refreshOrigin ? undefined : this.proximityGeocodeCache.get(addressHash);
      const calculate = () =>
        encontrarLocaisPorProximidade(record.proximityData!.originAddress, destinations, {
          timeoutMs: Math.max(1_000, Number.parseInt(process.env.PROXIMITY_HTTP_TIMEOUT_MS || '8000', 10) || 8_000),
          nominatimBaseUrl: process.env.NOMINATIM_BASE_URL,
          osrmBaseUrl: process.env.OSRM_BASE_URL,
          viacepBaseUrl: process.env.VIACEP_BASE_URL,
          userAgent: process.env.NOMINATIM_USER_AGENT,
          referer: process.env.BASE_URL,
          originCoordinates: cachedOrigin,
        });
      const calculation = cachedOrigin ? await calculate() : await this.runProximityRequest(calculate);
      this.proximityGeocodeCache.set(addressHash, calculation.origin);
      const normalizedData = calculation.normalizedAddress
        ? this.recordDataWithPostalAddress(record.data, calculation.normalizedAddress)
        : record.data;
      const dataChanged = JSON.stringify(normalizedData) !== JSON.stringify(record.data);
      const nextVersion = dataChanged ? record.currentVersion + 1 : record.currentVersion;
      const saved = await this.dataSource.transaction(async manager => {
        const result = await manager.getRepository(WorkflowRecord).update(
          {
            id: record.id,
            proximityStatus: WorkflowProximityStatus.PROCESSING,
            proximityRevision: revision,
            ...(dataChanged ? { currentVersion: record.currentVersion } : {}),
          },
          {
            proximityStatus: WorkflowProximityStatus.COMPLETED,
            proximityData: {
              originAddress: calculation.origin.address,
              originLatitude: calculation.origin.latitude,
              originLongitude: calculation.origin.longitude,
              destinationHash: this.destinationHash(destinations),
              results: calculation.results,
              calculatedAt: new Date().toISOString(),
            },
            proximityAttempts: attempts,
            proximityNextAttemptAt: null,
            ...(dataChanged ? { data: normalizedData as never, currentVersion: nextVersion } : {}),
          },
        );
        if (result.affected && dataChanged)
          await manager.getRepository(WorkflowRecordVersion).insert({
            recordId: record.id,
            versionNumber: nextVersion,
            data: normalizedData as never,
            source: 'NORMALIZACAO_CEP',
            actorId: null,
          });
        return result;
      });
      if (saved.affected)
        this.logger.log(`Candidate proximity completed recordId=${record.id} destinations=${destinations.length}`);
      else this.logger.debug(`Discarded stale candidate proximity result recordId=${record.id} revision=${revision}`);
    } catch (error) {
      const code = error instanceof ProximityServiceError ? error.code : 'ROUTING_UNAVAILABLE';
      const retryable = code !== 'ADDRESS_NOT_FOUND' && attempts < 3;
      const delays = [1, 5, 30];
      const saved = await this.records.update(
        {
          id: record.id,
          proximityStatus: WorkflowProximityStatus.PROCESSING,
          proximityRevision: revision,
        },
        {
          proximityStatus: retryable ? WorkflowProximityStatus.PENDING : WorkflowProximityStatus.FAILED,
          proximityData: { ...record.proximityData, results: [], errorCode: code },
          proximityAttempts: attempts,
          proximityNextAttemptAt: retryable ? this.plusMinutes(new Date(), delays[Math.min(attempts - 1, 2)]) : null,
        },
      );
      if (saved.affected)
        this.logger.warn(
          `Candidate proximity failed recordId=${record.id} attempt=${attempts} code=${code} retry=${retryable}`,
        );
    }
  }

  private async runProximitySweep(now: Date): Promise<void> {
    if (this.proximitySweepRunning) return;
    this.proximitySweepRunning = true;
    try {
      const due = await this.records.find({
        where: {
          proximityStatus: In([WorkflowProximityStatus.PENDING, WorkflowProximityStatus.PROCESSING]),
          proximityNextAttemptAt: LessThanOrEqual(now),
        },
        order: { proximityNextAttemptAt: 'ASC' },
        take: 1,
      });
      if (due[0]) await this.processProximityRecord(due[0].id);
    } catch (error) {
      this.logger.warn(`Candidate proximity sweep failed: ${this.errorName(error)}`);
    } finally {
      this.proximitySweepRunning = false;
    }
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }

  private async reconcileCancelledAppointmentAnswers(sessionId: string, rows: WorkflowRecord[]): Promise<void> {
    if (!rows.length) return;
    const instanceIds = [...new Set(rows.map(row => row.instanceId))];
    const contactIds = [...new Set(rows.map(row => row.contactId))];
    const cancelled = await this.appointments.find({
      where: {
        instanceId: In(instanceIds),
        contactId: In(contactIds),
        status: AppointmentStatus.CANCELLED,
      },
      relations: { slot: true },
    });
    const removedSlots = await this.slots.find({
      where: { instanceId: In(instanceIds), status: AppointmentSlotStatus.REMOVED },
    });
    if (!cancelled.length && !removedSlots.length) return;
    const instances = await this.instances.find({ where: { id: In(instanceIds) } });
    const department = await this.getDepartment(sessionId);

    for (const row of rows) {
      const cancelledReferences = cancelled.filter(
        appointment =>
          appointment.instanceId === row.instanceId &&
          appointment.contactId === row.contactId &&
          Object.values(row.data).includes(appointment.slotId),
      );
      const removedReferences = removedSlots.filter(
        slot => slot.instanceId === row.instanceId && Object.values(row.data).includes(slot.id),
      );
      const staleSlotIds = [
        ...new Set([...cancelledReferences.map(item => item.slotId), ...removedReferences.map(item => item.id)]),
      ];
      if (!staleSlotIds.length) continue;
      await this.dataSource.transaction(async manager => {
        const fresh = await manager.getRepository(WorkflowRecord).findOneBy({ id: row.id });
        if (!fresh) return;
        const instance = instances.find(item => item.id === fresh.instanceId);
        for (const staleSlotId of staleSlotIds) {
          const cleared = await this.clearAppointmentAnswer(
            manager,
            fresh,
            staleSlotId,
            'APPOINTMENT_REFERENCE_REPAIR',
          );
          const appointment = cancelledReferences.find(item => item.slotId === staleSlotId);
          if (cleared && instance && appointment)
            await this.enqueueAppointmentCancellation(manager, sessionId, instance, appointment, department.timezone);
        }
        row.data = fresh.data;
        row.currentVersion = fresh.currentVersion;
      });
    }
  }

  private async clearAppointmentAnswer(
    manager: EntityManager,
    record: WorkflowRecord,
    slotId: string,
    source: string,
  ): Promise<boolean> {
    const nextData = Object.fromEntries(Object.entries(record.data).filter(([, value]) => value !== slotId));
    if (Object.keys(nextData).length === Object.keys(record.data).length) return false;
    const previousVersion = record.currentVersion;
    const nextVersion = previousVersion + 1;
    const claimed = await manager
      .getRepository(WorkflowRecord)
      .update(
        { id: record.id, currentVersion: previousVersion },
        { data: nextData as never, currentVersion: nextVersion },
      );
    if (!claimed.affected) return false;
    record.data = nextData;
    record.currentVersion = nextVersion;
    await manager.getRepository(WorkflowRecordVersion).insert({
      recordId: record.id,
      versionNumber: nextVersion,
      data: nextData as never,
      source,
      actorId: null,
    });
    return true;
  }

  private async enqueueAppointmentCancellation(
    manager: EntityManager,
    sessionId: string,
    instance: WorkflowInstance,
    appointment: WorkflowAppointment,
    timezone: string,
  ): Promise<void> {
    try {
      await manager.getRepository(WorkflowOutboxMessage).insert({
        sessionId,
        chatId: appointment.contactId,
        body: this.message(
          instance,
          'interviewCancelled',
          '❌ *Sua entrevista foi cancelada*\n\n{detalhes_agendamento}\n\nEnvie uma nova mensagem para consultar os próximos horários disponíveis.',
          this.appointmentTemplateVariables(appointment.slot, timezone || 'America/Sao_Paulo'),
        ),
        dedupeKey: `appointment-cancelled:${appointment.id}`,
        status: WorkflowOutboxStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        nextAttemptAt: new Date(),
      });
    } catch (error) {
      if (!String(error).toLowerCase().includes('unique')) throw error;
    }
  }

  private async enqueueAppointmentConfirmation(
    manager: EntityManager,
    sessionId: string,
    instance: WorkflowInstance,
    appointment: WorkflowAppointment,
    slot: WorkflowAppointmentSlot,
    timezone: string,
    recordVersion: number,
  ): Promise<void> {
    const messageKey =
      slot.interviewPhase === WorkflowInterviewPhase.FOCUSED
        ? 'interviewScheduledPhase2'
        : slot.interviewPhase === WorkflowInterviewPhase.HIRING
          ? 'interviewScheduledPhase3'
          : 'interviewScheduled';
    try {
      await manager.getRepository(WorkflowOutboxMessage).insert({
        sessionId,
        chatId: appointment.contactId,
        body: this.message(
          instance,
          messageKey,
          DEFAULT_WORKFLOW_MESSAGES[messageKey] ?? DEFAULT_WORKFLOW_MESSAGES.interviewScheduled,
          this.appointmentTemplateVariables(slot, timezone || 'America/Sao_Paulo'),
        ),
        dedupeKey: `appointment-confirmed:${appointment.id}:${recordVersion}`,
        status: WorkflowOutboxStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        nextAttemptAt: new Date(),
      });
    } catch (error) {
      if (!String(error).toLowerCase().includes('unique')) throw error;
    }
  }

  private async enqueueAppointmentReschedule(
    manager: EntityManager,
    sessionId: string,
    instance: WorkflowInstance,
    originalAppointment: WorkflowAppointment,
    previousSlot: WorkflowAppointmentSlot,
    nextSlot: WorkflowAppointmentSlot,
    timezone: string,
  ): Promise<boolean> {
    let inserted = true;
    try {
      await manager.getRepository(WorkflowOutboxMessage).insert({
        sessionId,
        chatId: originalAppointment.contactId,
        body: this.appointmentRescheduleMessage(instance, previousSlot, nextSlot, timezone),
        dedupeKey: `appointment-rescheduled:${originalAppointment.id}:${nextSlot.id}`,
        status: WorkflowOutboxStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        nextAttemptAt: new Date(),
      });
    } catch (error) {
      if (!String(error).toLowerCase().includes('unique')) throw error;
      inserted = false;
    }
    await this.enqueueAppointmentOperatorNotification(
      manager,
      sessionId,
      instance,
      originalAppointment,
      nextSlot,
      'REAGENDADA',
      timezone,
      originalAppointment.record,
      previousSlot,
    );
    return inserted;
  }

  private appointmentRescheduleMessage(
    instance: WorkflowInstance,
    previousSlot: WorkflowAppointmentSlot,
    nextSlot: WorkflowAppointmentSlot,
    timezone: string,
  ): string {
    const previous = this.appointmentTemplateVariables(previousSlot, timezone);
    return this.message(
      instance,
      'interviewRescheduled',
      '✅ *Sua entrevista foi reagendada com sucesso!*\n\n🕐 Horário anterior:\n*{horario_anterior}*\n\n📅 *Novo horário:*\n{detalhes_agendamento}',
      {
        horario_anterior: previous.novo_horario,
        ...this.appointmentTemplateVariables(nextSlot, timezone),
      },
    );
  }

  private appointmentTemplateVariables(slot: WorkflowAppointmentSlot, timezone: string): Record<string, string> {
    const date = this.zonedDateParts(slot.startsAt, timezone || 'America/Sao_Paulo');
    return {
      data: this.displayDate(date.date),
      hora: date.time,
      local: slot.location ?? '',
      endereco: slot.address ?? '',
      link_google_maps: slot.mapsUrl ?? '',
      instrucao: slot.instruction ?? '',
      responsavel: slot.responsible ?? '',
      novo_horario: `${this.displayDate(date.date)} às ${date.time}`,
      detalhes_agendamento: this.appointmentDetailsBlock(slot, timezone),
    };
  }

  private appointmentDetailsBlock(slot: WorkflowAppointmentSlot, timezone: string): string {
    const date = this.zonedDateParts(slot.startsAt, timezone || 'America/Sao_Paulo');
    return [
      `📅 Horário da entrevista: *${this.displayDate(date.date)} às ${date.time}*`,
      slot.location ? `🏢 Nome do local: *${slot.location}*` : '',
      slot.address ? `📍 Endereço: ${slot.address}` : '',
      slot.mapsUrl ? `🗺️ Link do Google Maps: ${slot.mapsUrl}` : '',
      slot.instruction ? `📋 Instrução: ${slot.instruction}` : '',
      slot.responsible ? `👤 Apresentar-se para: *${slot.responsible}*` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async enqueueAppointmentOperatorNotification(
    manager: EntityManager,
    sessionId: string,
    instance: WorkflowInstance,
    appointment: WorkflowAppointment,
    slot: WorkflowAppointmentSlot,
    event: WorkflowAppointmentNotificationEvent,
    timezone: string,
    record?: WorkflowRecord | null,
    previousSlot?: WorkflowAppointmentSlot,
  ): Promise<void> {
    const configured = this.normalizeAppointmentNotifications(instance.appointmentNotifications ?? []);
    const phase = slot.interviewPhase ?? WorkflowInterviewPhase.SIMPLE;
    const department = await manager.getRepository(WorkflowDepartment).findOneBy({ id: instance.departmentId });
    let locationId = slot.locationId?.trim() || '';
    if (!locationId) {
      const normalizedSlotName = this.normalizeLocationReference(slot.location);
      const match = (department?.schedule?.locations ?? []).find(location => {
        return [location.name, location.internalName]
          .map(value => this.normalizeLocationReference(value))
          .includes(normalizedSlotName);
      });
      locationId = match?.id ?? '';
    }
    const manualRecipients = configured.length
      ? configured
          .filter(
            recipient =>
              recipient.enabled &&
              recipient.events.includes(event) &&
              (!recipient.locationIds.length || (!!locationId && recipient.locationIds.includes(locationId))) &&
              (!recipient.interviewPhases.length || recipient.interviewPhases.includes(phase)),
          )
          .map(recipient => this.notificationPhone(recipient))
      : this.normalizeAppointmentNotificationNumbers(instance.appointmentNotificationNumbers ?? []).filter(() =>
          ['CONFIRMADA', 'CANCELADA'].includes(event),
        );
    const locationRecipients =
      (department?.schedule?.locations ?? [])
        .find(location => location.id === locationId)
        ?.notificationContacts?.filter(contact => contact.enabled !== false)
        .map(contact => `${contact.ddi}${contact.ddd}${contact.number}`) ?? [];
    const recipients = [...new Set([...locationRecipients, ...manualRecipients])];
    if (!recipients.length) return;
    const contact = record?.phone?.trim() || appointment.contactId.replace(/@.*$/, '');
    const candidateNameValue = Object.entries(record?.data ?? {}).find(
      ([key, value]) => /(^|_)(nome|name)(_|$)/i.test(key) && typeof value === 'string' && value.trim(),
    )?.[1];
    const candidateName = typeof candidateNameValue === 'string' ? candidateNameValue.trim() : '';
    const headings: Record<WorkflowAppointmentNotificationEvent, string> = {
      CONFIRMADA: '📅 *Nova entrevista marcada*',
      CANCELADA: '❌ *Entrevista cancelada*',
      REAGENDADA: '🔄 *Entrevista reagendada*',
      CONCLUIDA: '✅ *Entrevista concluída*',
    };
    const body = [
      headings[event],
      `*Fluxo:* ${instance.name}`,
      `*Fase:* ${this.interviewPhaseDisplayName(phase)}`,
      candidateName ? `*Candidato:* ${candidateName}` : '',
      `*Contato:* ${contact}`,
      previousSlot
        ? `*Horário anterior:* ${this.appointmentTemplateVariables(previousSlot, timezone).novo_horario}`
        : '',
      '',
      this.appointmentDetailsBlock(slot, timezone),
    ]
      .filter(line => line !== '')
      .join('\n');
    const outboxRepo = manager.getRepository(WorkflowOutboxMessage);
    for (const recipient of recipients) {
      try {
        await outboxRepo.insert({
          sessionId,
          chatId: `${recipient}@c.us`,
          body,
          dedupeKey: `appointment-${event.toLowerCase().replace('confirmada', 'confirmed').replace('cancelada', 'cancelled').replace('reagendada', 'rescheduled').replace('concluida', 'completed')}:${appointment.id}${event === 'REAGENDADA' ? `:${slot.id}` : ''}:${recipient}`,
          status: WorkflowOutboxStatus.PENDING,
          attempts: 0,
          maxAttempts: 3,
          nextAttemptAt: new Date(),
        });
      } catch (error) {
        if (!String(error).toLowerCase().includes('unique')) throw error;
      }
    }
  }

  private async resolveMissingRecordPhones(sessionId: string, rows: WorkflowRecord[]): Promise<void> {
    const engine = this.engines?.get(sessionId);
    if (!engine) return;
    const now = Date.now();
    const pending = rows.filter(row => {
      if (row.phone || !row.contactId.endsWith('@lid')) return false;
      const key = `${sessionId}:${row.contactId}`;
      return now - (this.phoneResolutionAttemptedAt.get(key) ?? 0) >= 5 * 60_000;
    });
    for (let index = 0; index < pending.length; index += 5) {
      await Promise.all(
        pending.slice(index, index + 5).map(async row => {
          const key = `${sessionId}:${row.contactId}`;
          this.phoneResolutionAttemptedAt.set(key, now);
          try {
            const phone = await engine.resolveContactPhone(row.contactId);
            if (!phone) return;
            row.phone = phone;
            await this.records.update({ id: row.id }, { phone });
          } catch {
            // Best-effort: some WhatsApp accounts do not expose the LID-to-phone mapping yet.
          }
        }),
      );
    }
  }

  private async ensureWorkflowIdentity(
    departmentId: string,
    sessionId: string,
    contactId: string,
  ): Promise<WorkflowIdentity> {
    const phone = await this.resolveInboundContactPhone(sessionId, contactId);
    const identityRepo = this.dataSource.getRepository(WorkflowIdentity);
    const contactRepo = this.dataSource.getRepository(WorkflowIdentityContact);
    const existingContact = await contactRepo.findOne({
      where: phone
        ? [
            { departmentId, contactId },
            { departmentId, phone },
          ]
        : { departmentId, contactId },
    });
    if (existingContact) {
      if (existingContact.contactId !== contactId) {
        try {
          await contactRepo.insert({
            departmentId,
            identityId: existingContact.identityId,
            contactId,
            // The canonical number already belongs to the existing contact row. This row preserves
            // the alternate WhatsApp address (for example @lid) without duplicating the phone key.
            phone: existingContact.phone === phone ? null : phone,
            verifiedAt: new Date(),
          });
        } catch (error) {
          if (!this.isUniqueConstraintError(error)) throw error;
        }
      } else if (phone && existingContact.phone !== phone) {
        try {
          await contactRepo.update(existingContact.id, { phone, verifiedAt: new Date() });
        } catch (error) {
          if (!this.isUniqueConstraintError(error)) throw error;
        }
      }
      return identityRepo.findOneByOrFail({ id: existingContact.identityId });
    }
    try {
      return await this.dataSource.transaction(async manager => {
        const transactionalContacts = manager.getRepository(WorkflowIdentityContact);
        const raced = await transactionalContacts.findOne({
          where: phone
            ? [
                { departmentId, contactId },
                { departmentId, phone },
              ]
            : { departmentId, contactId },
        });
        if (raced) return manager.getRepository(WorkflowIdentity).findOneByOrFail({ id: raced.identityId });
        const identity = await manager.getRepository(WorkflowIdentity).save({ departmentId, cpf: null });
        await transactionalContacts.save({
          departmentId,
          identityId: identity.id,
          contactId,
          phone,
          verifiedAt: new Date(),
        });
        return identity;
      });
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
      const raced = await contactRepo.findOne({
        where: phone
          ? [
              { departmentId, contactId },
              { departmentId, phone },
            ]
          : { departmentId, contactId },
      });
      if (!raced) throw error;
      return identityRepo.findOneByOrFail({ id: raced.identityId });
    }
  }

  private async bindWorkflowIdentityCpf(run: WorkflowRun, departmentId: string, cpf: string): Promise<void> {
    const normalizedCpf = cpf.replace(/\D/g, '');
    if (!run.identityId || normalizedCpf.length !== 11) return;
    const targetIdentityId = await this.dataSource.transaction(async manager => {
      const identities = manager.getRepository(WorkflowIdentity);
      const contacts = manager.getRepository(WorkflowIdentityContact);
      const current = await identities.findOneByOrFail({ id: run.identityId!, departmentId });
      if (current.cpf && current.cpf !== normalizedCpf)
        throw new ConflictException(
          'Este número já está vinculado a outro CPF. Solicite a correção dos dados ao atendimento.',
        );
      const target = await identities.findOneBy({ departmentId, cpf: normalizedCpf });
      if (!target || target.id === current.id) {
        if (!current.cpf) await identities.update(current.id, { cpf: normalizedCpf });
        return current.id;
      }
      const previouslyLinkedContacts = await contacts.findBy({ identityId: target.id });
      const sourceContacts = await contacts.findBy({ identityId: current.id });
      for (const source of sourceContacts) {
        const duplicate = await contacts.findOne({
          where: source.phone
            ? [
                { departmentId, identityId: target.id, contactId: source.contactId },
                { departmentId, identityId: target.id, phone: source.phone },
              ]
            : { departmentId, identityId: target.id, contactId: source.contactId },
        });
        if (duplicate) await contacts.delete(source.id);
        else await contacts.update(source.id, { identityId: target.id });
      }
      await manager.getRepository(WorkflowRun).update({ identityId: current.id }, { identityId: target.id });
      await manager.getRepository(WorkflowRecord).update({ identityId: current.id }, { identityId: target.id });
      const department = await manager.getRepository(WorkflowDepartment).findOneByOrFail({ id: departmentId });
      const outbox = manager.getRepository(WorkflowOutboxMessage);
      const contactFingerprint = createHash('sha256').update(run.contactId).digest('hex').slice(0, 16);
      for (const previousContact of previouslyLinkedContacts.filter(contact => contact.contactId !== run.contactId)) {
        const dedupeKey = `identity-contact-linked:${target.id}:${contactFingerprint}:${previousContact.id}`;
        if (await outbox.exists({ where: { dedupeKey } })) continue;
        await outbox.insert({
          sessionId: department.sessionId,
          chatId: previousContact.contactId,
          body: 'Aviso de segurança: um novo número de WhatsApp foi vinculado ao seu cadastro após a confirmação do CPF. Se você não reconhece essa alteração, fale com o atendimento.',
          dedupeKey,
          status: WorkflowOutboxStatus.PENDING,
          attempts: 0,
          maxAttempts: 3,
          nextAttemptAt: new Date(),
        });
      }
      await identities.delete(current.id);
      return target.id;
    });
    run.identityId = targetIdentityId;
  }

  private async findRecordForIdentity(
    instanceId: string,
    identityId: string | null,
    contactId: string,
  ): Promise<WorkflowRecord | null> {
    if (identityId) {
      const record = await this.records.findOne({
        where: { instanceId, identityId },
        order: { updatedAt: 'DESC' },
      });
      if (record) return record;
    }
    return this.records.findOne({ where: { instanceId, contactId } });
  }

  private async canonicalRecordContactId(
    run: WorkflowRun,
    instanceId: string,
    fallbackContactId: string,
  ): Promise<string> {
    return (
      (await this.findRecordForIdentity(instanceId, run.identityId, fallbackContactId))?.contactId ?? fallbackContactId
    );
  }

  private async resolveInboundContactPhone(sessionId: string, contactId: string): Promise<string | null> {
    if (!contactId.endsWith('@lid')) return this.normalizePhone(contactId);
    const engine = this.engines?.get(sessionId);
    if (!engine) return null;
    try {
      return this.normalizePhone(await engine.resolveContactPhone(contactId));
    } catch {
      return null;
    }
  }

  private normalizePhone(value: string | null | undefined): string | null {
    if (!value) return null;
    const digits = value.replace(/@.*$/, '').replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 13 ? digits : null;
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => this.stableJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map(key => `${JSON.stringify(key)}:${this.stableJson(object[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  private validateExternalRecordData(
    version: WorkflowDefinitionVersion,
    existingData: Record<string, unknown>,
    suppliedData: Record<string, unknown>,
  ): Record<string, unknown> {
    const fieldsByKey = new Map<string, WorkflowFieldDefinition[]>();
    for (const field of version.fields) {
      const key = this.answerKey(field);
      fieldsByKey.set(key, [...(fieldsByKey.get(key) ?? []), field]);
    }
    const unknown = Object.keys(suppliedData).filter(key => !fieldsByKey.has(key));
    if (unknown.length) throw new BadRequestException(`Campo de cadastro desconhecido: ${unknown[0]}.`);

    const merged = { ...existingData, ...suppliedData };
    const reachable = this.reachableExternalFields(version, merged);
    for (const key of Object.keys(suppliedData)) {
      const applicable = (fieldsByKey.get(key) ?? []).some(field => reachable.has(field.id));
      if (!applicable) throw new BadRequestException(`O campo “${key}” não pertence ao caminho visível do cadastro.`);
    }

    const result: Record<string, unknown> = {};
    const validatedKeys = new Set<string>();
    for (const field of version.fields) {
      if (!reachable.has(field.id)) continue;
      const key = this.answerKey(field);
      if (validatedKeys.has(key)) continue;
      validatedKeys.add(key);
      const input = merged[key];
      const empty = input === undefined || input === null || input === '';
      if (empty && !field.required) continue;
      const normalized = this.normalizeAdministrativeRecordValue(field, input, { ...merged, ...result });
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }

  private reachableExternalFields(version: WorkflowDefinitionVersion, answers: Record<string, unknown>): Set<string> {
    const graph = this.workflowGraph(version);
    if (!graph)
      return new Set(
        version.fields.filter(field => this.isFieldVisible(field, answers, version.fields)).map(field => field.id),
      );
    const reachable = new Set<string>();
    const visited = new Set<string>();
    let node = graph.nodes.find(item => item.id === graph.startNodeId);
    while (node && !visited.has(node.id)) {
      visited.add(node.id);
      if (node.type === 'question' && node.data.fieldId) {
        const field = version.fields.find(item => item.id === node!.data.fieldId);
        if (field && this.isFieldVisible(field, answers, version.fields)) reachable.add(field.id);
      }
      node = this.nextGraphNode(graph, node.id, answers, version.fields);
    }
    return reachable;
  }

  private async runIngestSerialized<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
    const orderedKeys = [...new Set(keys)].sort();
    const predecessors = orderedKeys.map(key => this.ingestQueues.get(key) ?? Promise.resolve());
    let release!: () => void;
    const own = new Promise<void>(resolve => (release = resolve));
    const queued = Promise.all(predecessors).then(() => own);
    for (const key of orderedKeys) this.ingestQueues.set(key, queued);
    await Promise.all(predecessors);
    try {
      return await operation();
    } finally {
      release();
      for (const key of orderedKeys) if (this.ingestQueues.get(key) === queued) this.ingestQueues.delete(key);
    }
  }

  private async acquireIngestDatabaseLocks(
    manager: EntityManager,
    instanceId: string,
    eventKey: string,
    contactId: string,
  ): Promise<void> {
    if (this.dataSource.options.type !== 'postgres') return;
    for (const key of [`event:${instanceId}:${eventKey}`, `contact:${instanceId}:${contactId}`].sort())
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }

  private async withIngestTransactionRetry<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction(operation);
      } catch (error) {
        if (attempt >= maxAttempts || !this.isRetryableIngestDatabaseError(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 15));
      }
    }
  }

  private databaseErrorCode(error: unknown): string {
    const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
    const code = candidate?.driverError?.code ?? candidate?.code;
    return typeof code === 'string' || typeof code === 'number' ? `${code}`.toUpperCase() : '';
  }

  private isRetryableIngestDatabaseError(error: unknown): boolean {
    const code = this.databaseErrorCode(error);
    return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === '40P01' || code === '40001';
  }

  private isIngestEventConstraintError(error: unknown): boolean {
    if (!this.isUniqueConstraintError(error)) return false;
    const value = String(error).toLowerCase();
    const constraintValue =
      (error as { constraint?: unknown; driverError?: { constraint?: unknown } })?.driverError?.constraint ??
      (error as { constraint?: unknown })?.constraint;
    const constraint = typeof constraintValue === 'string' ? constraintValue.toLowerCase() : '';
    return (
      constraint === 'uq_workflow_record_ingest_event_scope_key' ||
      (value.includes('workflow_record_ingest_events') && value.includes('instanceid') && value.includes('eventkey'))
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    const value = String(error).toLowerCase();
    return value.includes('unique') || value.includes('duplicate') || this.databaseErrorCode(error) === '23505';
  }

  async deleteRecord(
    sessionId: string,
    recordId: string,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<void> {
    const record = await this.records.findOne({ where: { id: recordId }, relations: { instance: true } });
    if (!record || (await this.getDepartment(sessionId)).id !== record.instance.departmentId)
      throw new NotFoundException('Cadastro não encontrado neste setor.');
    if (!this.isChatAllowed(record.contactId, allowedChats, record.phone))
      throw new NotFoundException('Cadastro não encontrado neste setor.');
    const contactHash = createHash('sha256').update(`${record.instanceId}:${record.contactId}`).digest('hex');
    await this.dataSource.transaction(async manager => {
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const slotRepo = manager.getRepository(WorkflowAppointmentSlot);
      const appointments = await appointmentRepo.find({
        where: { recordId: record.id, status: AppointmentStatus.CONFIRMED },
      });
      for (const appointment of appointments) {
        await slotRepo
          .createQueryBuilder()
          .update()
          .set({
            bookedCount: () => 'CASE WHEN "bookedCount" > 0 THEN "bookedCount" - 1 ELSE 0 END',
            status: AppointmentSlotStatus.AVAILABLE,
          })
          .where('id = :id', { id: appointment.slotId })
          .execute();
      }
      if (record.identityId) await manager.getRepository(WorkflowRun).delete({ identityId: record.identityId });
      else
        await manager.getRepository(WorkflowRun).delete({ instanceId: record.instanceId, contactId: record.contactId });
      await manager
        .getRepository(WorkflowRecruitmentApplication)
        .delete({ instanceId: record.instanceId, contactId: record.contactId });
      await appointmentRepo.delete({ recordId: record.id });
      await manager.getRepository(WorkflowPrivacyEvent).save({
        instanceId: record.instanceId,
        type: 'DATA_DELETION_BY_ADMIN',
        anonymousSubjectHash: contactHash,
        actorId,
        metadata: { recordVersion: record.currentVersion },
      });
      const outboxRepo = manager.getRepository(WorkflowOutboxMessage);
      await outboxRepo.update(
        {
          sessionId,
          chatId: record.contactId,
          status: In([WorkflowOutboxStatus.PENDING, WorkflowOutboxStatus.RETRYING, WorkflowOutboxStatus.FAILED]),
        },
        {
          status: WorkflowOutboxStatus.CANCELLED,
          lastError: 'Notificação cancelada porque os dados do contato foram excluídos.',
        },
      );
      await outboxRepo.insert({
        sessionId,
        chatId: record.contactId,
        body: this.message(
          record.instance,
          'privacyAdminDeleted',
          'Seu cadastro e seus dados foram excluídos por um administrador. Para utilizar o atendimento novamente, será necessário realizar um novo cadastro.',
        ),
        dedupeKey: `record-admin-delete:${record.id}`,
        status: WorkflowOutboxStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        nextAttemptAt: new Date(),
      });
      await manager.getRepository(WorkflowRecord).delete(record.id);
      if (
        record.identityId &&
        !(await manager.getRepository(WorkflowRecord).exists({ where: { identityId: record.identityId } }))
      )
        await manager.getRepository(WorkflowIdentity).delete(record.identityId);
    });
  }

  async listTickets(
    sessionId: string,
    openOnly = false,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowTicket[]> {
    const department = await this.getDepartment(sessionId);
    const where = openOnly
      ? {
          departmentId: department.id,
          status: In([WorkflowTicketStatus.WAITING, WorkflowTicketStatus.ACTIVE, WorkflowTicketStatus.IDLE_WARNING]),
        }
      : { departmentId: department.id };
    const rows = await this.tickets.find({ where, relations: { instance: true }, order: { updatedAt: 'DESC' } });
    return rows.filter(row => this.isChatAllowed(row.chatId, allowedChats));
  }

  async listTicketEvents(
    sessionId: string,
    ticketId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowTicketEvent[]> {
    const ticket = await this.requireTicket(sessionId, ticketId, allowedChats);
    return this.ticketEvents.find({ where: { ticketId: ticket.id }, order: { createdAt: 'ASC' } });
  }

  async touchTicket(
    sessionId: string,
    ticketId: string,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowTicket> {
    const ticket = await this.requireTicket(sessionId, ticketId, allowedChats);
    if (!ticket.openKey) throw new ConflictException('O chamado já está encerrado.');
    return this.resetTicketActivity(ticket, 'MANUAL_ACTIVITY', actorId);
  }

  async closeTicket(
    sessionId: string,
    ticketId: string,
    actorId: string | null,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowTicket> {
    const ticket = await this.requireTicket(sessionId, ticketId, allowedChats);
    if (!ticket.openKey) return ticket;
    const now = new Date();
    return this.dataSource.transaction(async manager => {
      const ticketRepo = manager.getRepository(WorkflowTicket);
      const claimed = await ticketRepo.update(
        { id: ticket.id, version: ticket.version, openKey: ticket.openKey! },
        {
          openKey: null,
          status: WorkflowTicketStatus.CLOSED,
          closedAt: now,
          closeReason: WorkflowTicketCloseReason.MANUAL,
        },
      );
      if (!claimed.affected) return ticketRepo.findOneByOrFail({ id: ticket.id });
      await manager
        .getRepository(WorkflowRun)
        .update({ id: ticket.runId }, { openKey: null, state: WorkflowRunState.CLOSED, deadlineAt: now });
      await manager.getRepository(WorkflowTicketEvent).insert({
        ticketId: ticket.id,
        type: 'CLOSED_MANUALLY',
        actorId,
        metadata: {},
      });
      try {
        await manager.getRepository(WorkflowOutboxMessage).insert({
          sessionId,
          chatId: ticket.chatId,
          body: this.message(
            ticket.instance,
            'humanClosed',
            'O atendimento humano foi encerrado. Envie uma nova mensagem para abrir o menu novamente.',
          ),
          dedupeKey: `ticket-manual-close:${ticket.id}`,
          status: WorkflowOutboxStatus.PENDING,
          attempts: 0,
          maxAttempts: 3,
          nextAttemptAt: now,
        });
      } catch (error) {
        if (!String(error).toLowerCase().includes('unique')) throw error;
      }
      return ticketRepo.findOneByOrFail({ id: ticket.id });
    });
  }

  async touchHumanActivity(
    sessionId: string,
    chatId: string,
    type: 'CLIENT_MESSAGE' | 'AGENT_MESSAGE' | 'MANUAL_ACTIVITY',
    actorId: string | null,
  ): Promise<boolean> {
    const department = await this.departments.findOne({ where: { sessionId } });
    if (!department) return false;
    const ticket = await this.tickets.findOne({
      where: { openKey: `${department.id}:${chatId}` },
      relations: { instance: true },
    });
    if (!ticket) return false;
    await this.resetTicketActivity(ticket, type, actorId);
    return true;
  }

  async updateSlotStatus(
    sessionId: string,
    instanceId: string,
    slotId: string,
    status: AppointmentSlotStatus,
  ): Promise<WorkflowAppointmentSlot> {
    await this.requireInstance(sessionId, instanceId);
    const slot = await this.slots.findOne({ where: { id: slotId, instanceId } });
    if (!slot) throw new NotFoundException('Horário não encontrado.');
    const hasConfirmedAppointment = await this.appointments.exists({
      where: { slotId, status: AppointmentStatus.CONFIRMED },
    });
    if (hasConfirmedAppointment && status !== AppointmentSlotStatus.CONFIRMED)
      throw new ConflictException('Reagende ou cancele os candidatos antes de alterar este horário.');
    if (!hasConfirmedAppointment && ![AppointmentSlotStatus.AVAILABLE, AppointmentSlotStatus.BLOCKED].includes(status))
      throw new BadRequestException('Use somente Disponível ou Bloqueado para um horário sem candidatos.');
    slot.status = status;
    slot.heldByRunId = null;
    slot.holdUntil = null;
    return this.slots.save(slot);
  }

  async updateAppointmentStatus(
    sessionId: string,
    instanceId: string,
    appointmentId: string,
    status: AppointmentStatus.CANCELLED | AppointmentStatus.COMPLETED,
    allowedChats: string[] | null = null,
    notifyCustomer = true,
  ): Promise<WorkflowAppointment> {
    const instance = await this.requireInstance(sessionId, instanceId);
    const department = await this.getDepartment(sessionId);
    return this.dataSource.transaction(async manager => {
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const row = await appointmentRepo.findOne({
        where: { id: appointmentId, instanceId },
        relations: { slot: true, record: true },
      });
      if (!row) throw new NotFoundException('Agendamento não encontrado.');
      if (!this.isChatAllowed(row.contactId, allowedChats, row.record?.phone))
        throw new NotFoundException('Agendamento não encontrado.');
      if (row.status === status) return row;
      if (row.status !== AppointmentStatus.CONFIRMED)
        throw new ConflictException('Somente uma entrevista confirmada pode ser concluída ou cancelada.');

      const now = new Date();
      const claimed = await appointmentRepo.update(
        { id: row.id, instanceId, status: AppointmentStatus.CONFIRMED },
        {
          status,
          cancelledAt: status === AppointmentStatus.CANCELLED ? now : null,
        },
      );
      if (!claimed.affected) throw new ConflictException('A entrevista já foi alterada. Atualize a agenda.');

      if (status === AppointmentStatus.CANCELLED) {
        await manager
          .getRepository(WorkflowAppointmentSlot)
          .createQueryBuilder()
          .update()
          .set({
            bookedCount: () => 'CASE WHEN "bookedCount" > 0 THEN "bookedCount" - 1 ELSE 0 END',
            status: AppointmentSlotStatus.AVAILABLE,
          })
          .where('id = :id', { id: row.slotId })
          .execute();
        const record = row.recordId
          ? await manager.getRepository(WorkflowRecord).findOneBy({ id: row.recordId, instanceId })
          : await manager.getRepository(WorkflowRecord).findOneBy({ instanceId, contactId: row.contactId });
        if (record) await this.clearAppointmentAnswer(manager, record, row.slotId, 'APPOINTMENT_CANCELLED');
        if (notifyCustomer)
          await this.enqueueAppointmentCancellation(manager, sessionId, instance, row, department.timezone);
        await this.enqueueAppointmentOperatorNotification(
          manager,
          sessionId,
          instance,
          row,
          row.slot,
          'CANCELADA',
          department.timezone,
          record,
        );
      }
      if (status === AppointmentStatus.COMPLETED) {
        await this.enqueueAppointmentOperatorNotification(
          manager,
          sessionId,
          instance,
          row,
          row.slot,
          'CONCLUIDA',
          department.timezone,
          row.record,
        );
      }
      await this.syncRecruitmentApplication(
        manager,
        { ...row, status },
        status === AppointmentStatus.CANCELLED
          ? WorkflowRecruitmentStatus.CANCELLED
          : this.recruitmentStatusForAppointment({ status }, row.slot),
        null,
        status === AppointmentStatus.CANCELLED ? 'APPOINTMENT_CANCELLED' : 'INTERVIEW_COMPLETED',
        {
          appointmentStartsAt: row.slot?.startsAt?.toISOString(),
          location: row.slot?.location,
        },
      );
      return appointmentRepo.findOneByOrFail({ id: row.id });
    });
  }

  async scheduleRecordAppointment(
    sessionId: string,
    instanceId: string,
    recordId: string,
    targetSlotId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowAppointment> {
    const instance = await this.requireInstance(sessionId, instanceId);
    const department = await this.getDepartment(sessionId);
    return this.dataSource.transaction(async manager => {
      const recordRepo = manager.getRepository(WorkflowRecord);
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const slotRepo = manager.getRepository(WorkflowAppointmentSlot);
      const record = await recordRepo.findOneBy({ id: recordId, instanceId });
      if (!record || !this.isChatAllowed(record.contactId, allowedChats, record.phone))
        throw new NotFoundException('Candidato não encontrado.');
      if (
        await appointmentRepo.exists({
          where: { instanceId, contactId: record.contactId, status: AppointmentStatus.CONFIRMED },
        })
      )
        throw new ConflictException('Este candidato já possui uma entrevista. Use a opção de reagendamento.');

      const target = await slotRepo.findOneBy({ id: targetSlotId, instanceId });
      if (
        !target ||
        target.status !== AppointmentSlotStatus.AVAILABLE ||
        target.startsAt <= new Date() ||
        target.bookedCount >= target.capacity
      )
        throw new ConflictException('O horário não está mais disponível. Atualize a ficha do candidato.');

      const reserved = await slotRepo
        .createQueryBuilder()
        .update()
        .set({
          bookedCount: () => '"bookedCount" + 1',
          status: () =>
            `CASE WHEN "bookedCount" + 1 >= "capacity" THEN '${AppointmentSlotStatus.CONFIRMED}' ELSE '${AppointmentSlotStatus.AVAILABLE}' END`,
        })
        .where('id = :id AND "instanceId" = :instanceId AND status = :status AND "bookedCount" < capacity', {
          id: target.id,
          instanceId,
          status: AppointmentSlotStatus.AVAILABLE,
        })
        .execute();
      if (!reserved.affected)
        throw new ConflictException('A última vaga acabou de ser ocupada. Escolha outro horário.');

      let appointment = await appointmentRepo.findOne({
        where: { slotId: target.id, contactId: record.contactId },
      });
      if (appointment) {
        appointment.status = AppointmentStatus.CONFIRMED;
        appointment.cancelledAt = null;
        appointment.reminderSentAt = null;
        appointment.recordId = record.id;
        appointment = await appointmentRepo.save(appointment);
      } else {
        appointment = await appointmentRepo.save(
          appointmentRepo.create({
            slotId: target.id,
            instanceId,
            contactId: record.contactId,
            recordId: record.id,
          }),
        );
      }

      const definition = instance.currentVersionId
        ? await manager.getRepository(WorkflowDefinitionVersion).findOneBy({ id: instance.currentVersionId })
        : null;
      const appointmentField = definition?.fields.find(field => field.type === 'appointment');
      const previousVersion = record.currentVersion;
      const nextVersion = previousVersion + 1;
      const nextData = appointmentField
        ? { ...record.data, [this.answerKey(appointmentField)]: target.id }
        : { ...record.data };
      const claimed = await recordRepo.update(
        { id: record.id, currentVersion: previousVersion },
        { data: nextData as never, currentVersion: nextVersion },
      );
      if (!claimed.affected)
        throw new ConflictException('O cadastro foi alterado. Atualize a ficha e tente novamente.');
      record.data = nextData;
      record.currentVersion = nextVersion;
      await manager.getRepository(WorkflowRecordVersion).insert({
        recordId: record.id,
        versionNumber: nextVersion,
        data: nextData as never,
        source: 'AGENDAMENTO_MANUAL',
        actorId: null,
      });

      const confirmedSlot = await slotRepo.findOneByOrFail({ id: target.id, instanceId });
      await this.syncRecruitmentApplication(
        manager,
        appointment,
        this.recruitmentStatusForAppointment(appointment, confirmedSlot),
        null,
        'APPOINTMENT_CONFIRMED',
        { appointmentStartsAt: confirmedSlot.startsAt.toISOString(), location: confirmedSlot.location },
      );
      await this.enqueueAppointmentConfirmation(
        manager,
        sessionId,
        instance,
        appointment,
        confirmedSlot,
        department.timezone,
        nextVersion,
      );
      await this.enqueueAppointmentOperatorNotification(
        manager,
        sessionId,
        instance,
        appointment,
        confirmedSlot,
        'CONFIRMADA',
        department.timezone,
        record,
      );
      return appointmentRepo.findOneOrFail({ where: { id: appointment.id }, relations: { slot: true } });
    });
  }

  async rescheduleAppointment(
    sessionId: string,
    instanceId: string,
    appointmentId: string,
    targetSlotId: string,
    allowedChats: string[] | null = null,
    notifyCustomer = true,
  ): Promise<WorkflowAppointment> {
    const instance = await this.requireInstance(sessionId, instanceId);
    const department = await this.getDepartment(sessionId);
    return this.dataSource.transaction(async manager => {
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const slotRepo = manager.getRepository(WorkflowAppointmentSlot);
      const recordRepo = manager.getRepository(WorkflowRecord);
      const row = await appointmentRepo.findOne({
        where: { id: appointmentId, instanceId },
        relations: { slot: true, record: true },
      });
      if (!row || !this.isChatAllowed(row.contactId, allowedChats, row.record?.phone))
        throw new NotFoundException('Agendamento não encontrado.');
      if (row.status !== AppointmentStatus.CONFIRMED)
        throw new ConflictException('Somente uma entrevista confirmada pode ser reagendada.');
      if (row.slotId === targetSlotId) throw new BadRequestException('Escolha um horário diferente do atual.');
      const target = await slotRepo.findOne({ where: { id: targetSlotId, instanceId } });
      if (
        !target ||
        target.status !== AppointmentSlotStatus.AVAILABLE ||
        target.startsAt <= new Date() ||
        target.bookedCount >= target.capacity
      )
        throw new ConflictException('O novo horário não está mais disponível. Atualize a agenda.');

      const claimed = await appointmentRepo.update(
        { id: row.id, instanceId, status: AppointmentStatus.CONFIRMED },
        { status: AppointmentStatus.CANCELLED, cancelledAt: new Date() },
      );
      if (!claimed.affected) throw new ConflictException('O agendamento já foi alterado. Atualize a agenda.');
      const reserved = await slotRepo
        .createQueryBuilder()
        .update()
        .set({
          bookedCount: () => '"bookedCount" + 1',
          status: () =>
            `CASE WHEN "bookedCount" + 1 >= "capacity" THEN '${AppointmentSlotStatus.CONFIRMED}' ELSE '${AppointmentSlotStatus.AVAILABLE}' END`,
        })
        .where('id = :id AND "instanceId" = :instanceId AND status = :status AND "bookedCount" < capacity', {
          id: target.id,
          instanceId,
          status: AppointmentSlotStatus.AVAILABLE,
        })
        .execute();
      if (!reserved.affected)
        throw new ConflictException('A última vaga acabou de ser ocupada. Escolha outro horário.');
      await slotRepo
        .createQueryBuilder()
        .update()
        .set({
          bookedCount: () => 'CASE WHEN "bookedCount" > 0 THEN "bookedCount" - 1 ELSE 0 END',
          status: AppointmentSlotStatus.AVAILABLE,
        })
        .where('id = :id', { id: row.slotId })
        .execute();

      let replacement = await appointmentRepo.findOne({ where: { slotId: target.id, contactId: row.contactId } });
      if (replacement) {
        replacement.status = AppointmentStatus.CONFIRMED;
        replacement.cancelledAt = null;
        replacement.reminderSentAt = null;
        replacement.recordId = row.recordId;
      } else {
        replacement = appointmentRepo.create({
          slotId: target.id,
          instanceId,
          contactId: row.contactId,
          recordId: row.recordId,
          status: AppointmentStatus.CONFIRMED,
          cancelledAt: null,
          reminderSentAt: null,
        });
      }
      replacement = await appointmentRepo.save(replacement);
      await this.syncRecruitmentApplication(
        manager,
        replacement,
        this.recruitmentStatusForAppointment(replacement, target),
        null,
        'APPOINTMENT_RESCHEDULED',
        {
          previousAppointmentStartsAt: row.slot?.startsAt?.toISOString(),
          appointmentStartsAt: target.startsAt.toISOString(),
          previousLocation: row.slot?.location,
          location: target.location,
        },
      );
      const record = row.recordId
        ? await recordRepo.findOneBy({ id: row.recordId, instanceId })
        : await recordRepo.findOneBy({ instanceId, contactId: row.contactId });
      if (record) {
        const nextData = Object.fromEntries(
          Object.entries(record.data).map(([key, value]) => [key, value === row.slotId ? target.id : value]),
        );
        if (JSON.stringify(nextData) !== JSON.stringify(record.data)) {
          const nextVersion = record.currentVersion + 1;
          const claimedRecord = await recordRepo.update(
            { id: record.id, currentVersion: record.currentVersion },
            { data: nextData as never, currentVersion: nextVersion },
          );
          if (!claimedRecord.affected)
            throw new ConflictException('O cadastro foi alterado durante o reagendamento. Tente novamente.');
          await manager.getRepository(WorkflowRecordVersion).insert({
            recordId: record.id,
            versionNumber: nextVersion,
            data: nextData as never,
            source: 'APPOINTMENT_RESCHEDULED_INDIVIDUALLY',
            actorId: null,
          });
        }
      }
      const runRepo = manager.getRepository(WorkflowRun);
      const activeRuns = await runRepo.find({ where: { instanceId, contactId: row.contactId } });
      for (const run of activeRuns) {
        const nextDraft = Object.fromEntries(
          Object.entries(run.draft).map(([key, value]) => [key, value === row.slotId ? target.id : value]),
        );
        if (JSON.stringify(nextDraft) !== JSON.stringify(run.draft))
          await runRepo.update(run.id, { draft: nextDraft as never });
      }
      if (notifyCustomer)
        await this.enqueueAppointmentReschedule(
          manager,
          sessionId,
          instance,
          row,
          row.slot,
          target,
          department.timezone,
        );
      else
        await this.enqueueAppointmentOperatorNotification(
          manager,
          sessionId,
          instance,
          row,
          target,
          'REAGENDADA',
          department.timezone,
          record,
          row.slot,
        );
      return appointmentRepo.findOneOrFail({ where: { id: replacement.id }, relations: { slot: true, record: true } });
    });
  }

  async listDeletionRequests(sessionId: string): Promise<WorkflowDeletionRequest[]> {
    const department = await this.getDepartment(sessionId);
    const flows = await this.instances.find({ where: { departmentId: department.id } });
    const records = flows.length
      ? await this.records.find({ where: { instanceId: In(flows.map(flow => flow.id)) } })
      : [];
    return records.length
      ? this.deletionRequests.find({
          where: { recordId: In(records.map(record => record.id)) },
          order: { createdAt: 'DESC' },
        })
      : [];
  }

  async decideDeletion(sessionId: string, requestId: string, approve: boolean, actorId: string | null) {
    const request = await this.deletionRequests.findOne({
      where: { id: requestId },
      relations: { record: { instance: { department: true } } },
    });
    if (!request || request.record.instance.department.sessionId !== sessionId)
      throw new NotFoundException('Solicitação não encontrada.');
    if (request.status !== DeletionRequestStatus.PENDING) throw new ConflictException('A solicitação já foi decidida.');
    if (!approve) {
      request.status = DeletionRequestStatus.REJECTED;
      request.openKey = null;
      request.decidedAt = new Date();
      request.decidedBy = actorId;
      request.record.status = WorkflowRecordStatus.VALID;
      await this.records.save(request.record);
      await this.runs.update(
        { instanceId: request.record.instanceId, contactId: request.record.contactId },
        { state: WorkflowRunState.REGISTERED_MENU },
      );
      return this.deletionRequests.save(request);
    }
    const { instanceId, contactId, id: recordId } = request.record;
    const owningSessionId = request.record.instance.department.sessionId;
    await this.dataSource.transaction(async manager => {
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const slotRepo = manager.getRepository(WorkflowAppointmentSlot);
      const rows = await appointmentRepo.find({ where: { instanceId, contactId } });
      if (rows.length) {
        await appointmentRepo.delete({ id: In(rows.map(row => row.id)) });
        const removedBySlot = new Map<string, number>();
        for (const row of rows) {
          if (row.status !== AppointmentStatus.CONFIRMED) continue;
          removedBySlot.set(row.slotId, (removedBySlot.get(row.slotId) ?? 0) + 1);
        }
        for (const [slotId, removed] of removedBySlot) {
          await slotRepo
            .createQueryBuilder()
            .update()
            .set({
              bookedCount: () => `CASE WHEN "bookedCount" > ${removed} THEN "bookedCount" - ${removed} ELSE 0 END`,
              status: AppointmentSlotStatus.AVAILABLE,
              heldByRunId: null,
              holdUntil: null,
            })
            .where('id = :slotId', { slotId })
            .execute();
        }
      }
      if (request.record.identityId)
        await manager.getRepository(WorkflowRun).delete({ identityId: request.record.identityId });
      else await manager.getRepository(WorkflowRun).delete({ instanceId, contactId });
      await manager.getRepository(WorkflowRecruitmentApplication).delete({ instanceId, contactId });
      await manager.getRepository(Message).delete({ sessionId: owningSessionId, chatId: contactId });
      // Purge the same subject from the retired talent_* model as well. Keeping these rows would
      // make an approved privacy deletion incomplete after an installation was migrated.
      if (this.dataSource.hasMetadata(TalentFlowSession) && this.dataSource.hasMetadata(TalentCandidate)) {
        await manager.getRepository(TalentFlowSession).delete({ sessionId: owningSessionId, contactId });
        await manager.getRepository(TalentCandidate).delete({ sessionId: owningSessionId, contactId });
      }
      await manager.getRepository(WorkflowPrivacyEvent).save({
        instanceId,
        type: 'DATA_DELETION_APPROVED',
        anonymousSubjectHash: createHash('sha256').update(`${instanceId}:${contactId}`).digest('hex'),
        actorId,
        metadata: { requestId, recordVersion: request.record.currentVersion },
      });
      const outboxRepo = manager.getRepository(WorkflowOutboxMessage);
      // Previous rows may contain the destination and rendered personal content. They are not
      // required to prove that the deletion happened, so remove them and retain only the
      // pseudonymous privacy event above. The one confirmation below is scrubbed after delivery.
      await outboxRepo.delete({ sessionId: owningSessionId, chatId: contactId });
      await outboxRepo.insert({
        sessionId: owningSessionId,
        chatId: contactId,
        body: this.message(
          request.record.instance,
          'privacyDeleted',
          'Seus dados pessoais foram excluídos conforme solicitado. Para utilizar o atendimento novamente, será necessário realizar um novo cadastro.',
        ),
        dedupeKey: `privacy-deletion:${requestId}`,
        status: WorkflowOutboxStatus.PENDING,
        attempts: 0,
        maxAttempts: 3,
        nextAttemptAt: new Date(),
      });
      await manager.getRepository(WorkflowRecord).delete(recordId);
      if (
        request.record.identityId &&
        !(await manager.getRepository(WorkflowRecord).exists({ where: { identityId: request.record.identityId } }))
      )
        await manager.getRepository(WorkflowIdentity).delete(request.record.identityId);
    });
    return { id: requestId, status: DeletionRequestStatus.APPROVED, deletedAt: new Date(), anonymous: true };
  }

  async indicators(sessionId: string) {
    const department = await this.getDepartment(sessionId);
    const instances = await this.instances.find({ where: { departmentId: department.id } });
    const ids = instances.map(row => row.id);
    if (!ids.length) return { flows: 0, published: 0, records: 0, activeRuns: 0, availableSlots: 0, appointments: 0 };
    const [records, activeRuns, availableSlots, appointments] = await Promise.all([
      this.records.count({ where: { instanceId: In(ids) } }),
      this.runs.count({ where: { instanceId: In(ids) } }),
      this.slots.count({ where: { instanceId: In(ids), status: AppointmentSlotStatus.AVAILABLE } }),
      this.appointments.count({ where: { instanceId: In(ids) } }),
    ]);
    return {
      flows: ids.length,
      published: instances.filter(row => row.status === WorkflowInstanceStatus.PUBLISHED).length,
      records,
      activeRuns,
      availableSlots,
      appointments,
    };
  }

  async sweepDeadlines(now = new Date()): Promise<Array<{ sessionId: string; chatId: string; text: string }>> {
    void this.runProximitySweep(now);
    await this.records.update(
      { status: WorkflowRecordStatus.VALID, validUntil: LessThanOrEqual(now) },
      { status: WorkflowRecordStatus.EXPIRED },
    );
    await this.slots.update(
      { status: AppointmentSlotStatus.HELD, holdUntil: LessThanOrEqual(now) },
      { status: AppointmentSlotStatus.AVAILABLE, heldByRunId: null, holdUntil: null },
    );
    await this.slots.update(
      {
        startsAt: LessThanOrEqual(now),
        status: In([AppointmentSlotStatus.AVAILABLE, AppointmentSlotStatus.BLOCKED, AppointmentSlotStatus.HELD]),
      },
      { status: AppointmentSlotStatus.COMPLETED, heldByRunId: null, holdUntil: null },
    );
    const due = await this.runs.find({ where: { deadlineAt: LessThanOrEqual(now) }, take: 100 });
    const output: Array<{ sessionId: string; chatId: string; text: string }> = [];
    for (const run of due) {
      const department = await this.departments.findOneBy({ id: run.departmentId });
      if (!department || !run.openKey) continue;
      if (run.state === WorkflowRunState.HUMAN) {
        const instance = run.instanceId ? await this.instances.findOneBy({ id: run.instanceId }) : null;
        const transitioned = await this.transitionHumanToWarning(run, now, instance?.humanGraceMinutes ?? 5);
        if (transitioned)
          output.push({
            sessionId: department.sessionId,
            chatId: run.chatId,
            text: this.message(
              instance,
              'humanWarning',
              'Seu atendimento está sem atividade e será encerrado em {minutos} minutos.',
              { minutos: instance?.humanGraceMinutes ?? 5 },
            ),
          });
        continue;
      }
      if (run.state === WorkflowRunState.IDLE_WARNING) {
        const transitioned = await this.transitionWarningToClosed(run, now);
        if (transitioned) {
          const instance = run.instanceId ? await this.instances.findOneBy({ id: run.instanceId }) : null;
          output.push({
            sessionId: department.sessionId,
            chatId: run.chatId,
            text: this.message(
              instance,
              'humanClosed',
              'O atendimento foi encerrado automaticamente por inatividade. Envie uma nova mensagem para abrir o menu.',
            ),
          });
        }
        continue;
      }
      if (
        [
          WorkflowRunState.SECTOR_MENU,
          WorkflowRunState.CONSENT,
          WorkflowRunState.FILLING,
          WorkflowRunState.REVIEW,
          WorkflowRunState.CORRECTION_FIELD,
          WorkflowRunState.SWITCH_CONFIRM,
          WorkflowRunState.APPOINTMENT_RESCHEDULE,
          WorkflowRunState.APPOINTMENT_CANCEL_CONFIRM,
        ].includes(run.state)
      ) {
        const result = await this.runs.update(
          { id: run.id, version: run.version, state: run.state, deadlineAt: LessThanOrEqual(now) },
          { state: WorkflowRunState.EXPIRED, openKey: null, draft: {}, context: {}, deadlineAt: now },
        );
        if (result.affected) {
          await this.slots.update(
            { heldByRunId: run.id, status: AppointmentSlotStatus.HELD },
            { status: AppointmentSlotStatus.AVAILABLE, heldByRunId: null, holdUntil: null },
          );
          const instance = run.instanceId ? await this.instances.findOneBy({ id: run.instanceId }) : null;
          output.push({
            sessionId: department.sessionId,
            chatId: run.chatId,
            text: this.message(
              instance,
              'flowExpired',
              'O prazo expirou. As respostas temporárias foram apagadas. Envie uma nova mensagem para começar novamente.',
            ),
          });
        }
      }
    }
    const reminderCandidates = await this.records.find({
      where: { status: WorkflowRecordStatus.VALID, reminderSentAt: IsNull() },
      relations: { instance: { department: true } },
      take: 100,
    });
    for (const record of reminderCandidates) {
      const days = record.instance.proactiveReminderDays;
      if (!days || record.validUntil > new Date(now.getTime() + days * 86_400_000) || record.validUntil <= now)
        continue;
      const result = await this.records.update({ id: record.id, reminderSentAt: IsNull() }, { reminderSentAt: now });
      if (result.affected)
        output.push({
          sessionId: record.instance.department.sessionId,
          chatId: record.contactId,
          text: `Seu cadastro em “${record.instance.name}” vencerá em breve. Envie uma mensagem e escolha esse fluxo para revisar e renovar seus dados.`,
        });
    }
    const appointmentReminders = await this.appointments.find({
      where: { status: AppointmentStatus.CONFIRMED, reminderSentAt: IsNull() },
      relations: { slot: true },
      take: 100,
    });
    for (const appointment of appointmentReminders) {
      if (appointment.slot.startsAt <= now) continue;
      const instance = await this.instances.findOne({
        where: { id: appointment.instanceId },
        relations: { department: true },
      });
      if (!instance) continue;
      const timezone = instance.department.timezone || 'America/Sao_Paulo';
      const current = this.zonedDateParts(now, timezone);
      const interview = this.zonedDateParts(appointment.slot.startsAt, timezone);
      if (current.date !== interview.date || current.hour < 8) continue;
      const claimed = await this.appointments.update(
        { id: appointment.id, reminderSentAt: IsNull(), status: AppointmentStatus.CONFIRMED },
        { reminderSentAt: now },
      );
      if (!claimed.affected) continue;
      try {
        await this.outbox.insert({
          sessionId: instance.department.sessionId,
          chatId: appointment.contactId,
          body: this.message(
            instance,
            'interviewReminder',
            '⏰ *Lembrete da sua entrevista*\nSua entrevista é *hoje, às {hora}*.\n\n{detalhes_agendamento}\n\nEsperamos por você! 😊',
            this.appointmentTemplateVariables(appointment.slot, timezone),
          ),
          dedupeKey: `appointment-reminder:${appointment.id}`,
          status: WorkflowOutboxStatus.PENDING,
          attempts: 0,
          maxAttempts: 3,
          nextAttemptAt: now,
        });
      } catch (error) {
        if (!String(error).toLowerCase().includes('unique')) throw error;
      }
    }
    return output;
  }

  private async startInstance(run: WorkflowRun, instance: WorkflowInstance, contactId: string): Promise<string[]> {
    if (!instance.currentVersionId) return ['Este fluxo ainda não possui uma versão publicada.'];
    const record = await this.findRecordForIdentity(instance.id, run.identityId, contactId);
    const recordContactId = record?.contactId ?? contactId;
    const currentDefinition = await this.versions.findOneByOrFail({ id: instance.currentVersionId });
    if (record && run.identityId && !record.identityId) {
      const storedCpf = currentDefinition.fields
        .filter(field => field.type === 'cpf')
        .map(field => {
          const value = record.data[this.answerKey(field)];
          return typeof value === 'string' ? value.replace(/\D/g, '') : '';
        })
        .find(value => value.length === 11);
      if (storedCpf) await this.bindWorkflowIdentityCpf(run, instance.departmentId, storedCpf);
      record.identityId = run.identityId;
      await this.records.save(record);
    }
    let schemaUpdateFields: string[] = [];
    if (
      record &&
      record.status === WorkflowRecordStatus.VALID &&
      record.validUntil > new Date() &&
      record.definitionVersionId !== instance.currentVersionId
    ) {
      const previousDefinition = record.definitionVersionId
        ? await this.versions.findOneBy({ id: record.definitionVersionId })
        : null;
      const reconciled = previousDefinition
        ? reconcileWorkflowRecordData(record.data, previousDefinition.fields, currentDefinition.fields)
        : { data: record.data, changed: false };
      record.data = reconciled.data;
      schemaUpdateFields = currentDefinition.fields
        .filter(field => field.customerEditable !== false)
        .filter(field => {
          const key = this.answerKey(field);
          // Legacy versions stored PULAR as null. Presence of the key still means the customer
          // explicitly answered; only an absent key or an empty string is incomplete.
          if (!(key in record.data) || record.data[key] === '') return true;
          const previous = previousDefinition?.fields.find(item => this.answerKey(item) === key);
          if (!previous) return Boolean(previousDefinition);
          return (
            previous.type !== field.type ||
            JSON.stringify(previous.options ?? []) !== JSON.stringify(field.options ?? [])
          );
        })
        .map(field => field.id);
      if (schemaUpdateFields.length) {
        const reachable = this.reachableSchemaUpdateFields(currentDefinition, record.data, schemaUpdateFields);
        schemaUpdateFields = schemaUpdateFields.filter(fieldId => reachable.has(fieldId));
        if (schemaUpdateFields.length) {
          // A relevant schema change renews the whole applicable questionnaire. Keeping only the
          // newly-added field made the confirmation screen look partial and hid the context of the
          // answers the customer was confirming again.
          schemaUpdateFields = currentDefinition.fields
            .filter(field => field.customerEditable !== false)
            .map(field => field.id);
        }
      }
      if (!schemaUpdateFields.length) {
        record.definitionVersionId = instance.currentVersionId;
        if (reconciled.changed) {
          record.currentVersion += 1;
          await this.dataSource.transaction(async manager => {
            await manager.getRepository(WorkflowRecord).save(record);
            await manager.getRepository(WorkflowRecordVersion).save({
              recordId: record.id,
              versionNumber: record.currentVersion,
              data: record.data,
              source: 'ATUALIZACAO_DE_ESTRUTURA',
              actorId: null,
            });
          });
        } else await this.records.save(record);
      }
    }
    run.instanceId = instance.id;
    run.versionId = instance.currentVersionId;
    run.step = 0;
    run.invalidAttempts = 0;
    run.draft = record && (record.validUntil <= new Date() || schemaUpdateFields.length) ? { ...record.data } : {};
    run.context =
      record && record.validUntil <= new Date()
        ? { mode: 'renewal' }
        : schemaUpdateFields.length
          ? { mode: 'schema_update', collectFieldIds: schemaUpdateFields }
          : {};
    run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
    run.state =
      record?.status === WorkflowRecordStatus.DELETION_PENDING
        ? WorkflowRunState.DELETION_PENDING
        : record && record.status === WorkflowRecordStatus.VALID && record.validUntil > new Date()
          ? schemaUpdateFields.length
            ? WorkflowRunState.CONSENT
            : WorkflowRunState.REGISTERED_MENU
          : WorkflowRunState.CONSENT;
    await this.runs.save(run);
    if (run.state === WorkflowRunState.DELETION_PENDING)
      return ['Seu cadastro está bloqueado enquanto a solicitação de exclusão aguarda decisão do administrador.'];
    if (run.state === WorkflowRunState.REGISTERED_MENU) return [await this.renderRecordMenu(instance, recordContactId)];
    const consentContext =
      run.context.mode === 'renewal'
        ? 'Seu cadastro venceu e precisa ser renovado. '
        : run.context.mode === 'schema_update'
          ? 'O cadastro recebeu novas perguntas e precisamos confirmar novamente todos os dados aplicáveis. '
          : '';
    return [
      this.message(
        instance,
        'consent',
        '{contexto}Para iniciar “{fluxo}”, precisamos tratar suas respostas conforme a finalidade deste cadastro. Você concorda? Responda SIM ou NÃO.',
        { contexto: consentContext },
      ),
    ];
  }

  private async handleField(
    run: WorkflowRun,
    instance: WorkflowInstance,
    version: WorkflowDefinitionVersion,
    answer: string,
    attachment?: { type: string; metadata?: Record<string, unknown>; messageId: string; waMessageId?: string },
  ): Promise<string[]> {
    const graph = this.workflowGraph(version);
    const currentGraphNode = graph
      ? graph.nodes.find(node => node.id === this.contextString(run, 'currentNodeId') && node.type === 'question')
      : undefined;
    if (/^voltar$/i.test(answer)) {
      if (graph && currentGraphNode) {
        const history = this.contextStringArray(run, 'graphHistory');
        const previousNodeId = history.at(-1);
        const previousNode = previousNodeId ? graph.nodes.find(node => node.id === previousNodeId) : undefined;
        const previousField = previousNode?.data.fieldId
          ? version.fields.find(item => item.id === previousNode.data.fieldId)
          : undefined;
        if (!previousNode || !previousField)
          return [
            `Você já está na primeira pergunta.\n\n${await this.renderQuestion(
              currentGraphNode.data.fieldId
                ? version.fields.find(item => item.id === currentGraphNode.data.fieldId)
                : undefined,
              instance.id,
              run.id,
            )}`,
          ];
        const draft = { ...run.draft };
        delete draft[this.answerKey(previousField)];
        run.draft = draft;
        run.step = version.fields.findIndex(item => item.id === previousField.id);
        run.context = { ...run.context, currentNodeId: previousNode.id, graphHistory: history.slice(0, -1) };
        run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
        await this.runs.save(run);
        return [await this.renderQuestion(previousField, instance.id, run.id)];
      }
      const previous = this.previousFieldIndex(
        version.fields,
        run.step - 1,
        run.draft,
        this.contextMode(run),
        this.contextFieldIds(run),
      );
      if (previous < 0)
        return [
          `Você já está na primeira pergunta.\n\n${await this.renderQuestion(version.fields[run.step], instance.id, run.id)}`,
        ];
      const previousField = version.fields[previous];
      const draft = { ...run.draft };
      delete draft[this.answerKey(previousField)];
      run.draft = draft;
      run.step = previous;
      run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
      await this.runs.save(run);
      return [await this.renderQuestion(previousField, instance.id, run.id)];
    }
    const field = currentGraphNode?.data.fieldId
      ? version.fields.find(item => item.id === currentGraphNode.data.fieldId)
      : version.fields[run.step];
    if (!field) return this.moveToReview(run, instance, version);
    let parsed = await this.parseField(field, answer, instance.id, run.id, instance.pdfMaxBytes, attachment);
    if (parsed.ok && parsed.value !== SKIPPED_VALUE && field.validationScript)
      parsed = this.runValidationScript(field.validationScript, parsed.value, run.draft);
    if (parsed.ok && field.type === 'cpf') {
      const normalizedCpf = typeof parsed.value === 'string' ? parsed.value.replace(/\D/g, '') : '';
      parsed = this.isValidCpf(normalizedCpf)
        ? { ok: true, value: normalizedCpf }
        : { ok: false, error: 'Informe um CPF válido.' };
    }
    if (!parsed.ok) {
      run.invalidAttempts += 1;
      await this.runs.save(run);
      if (run.invalidAttempts >= instance.invalidAttemptLimit) {
        return [
          `${parsed.error}\nVocê atingiu o limite de tentativas. Responda MENU para interromper ou envie novamente um valor válido.`,
        ];
      }
      return [`${parsed.error}\n\n${await this.renderQuestion(field, instance.id, run.id)}`];
    }
    if (field.type === 'cpf' && typeof parsed.value === 'string') {
      try {
        await this.bindWorkflowIdentityCpf(run, instance.departmentId, parsed.value);
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
        return [`${error.message}\n\n${await this.renderQuestion(field, instance.id, run.id)}`];
      }
      const linkedRecord = await this.findRecordForIdentity(instance.id, run.identityId, run.contactId);
      if (linkedRecord && linkedRecord.contactId !== run.contactId) {
        run.state = WorkflowRunState.REGISTERED_MENU;
        run.draft = {};
        run.context = {};
        run.invalidAttempts = 0;
        run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
        await this.runs.save(run);
        const menu = await this.renderRecordMenu(instance, linkedRecord.contactId);
        return [
          this.message(
            instance,
            'existingCpfLinked',
            'Este CPF já possui cadastro. O novo número foi vinculado com sucesso e nenhum cadastro duplicado foi criado.\n\n{menu}',
            { menu },
          ),
        ];
      }
    }
    run.draft = { ...run.draft, [this.answerKey(field)]: parsed.value };
    if (run.context.correcting === true) {
      run.context = { ...run.context, correcting: false };
      return this.moveToReview(run, instance, version);
    }
    if (graph && currentGraphNode) {
      run.invalidAttempts = 0;
      run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
      run.context = {
        ...run.context,
        graphHistory: [...this.contextStringArray(run, 'graphHistory'), currentGraphNode.id],
      };
      return this.advanceGraph(run, instance, version, currentGraphNode.id);
    }
    run.step = this.nextFieldIndex(
      version.fields,
      run.step + 1,
      run.draft,
      this.contextMode(run),
      this.contextFieldIds(run),
    );
    run.invalidAttempts = 0;
    run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
    if (run.step >= version.fields.length) return this.moveToReview(run, instance, version);
    await this.runs.save(run);
    return [await this.renderQuestion(version.fields[run.step], instance.id, run.id)];
  }

  private async handleReview(
    run: WorkflowRun,
    instance: WorkflowInstance,
    version: WorkflowDefinitionVersion,
    answer: string,
    contactId: string,
  ): Promise<string[]> {
    if (answer === '3' || /^encerrar$/i.test(answer)) {
      run.openKey = null;
      run.state = WorkflowRunState.CLOSED;
      run.draft = {};
      await this.runs.save(run);
      return ['Atendimento encerrado. Envie uma nova mensagem quando quiser começar novamente.'];
    }
    if (answer === '2' || /^corrigir$/i.test(answer)) {
      run.state = WorkflowRunState.CORRECTION_FIELD;
      await this.runs.save(run);
      return [`Qual dado deseja corrigir?\n${this.renderCorrectionMenu(version.fields, run.draft)}`];
    }
    if (!(answer === '1' || /^(confirmar|sim)$/i.test(answer))) {
      return ['Responda 1 para confirmar, 2 para corrigir ou 3 para encerrar.'];
    }
    const savedRecord = await this.dataSource.transaction(async manager => {
      const recordRepo = manager.getRepository(WorkflowRecord);
      const historyRepo = manager.getRepository(WorkflowRecordVersion);
      const consentRepo = manager.getRepository(WorkflowConsent);
      const slotRepo = manager.getRepository(WorkflowAppointmentSlot);
      const appointmentRepo = manager.getRepository(WorkflowAppointment);
      const department = await manager.getRepository(WorkflowDepartment).findOneByOrFail({ id: instance.departmentId });
      let record = run.identityId
        ? await recordRepo.findOne({
            where: { instanceId: instance.id, identityId: run.identityId },
            order: { updatedAt: 'DESC' },
          })
        : await recordRepo.findOne({ where: { instanceId: instance.id, contactId } });
      const nextVersion = (record?.currentVersion ?? 0) + 1;
      const validUntil = new Date();
      validUntil.setMonth(validUntil.getMonth() + instance.validityMonths);
      if (!record)
        record = recordRepo.create({
          instanceId: instance.id,
          identityId: run.identityId,
          contactId,
          validUntil,
          data: {},
        });
      else if (record.definitionVersionId && record.definitionVersionId !== version.id) {
        const previousDefinition = await manager
          .getRepository(WorkflowDefinitionVersion)
          .findOneBy({ id: record.definitionVersionId });
        if (previousDefinition)
          record.data = reconcileWorkflowRecordData(record.data, previousDefinition.fields, version.fields).data;
      }
      record.data = { ...record.data, ...run.draft };
      record.identityId = run.identityId;
      record.currentVersion = nextVersion;
      record.definitionVersionId = version.id;
      record.validUntil = validUntil;
      record.reminderSentAt = null;
      this.prepareRecordProximity(record, department);
      record = await recordRepo.save(record);
      await historyRepo.save(
        historyRepo.create({
          recordId: record.id,
          versionNumber: nextVersion,
          data: record.data,
          source:
            run.context.mode === 'update'
              ? 'ATUALIZACAO'
              : run.context.mode === 'renewal'
                ? 'RENOVACAO'
                : run.context.mode === 'schema_update'
                  ? 'ATUALIZACAO_DE_ESTRUTURA'
                  : 'CADASTRO',
          actorId: null,
        }),
      );
      await this.syncTalentPoolRegistration(manager, record, version, null);
      await consentRepo.save(
        consentRepo.create({
          recordId: record.id,
          instanceId: instance.id,
          contactId,
          text: 'Consentimento confirmado pelo WhatsApp.',
          termsVersion: String(version.versionNumber),
          purpose:
            run.context.mode === 'update' || run.context.mode === 'schema_update'
              ? 'ATUALIZACAO'
              : run.context.mode === 'renewal'
                ? 'RENOVACAO'
                : 'CADASTRO',
        }),
      );
      for (const field of version.fields.filter(item => item.type === 'appointment')) {
        const key = this.answerKey(field);
        const slotId = typeof run.draft[key] === 'string' ? String(run.draft[key]) : '';
        if (!slotId) continue;
        const selectedAppointment = await appointmentRepo.findOne({
          where: { slotId, instanceId: instance.id, contactId },
        });
        if (selectedAppointment?.status === AppointmentStatus.CONFIRMED) continue;
        const previousAppointments = await appointmentRepo.find({
          where: { instanceId: instance.id, contactId, status: AppointmentStatus.CONFIRMED },
          relations: { slot: true, record: true },
        });
        for (const previous of previousAppointments) {
          previous.status = AppointmentStatus.CANCELLED;
          previous.cancelledAt = new Date();
          await appointmentRepo.save(previous);
          await slotRepo
            .createQueryBuilder()
            .update()
            .set({
              bookedCount: () => 'CASE WHEN "bookedCount" > 0 THEN "bookedCount" - 1 ELSE 0 END',
              status: AppointmentSlotStatus.AVAILABLE,
            })
            .where('id = :id', { id: previous.slotId })
            .execute();
          await this.enqueueAppointmentOperatorNotification(
            manager,
            department.sessionId,
            instance,
            previous,
            previous.slot,
            'CANCELADA',
            department.timezone,
            previous.record,
          );
        }
        const claimed = await slotRepo
          .createQueryBuilder()
          .update()
          .set({
            bookedCount: () => '"bookedCount" + 1',
            status: () =>
              `CASE WHEN "bookedCount" + 1 >= "capacity" THEN '${AppointmentSlotStatus.CONFIRMED}' ELSE '${AppointmentSlotStatus.AVAILABLE}' END`,
            heldByRunId: null,
            holdUntil: null,
          })
          .where('id = :slotId', { slotId })
          .andWhere('instanceId = :instanceId', { instanceId: instance.id })
          .andWhere('status = :status', { status: AppointmentSlotStatus.AVAILABLE })
          .andWhere('"bookedCount" < "capacity"')
          .execute();
        if (!claimed.affected) throw new ConflictException('O horário selecionado não está mais disponível.');
        let confirmedAppointment: WorkflowAppointment;
        if (selectedAppointment) {
          selectedAppointment.status = AppointmentStatus.CONFIRMED;
          selectedAppointment.cancelledAt = null;
          selectedAppointment.recordId = record.id;
          selectedAppointment.reminderSentAt = null;
          confirmedAppointment = await appointmentRepo.save(selectedAppointment);
        } else {
          confirmedAppointment = await appointmentRepo.save(
            appointmentRepo.create({ slotId, instanceId: instance.id, contactId, recordId: record.id }),
          );
        }
        const confirmedSlot = await slotRepo.findOneByOrFail({ id: slotId, instanceId: instance.id });
        await this.syncRecruitmentApplication(
          manager,
          confirmedAppointment,
          this.recruitmentStatusForAppointment(confirmedAppointment, confirmedSlot),
          null,
          'APPOINTMENT_CONFIRMED',
          {
            appointmentStartsAt: confirmedSlot.startsAt.toISOString(),
            location: confirmedSlot.location,
          },
          confirmedAppointment.createdAt,
        );
        await this.enqueueAppointmentOperatorNotification(
          manager,
          department.sessionId,
          instance,
          confirmedAppointment,
          confirmedSlot,
          'CONFIRMADA',
          department.timezone,
          record,
        );
      }
      return record;
    });
    if (savedRecord.proximityStatus === WorkflowProximityStatus.PENDING)
      void this.processProximityRecord(savedRecord.id).catch(error =>
        this.logger.warn(`Candidate proximity dispatch failed recordId=${savedRecord.id}: ${this.errorName(error)}`),
      );
    run.state = WorkflowRunState.REGISTERED_MENU;
    run.draft = {};
    run.context = {};
    await this.runs.save(run);
    const confirmedAppointment = await this.findCurrentAppointment(instance.id, contactId);
    const department = confirmedAppointment ? await this.departments.findOneBy({ id: instance.departmentId }) : null;
    const appointmentDetails = confirmedAppointment
      ? `\n\n${this.renderAppointmentDetails(confirmedAppointment, department?.timezone || 'America/Sao_Paulo')}`
      : '';
    return [
      `${this.message(instance, 'completed', 'Dados confirmados e salvos.')}${appointmentDetails}\n\n${await this.renderRecordMenu(instance, contactId)}`,
    ];
  }

  private async handleRecordMenu(
    run: WorkflowRun,
    instance: WorkflowInstance,
    version: WorkflowDefinitionVersion,
    answer: string,
    contactId: string,
  ): Promise<string[]> {
    const menuActions = await this.availableRecordMenuActions(instance, contactId);
    const action = this.resolveRecordMenuAction(menuActions, answer);
    if (action === WorkflowRecordMenuAction.VIEW) {
      const record = await this.records.findOne({ where: { instanceId: instance.id, contactId } });
      return [
        record
          ? (await this.renderSummary(instance, version.fields, record.data)) +
            `\n\n${await this.renderRecordMenu(instance, contactId)}`
          : await this.renderRecordMenu(instance, contactId),
      ];
    }
    if (action === WorkflowRecordMenuAction.UPDATE) {
      const record = await this.records.findOne({ where: { instanceId: instance.id, contactId } });
      run.state = WorkflowRunState.CONSENT;
      run.context = { mode: 'update' };
      run.draft = { ...(record?.data ?? {}) };
      await this.runs.save(run);
      return [
        this.message(
          instance,
          'updateConsent',
          'Antes de atualizar seus dados em “{fluxo}”, precisamos registrar um novo consentimento. Você concorda? Responda SIM ou NÃO.',
        ),
      ];
    }
    if (action === WorkflowRecordMenuAction.VIEW_APPOINTMENT) {
      const appointment = await this.findCurrentAppointment(instance.id, contactId);
      if (!appointment)
        return [
          `Você não possui uma entrevista futura confirmada.\n\n${await this.renderRecordMenu(instance, contactId)}`,
        ];
      const department = await this.departments.findOneBy({ id: instance.departmentId });
      return [
        `${this.renderAppointmentDetails(appointment, department?.timezone || 'America/Sao_Paulo')}\n\n${await this.renderRecordMenu(instance, contactId)}`,
      ];
    }
    if (action === WorkflowRecordMenuAction.RESCHEDULE_APPOINTMENT) {
      const appointment = await this.findCurrentAppointment(instance.id, contactId);
      if (!appointment)
        return [
          `Você não possui uma entrevista futura confirmada.\n\n${await this.renderRecordMenu(instance, contactId)}`,
        ];
      const available = (await this.listAvailableSlots(instance.id)).filter(slot => slot.id !== appointment.slotId);
      if (!available.length)
        return [
          `Não há outro horário disponível para remarcação no momento.\n\n${await this.renderRecordMenu(instance, contactId)}`,
        ];
      const department = await this.departments.findOneBy({ id: instance.departmentId });
      const timezone = department?.timezone || 'America/Sao_Paulo';
      run.state = WorkflowRunState.APPOINTMENT_RESCHEDULE;
      run.context = { appointmentId: appointment.id };
      run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
      await this.runs.save(run);
      return [
        `Sua entrevista atual:\n${this.appointmentDetailsBlock(appointment.slot, timezone)}\n\nEscolha o novo horário:\n${this.renderAvailableAppointmentSlots(available, timezone)}\n\nResponda CANCELAR para voltar ao menu.`,
      ];
    }
    if (action === WorkflowRecordMenuAction.CANCEL_APPOINTMENT) {
      const appointment = await this.findCurrentAppointment(instance.id, contactId);
      if (!appointment)
        return [
          `Você não possui uma entrevista futura confirmada.\n\n${await this.renderRecordMenu(instance, contactId)}`,
        ];
      const department = await this.departments.findOneBy({ id: instance.departmentId });
      run.state = WorkflowRunState.APPOINTMENT_CANCEL_CONFIRM;
      run.context = { appointmentId: appointment.id };
      run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
      await this.runs.save(run);
      return [
        `Deseja realmente cancelar esta entrevista?\n${this.appointmentDetailsBlock(appointment.slot, department?.timezone || 'America/Sao_Paulo')}\n\nResponda SIM para cancelar ou NÃO para voltar ao menu.`,
      ];
    }
    if (action === WorkflowRecordMenuAction.HUMAN) {
      const department = await this.departments.findOneBy({ id: instance.departmentId });
      if (!department?.humanServiceEnabled)
        return [
          `O atendimento humano está indisponível no momento.\n\n${await this.renderRecordMenu(instance, contactId)}`,
        ];
      if (department && !this.isWithinSchedule(department.schedule, department.timezone, new Date())) {
        return [
          `O atendimento humano está fora do horário configurado.\n\n${await this.renderRecordMenu(instance, contactId)}`,
        ];
      }
      await this.startHumanTicket(run, instance);
      return [
        this.message(
          instance,
          'humanStarted',
          'Atendimento humano iniciado. O bot ficará em silêncio até o encerramento.',
        ),
      ];
    }
    if (action === WorkflowRecordMenuAction.CLOSE) {
      run.openKey = null;
      run.state = WorkflowRunState.CLOSED;
      await this.runs.save(run);
      return [
        this.message(
          instance,
          'conversationClosed',
          'Atendimento encerrado. O menu só será exibido quando você enviar uma nova mensagem.',
        ),
      ];
    }
    if (action === WorkflowRecordMenuAction.DELETE) {
      const record = await this.records.findOne({ where: { instanceId: instance.id, contactId } });
      if (!record) return [await this.renderRecordMenu(instance, contactId)];
      try {
        await this.deletionRequests.insert({
          recordId: record.id,
          openKey: record.id,
          status: DeletionRequestStatus.PENDING,
        });
      } catch {
        // Unique openKey makes duplicated WhatsApp events idempotent.
      }
      record.status = WorkflowRecordStatus.DELETION_PENDING;
      await this.records.save(record);
      run.state = WorkflowRunState.DELETION_PENDING;
      run.deadlineAt = new Date('9999-12-31T23:59:59.000Z');
      await this.runs.save(run);
      return [
        'Sua solicitação de exclusão foi registrada. O cadastro ficará bloqueado até a decisão do administrador.',
      ];
    }
    return [`Opção inválida.\n\n${await this.renderRecordMenu(instance, contactId)}`];
  }

  private async handleCustomerAppointmentCancellation(
    run: WorkflowRun,
    instance: WorkflowInstance,
    answer: string,
    contactId: string,
  ): Promise<string[]> {
    if (!this.isYes(answer)) {
      if (!/^(não|nao|n|voltar)$/i.test(answer.trim()))
        return ['Responda SIM para cancelar a entrevista ou NÃO para voltar ao menu.'];
      run.state = WorkflowRunState.REGISTERED_MENU;
      run.context = {};
      run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
      await this.runs.save(run);
      return [`Cancelamento não realizado.\n\n${await this.renderRecordMenu(instance, contactId)}`];
    }
    const appointmentId = this.contextString(run, 'appointmentId');
    const appointment = appointmentId
      ? await this.appointments.findOne({
          where: { id: appointmentId, instanceId: instance.id, contactId, status: AppointmentStatus.CONFIRMED },
          relations: { slot: true },
        })
      : null;
    if (!appointment) {
      run.state = WorkflowRunState.REGISTERED_MENU;
      run.context = {};
      await this.runs.save(run);
      return [`A entrevista já foi alterada.\n\n${await this.renderRecordMenu(instance, contactId)}`];
    }
    const department = await this.departments.findOneByOrFail({ id: instance.departmentId });
    await this.updateAppointmentStatus(
      department.sessionId,
      instance.id,
      appointment.id,
      AppointmentStatus.CANCELLED,
      null,
      false,
    );
    run.state = WorkflowRunState.REGISTERED_MENU;
    run.context = {};
    run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
    await this.runs.save(run);
    const message = this.message(
      instance,
      'interviewCancelled',
      '❌ *Sua entrevista foi cancelada*\n\n{detalhes_agendamento}\n\nEnvie uma nova mensagem para consultar os próximos horários disponíveis.',
      this.appointmentTemplateVariables(appointment.slot, department.timezone),
    );
    return [`${message}\n\n${await this.renderRecordMenu(instance, contactId)}`];
  }

  private async handleCustomerAppointmentReschedule(
    run: WorkflowRun,
    instance: WorkflowInstance,
    answer: string,
    contactId: string,
  ): Promise<string[]> {
    if (/^(cancelar|voltar)$/i.test(answer.trim())) {
      run.state = WorkflowRunState.REGISTERED_MENU;
      run.context = {};
      run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
      await this.runs.save(run);
      return [await this.renderRecordMenu(instance, contactId)];
    }
    const appointmentId = this.contextString(run, 'appointmentId');
    const current = appointmentId
      ? await this.appointments.findOne({
          where: { id: appointmentId, instanceId: instance.id, contactId, status: AppointmentStatus.CONFIRMED },
          relations: { slot: true },
        })
      : null;
    if (!current || current.slot.startsAt <= new Date()) {
      run.state = WorkflowRunState.REGISTERED_MENU;
      run.context = {};
      await this.runs.save(run);
      return [
        `A entrevista atual não está mais disponível para remarcação.\n\n${await this.renderRecordMenu(instance, contactId)}`,
      ];
    }
    const available = (await this.listAvailableSlots(instance.id)).filter(slot => slot.id !== current.slotId);
    if (!available.length) {
      run.state = WorkflowRunState.REGISTERED_MENU;
      run.context = {};
      await this.runs.save(run);
      return [
        `Não há outro horário disponível para remarcação no momento.\n\n${await this.renderRecordMenu(instance, contactId)}`,
      ];
    }
    const selected = available[Number(answer) - 1];
    const department = await this.departments.findOneBy({ id: instance.departmentId });
    const timezone = department?.timezone || 'America/Sao_Paulo';
    if (!selected) {
      return [
        `Escolha um dos horários disponíveis:\n${this.renderAvailableAppointmentSlots(available, timezone)}\n\nResponda CANCELAR para voltar ao menu.`,
      ];
    }
    const replacement = await this.rescheduleAppointment(
      department?.sessionId ?? '',
      instance.id,
      current.id,
      selected.id,
      null,
      false,
    );
    run.state = WorkflowRunState.REGISTERED_MENU;
    run.context = {};
    run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
    await this.runs.save(run);
    return [
      `${this.appointmentRescheduleMessage(instance, current.slot, replacement.slot, timezone)}\n\n${await this.renderRecordMenu(instance, contactId)}`,
    ];
  }

  private async moveToReview(
    run: WorkflowRun,
    instance: WorkflowInstance,
    version: WorkflowDefinitionVersion,
  ): Promise<string[]> {
    run.state = WorkflowRunState.REVIEW;
    run.context = { ...run.context, currentNodeId: undefined };
    await this.runs.save(run);
    const summary = await this.renderSummary(instance, version.fields, run.draft);
    return [
      this.message(
        instance,
        'review',
        'Confira suas respostas:\n\n{resumo}\n\n1. Confirmar\n2. Corrigir\n3. Encerrar',
        { resumo: summary },
      ),
    ];
  }

  private async handleCorrectionSelection(
    run: WorkflowRun,
    instance: WorkflowInstance,
    version: WorkflowDefinitionVersion,
    answer: string,
  ): Promise<string[]> {
    const visible = version.fields
      .filter(
        field =>
          field.customerVisible !== false &&
          !field.confidential &&
          field.customerEditable !== false &&
          this.answerKey(field) in run.draft &&
          this.isFieldVisible(field, run.draft, version.fields),
      )
      .filter(
        (field, index, fields) => fields.findIndex(item => this.answerKey(item) === this.answerKey(field)) === index,
      );
    const numeric = Number(answer) - 1;
    const selected =
      visible[numeric] ??
      visible.find(field => field.id.toLocaleLowerCase('pt-BR') === answer.toLocaleLowerCase('pt-BR'));
    if (!selected)
      return [`Escolha um dos campos apresentados.\n${this.renderCorrectionMenu(version.fields, run.draft)}`];
    run.step = version.fields.findIndex(field => field.id === selected.id);
    run.state = WorkflowRunState.FILLING;
    run.context = { ...run.context, correcting: true };
    run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
    await this.runs.save(run);
    return [await this.renderQuestion(selected, instance.id, run.id)];
  }

  private async parseField(
    field: WorkflowFieldDefinition,
    answer: string,
    instanceId: string,
    runId: string,
    pdfMaxBytes: number,
    attachment?: { type: string; metadata?: Record<string, unknown>; messageId: string; waMessageId?: string },
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    if (!field.required && /^pular$/i.test(answer)) return { ok: true, value: SKIPPED_VALUE };
    if (field.type === 'pdf') {
      const media = attachment?.metadata?.media as Record<string, unknown> | undefined;
      const mimetype = typeof media?.mimetype === 'string' ? media.mimetype : '';
      const filename = typeof media?.filename === 'string' ? media.filename : 'documento.pdf';
      const size = Number(media?.size ?? media?.fileSize ?? media?.filesize ?? 0);
      if (attachment?.type !== 'document' || (!mimetype.includes('pdf') && !filename.toLowerCase().endsWith('.pdf'))) {
        return { ok: false, error: 'Envie um documento no formato PDF.' };
      }
      if (size > pdfMaxBytes)
        return { ok: false, error: `O PDF excede o limite de ${Math.ceil(pdfMaxBytes / 1_048_576)} MB.` };
      return {
        ok: true,
        value: { messageId: attachment.messageId, waMessageId: attachment.waMessageId, filename, mimetype },
      };
    }
    if (!answer) return { ok: false, error: 'A resposta não pode ficar vazia.' };
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer))
      return { ok: false, error: 'Informe um e-mail válido.' };
    const digits = answer.replace(/\D/g, '');
    if (field.type === 'phone' && (digits.length < 10 || digits.length > 13))
      return { ok: false, error: 'Informe um telefone válido com DDD.' };
    if (field.type === 'cep' && digits.length !== 8)
      return { ok: false, error: 'Informe um CEP válido com 8 dígitos.' };
    if (field.type === 'cpf' && !this.isValidCpf(digits)) return { ok: false, error: 'Informe um CPF válido.' };
    if (field.type === 'cnpj' && !this.isValidCnpj(digits)) return { ok: false, error: 'Informe um CNPJ válido.' };
    if (field.type === 'cpf') return { ok: true, value: digits };
    if (field.type === 'date') {
      const normalized = this.parseDate(answer);
      if (!normalized) return { ok: false, error: 'Informe uma data válida no formato DD/MM/AAAA.' };
      return { ok: true, value: normalized };
    }
    if (field.type === 'number' || field.type === 'currency') {
      const value = Number(answer.replace(',', '.'));
      if (!Number.isFinite(value)) return { ok: false, error: 'Informe um número válido.' };
      if (field.min !== undefined && value < field.min) return { ok: false, error: `O valor mínimo é ${field.min}.` };
      if (field.max !== undefined && value > field.max) return { ok: false, error: `O valor máximo é ${field.max}.` };
      return { ok: true, value };
    }
    if (field.type === 'multiselect') {
      const indexes = answer.split(',').map(value => Number(value.trim()) - 1);
      const selected = [
        ...new Set(indexes.map(index => field.options?.[index]).filter((value): value is string => Boolean(value))),
      ];
      if (!selected.length || selected.length !== new Set(indexes).size)
        return { ok: false, error: 'Escolha uma ou mais opções, separando os números por vírgula.' };
      return { ok: true, value: selected };
    }
    if (field.type === 'consent') {
      if (!this.isYes(answer)) return { ok: false, error: 'É necessário responder SIM para continuar.' };
      return { ok: true, value: true };
    }
    if (field.type === 'select') {
      const index = Number(answer) - 1;
      const value =
        field.options?.[index] ??
        field.options?.find(option => option.toLocaleLowerCase('pt-BR') === answer.toLocaleLowerCase('pt-BR'));
      return value ? { ok: true, value } : { ok: false, error: 'Escolha uma das opções apresentadas.' };
    }
    if (field.type === 'appointment') {
      const slots = await this.listAvailableSlots(instanceId);
      const slot = slots[Number(answer) - 1];
      if (!slot) return { ok: false, error: 'Escolha um dos horários disponíveis.' };
      void runId;
      return { ok: true, value: slot.id };
    }
    if (field.min !== undefined && answer.length < field.min)
      return { ok: false, error: `Use pelo menos ${field.min} caracteres.` };
    if (field.max !== undefined && answer.length > field.max)
      return { ok: false, error: `Use no máximo ${field.max} caracteres.` };
    return { ok: true, value: answer };
  }

  private normalizeAdministrativeRecordValue(
    field: WorkflowFieldDefinition,
    input: unknown,
    answers: Record<string, unknown>,
  ): unknown {
    const empty = input === null || input === undefined || input === '';
    if (empty) {
      if (field.required) throw new BadRequestException(`O campo “${field.label}” é obrigatório.`);
      return undefined;
    }
    let value: unknown;
    if (field.type === 'number' || field.type === 'currency') {
      if (typeof input !== 'number' && typeof input !== 'string')
        throw new BadRequestException(`Informe um número válido em “${field.label}”.`);
      const number = typeof input === 'number' ? input : Number(String(input).replace(',', '.'));
      if (!Number.isFinite(number)) throw new BadRequestException(`Informe um número válido em “${field.label}”.`);
      if (field.min !== undefined && number < field.min)
        throw new BadRequestException(`O valor mínimo de “${field.label}” é ${field.min}.`);
      if (field.max !== undefined && number > field.max)
        throw new BadRequestException(`O valor máximo de “${field.label}” é ${field.max}.`);
      value = number;
    } else if (field.type === 'multiselect') {
      if (!Array.isArray(input)) throw new BadRequestException(`Selecione opções válidas em “${field.label}”.`);
      const selected = [...new Set(input.filter((item): item is string => typeof item === 'string'))];
      if (!selected.length && field.required) throw new BadRequestException(`O campo “${field.label}” é obrigatório.`);
      if (selected.some(item => !field.options?.includes(item)))
        throw new BadRequestException(`Uma opção de “${field.label}” não é mais válida.`);
      value = selected;
    } else if (field.type === 'select') {
      if (typeof input !== 'string' || !field.options?.includes(input))
        throw new BadRequestException(`Selecione uma opção válida em “${field.label}”.`);
      value = input;
    } else if (field.type === 'consent') {
      if (typeof input === 'boolean') value = input;
      else if (typeof input === 'string' && /^(sim|true|1)$/i.test(input.trim())) value = true;
      else if (typeof input === 'string' && /^(não|nao|false|0)$/i.test(input.trim())) value = false;
      else throw new BadRequestException(`Selecione Sim ou Não em “${field.label}”.`);
    } else if (field.type === 'date') {
      if (typeof input !== 'string') throw new BadRequestException(`Informe uma data válida em “${field.label}”.`);
      const text = input.trim();
      const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : this.parseDate(text);
      const parsed = normalized ? new Date(`${normalized}T00:00:00.000Z`) : null;
      if (!normalized || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized)
        throw new BadRequestException(`Informe uma data válida em “${field.label}”.`);
      value = normalized;
    } else {
      if (typeof input !== 'string') throw new BadRequestException(`Informe um texto válido em “${field.label}”.`);
      const text = input.trim();
      const digits = text.replace(/\D/g, '');
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
        throw new BadRequestException(`Informe um e-mail válido em “${field.label}”.`);
      if (field.type === 'phone' && (digits.length < 10 || digits.length > 13))
        throw new BadRequestException(`Informe um telefone válido com DDD em “${field.label}”.`);
      if (field.type === 'cep' && digits.length !== 8)
        throw new BadRequestException(`Informe um CEP válido com 8 dígitos em “${field.label}”.`);
      if (field.type === 'cpf' && !this.isValidCpf(digits))
        throw new BadRequestException(`Informe um CPF válido em “${field.label}”.`);
      if (field.type === 'cnpj' && !this.isValidCnpj(digits))
        throw new BadRequestException(`Informe um CNPJ válido em “${field.label}”.`);
      if (field.min !== undefined && text.length < field.min)
        throw new BadRequestException(`Use pelo menos ${field.min} caracteres em “${field.label}”.`);
      if (field.max !== undefined && text.length > field.max)
        throw new BadRequestException(`Use no máximo ${field.max} caracteres em “${field.label}”.`);
      value = field.type === 'cpf' ? digits : text;
    }
    if (field.validationScript) {
      const validated = this.runValidationScript(field.validationScript, value, answers);
      if (!validated.ok) throw new BadRequestException(validated.error);
      value = validated.value;
    }
    if (field.type === 'cpf') {
      const normalizedCpf = typeof value === 'string' ? value.replace(/\D/g, '') : '';
      if (!this.isValidCpf(normalizedCpf)) throw new BadRequestException(`Informe um CPF válido em “${field.label}”.`);
      value = normalizedCpf;
    }
    return value;
  }

  private workflowGraph(version: WorkflowDefinitionVersion): WorkflowGraphDefinition | null {
    if (!version.definition?.graph) return null;
    try {
      return this.validateGraphDefinition(version.definition.graph, version.fields);
    } catch {
      // A malformed definition from a backup made by an older/custom build must not strand an
      // active conversation. Published versions created here are validated before publication.
      return null;
    }
  }

  private validateVersionDefinition(
    definition: Record<string, unknown>,
    fields: WorkflowFieldDefinition[],
  ): WorkflowVersionDefinition {
    if (!this.isRecord(definition)) throw new BadRequestException('A definição visual do fluxo é inválida.');
    const next: WorkflowVersionDefinition = { ...definition };
    if (definition.graph !== undefined) next.graph = this.validateGraphDefinition(definition.graph, fields);
    this.assertSafeAnswerKeyReuse(fields, next.graph);
    return next;
  }

  private assertSafeAnswerKeyReuse(fields: WorkflowFieldDefinition[], graph?: WorkflowGraphDefinition): void {
    const groups = new Map<string, WorkflowFieldDefinition[]>();
    for (const field of fields) {
      const key = this.answerKey(field);
      groups.set(key, [...(groups.get(key) ?? []), field]);
    }
    const nodeByField = new Map(
      (graph?.nodes ?? [])
        .filter(node => node.type === 'question' && node.data.fieldId)
        .map(node => [node.data.fieldId!, node.id]),
    );
    const reachable = (source: string, target: string): boolean => {
      if (!graph) return true;
      const visited = new Set<string>();
      const pending = [source];
      while (pending.length) {
        const current = pending.pop()!;
        if (current === target) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const edge of graph.edges) if (edge.source === current) pending.push(edge.target);
      }
      return false;
    };
    const exclusiveConditions = (left: WorkflowFieldDefinition, right: WorkflowFieldDefinition): boolean =>
      Boolean(
        left.visibleWhen &&
        right.visibleWhen &&
        left.visibleWhen.fieldId === right.visibleWhen.fieldId &&
        left.visibleWhen.operator === 'equals' &&
        right.visibleWhen.operator === 'equals' &&
        JSON.stringify(left.visibleWhen.value) !== JSON.stringify(right.visibleWhen.value),
      );

    for (const [key, repeated] of groups) {
      if (repeated.length < 2) continue;
      for (let leftIndex = 0; leftIndex < repeated.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < repeated.length; rightIndex += 1) {
          const left = repeated[leftIndex];
          const right = repeated[rightIndex];
          if (exclusiveConditions(left, right)) continue;
          const leftNode = nodeByField.get(left.id);
          const rightNode = nodeByField.get(right.id);
          if (leftNode && rightNode && !reachable(leftNode, rightNode) && !reachable(rightNode, leftNode)) continue;
          throw new BadRequestException(
            `O campo de resposta ${key} está em perguntas que podem ocorrer no mesmo caminho. Use campos diferentes ou condições mutuamente exclusivas.`,
          );
        }
      }
    }
  }

  private validateGraphDefinition(value: unknown, fields: WorkflowFieldDefinition[]): WorkflowGraphDefinition {
    if (!this.isRecord(value) || value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges))
      throw new BadRequestException('O diagrama do fluxo possui um formato inválido.');
    if (value.nodes.length < 2 || value.nodes.length > 500)
      throw new BadRequestException('O diagrama deve possuir entre 2 e 500 blocos.');
    if (value.edges.length > 1000) throw new BadRequestException('O diagrama excede o limite de 1.000 conexões.');

    const allowedNodeTypes = new Set(['start', 'message', 'question', 'review']);
    const fieldIds = new Set(fields.map(field => field.id));
    const nodes: WorkflowGraphNode[] = value.nodes.map(raw => {
      if (!this.isRecord(raw) || !this.isRecord(raw.position) || !this.isRecord(raw.data))
        throw new BadRequestException('Existe um bloco inválido no diagrama.');
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const type = typeof raw.type === 'string' ? raw.type : '';
      const x = Number(raw.position.x);
      const y = Number(raw.position.y);
      if (
        !/^[A-Za-z0-9:_-]{1,120}$/.test(id) ||
        !allowedNodeTypes.has(type) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      )
        throw new BadRequestException('Existe um bloco com identificador, tipo ou posição inválida.');
      const data: WorkflowGraphNode['data'] = {};
      if (typeof raw.data.label === 'string') data.label = raw.data.label.trim().slice(0, 120);
      if (type === 'message') {
        if (typeof raw.data.text !== 'string' || !raw.data.text.trim())
          throw new BadRequestException('Todo bloco de mensagem precisa possuir um texto.');
        data.text = raw.data.text.trim().slice(0, 4000);
      }
      if (type === 'question') {
        if (typeof raw.data.fieldId !== 'string' || !fieldIds.has(raw.data.fieldId))
          throw new BadRequestException('Um bloco do diagrama aponta para uma pergunta inexistente.');
        data.fieldId = raw.data.fieldId;
      }
      return { id, type: type as WorkflowGraphNode['type'], position: { x, y }, data };
    });
    const nodeIds = new Set(nodes.map(node => node.id));
    if (nodeIds.size !== nodes.length) throw new BadRequestException('Os blocos do diagrama precisam de IDs únicos.');
    const startNodeId = typeof value.startNodeId === 'string' ? value.startNodeId : '';
    const startNodes = nodes.filter(node => node.type === 'start');
    const reviewNodes = nodes.filter(node => node.type === 'review');
    if (startNodes.length !== 1 || startNodes[0].id !== startNodeId || reviewNodes.length !== 1)
      throw new BadRequestException('O diagrama precisa ter exatamente um início e uma revisão final.');
    const questionFields = nodes.filter(node => node.type === 'question').map(node => node.data.fieldId);
    if (
      new Set(questionFields).size !== questionFields.length ||
      fields.some(field => !questionFields.includes(field.id))
    )
      throw new BadRequestException('Cada pergunta do fluxo deve aparecer exatamente uma vez no diagrama.');

    const allowedOperators = new Set(['equals', 'notEquals', 'contains', 'filled']);
    const edges: WorkflowGraphEdge[] = value.edges.map(raw => {
      if (!this.isRecord(raw)) throw new BadRequestException('Existe uma conexão inválida no diagrama.');
      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      const source = typeof raw.source === 'string' ? raw.source : '';
      const target = typeof raw.target === 'string' ? raw.target : '';
      if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id) || !nodeIds.has(source) || !nodeIds.has(target) || source === target)
        throw new BadRequestException('Existe uma conexão apontando para um bloco inválido.');
      let condition: WorkflowGraphEdge['condition'];
      if (raw.condition !== undefined) {
        if (!this.isRecord(raw.condition) || !allowedOperators.has(String(raw.condition.operator)))
          throw new BadRequestException('Existe uma condição inválida no diagrama.');
        if (
          raw.condition.operator !== 'filled' &&
          (raw.condition.value === undefined || raw.condition.value === null || raw.condition.value === '')
        )
          throw new BadRequestException('Toda saída condicional precisa informar a resposta esperada.');
        condition = {
          operator: raw.condition.operator as NonNullable<WorkflowGraphEdge['condition']>['operator'],
          ...(raw.condition.value !== undefined ? { value: raw.condition.value } : {}),
        };
      }
      return { id, source, target, ...(condition ? { condition } : {}) };
    });
    if (new Set(edges.map(edge => edge.id)).size !== edges.length)
      throw new BadRequestException('As conexões do diagrama precisam de IDs únicos.');

    for (const node of nodes) {
      const incoming = edges.filter(edge => edge.target === node.id);
      const outgoing = edges.filter(edge => edge.source === node.id);
      if (node.type === 'start' && incoming.length)
        throw new BadRequestException('O bloco inicial não pode receber conexões.');
      if (node.type !== 'start' && incoming.length === 0)
        throw new BadRequestException(`O bloco “${node.data.label || node.id}” não está conectado ao fluxo.`);
      if (node.type === 'review' && outgoing.length)
        throw new BadRequestException('A revisão final não pode iniciar outra conexão.');
      if (node.type !== 'review' && outgoing.filter(edge => !edge.condition).length !== 1)
        throw new BadRequestException(`O bloco “${node.data.label || node.id}” precisa de uma saída padrão.`);
      if (node.type !== 'question' && outgoing.some(edge => edge.condition))
        throw new BadRequestException('Somente perguntas podem possuir saídas condicionais.');
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const walk = (nodeId: string): void => {
      if (visiting.has(nodeId))
        throw new BadRequestException('O diagrama possui um ciclo e poderia repetir para sempre.');
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      for (const edge of edges.filter(item => item.source === nodeId)) walk(edge.target);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    walk(startNodeId);
    if (visited.size !== nodes.length) throw new BadRequestException('Existem blocos inacessíveis no diagrama.');
    return { version: 1, startNodeId, nodes, edges };
  }

  private async advanceGraph(
    run: WorkflowRun,
    instance: WorkflowInstance,
    version: WorkflowDefinitionVersion,
    fromNodeId: string,
  ): Promise<string[]> {
    const graph = this.workflowGraph(version);
    if (!graph) return this.moveToReview(run, instance, version);
    const replies: string[] = [];
    let cursor = fromNodeId;
    for (let guard = 0; guard <= graph.nodes.length; guard += 1) {
      const next = this.nextGraphNode(graph, cursor, run.draft, version.fields);
      if (!next || next.type === 'review') return [...replies, ...(await this.moveToReview(run, instance, version))];
      if (next.type === 'message') {
        if (next.data.text) replies.push(next.data.text);
        cursor = next.id;
        continue;
      }
      if (next.type === 'start') {
        cursor = next.id;
        continue;
      }
      const field = next.data.fieldId ? version.fields.find(item => item.id === next.data.fieldId) : undefined;
      if (!field || !this.shouldCollectGraphField(run, field, version.fields)) {
        cursor = next.id;
        continue;
      }
      run.step = version.fields.findIndex(item => item.id === field.id);
      run.state = WorkflowRunState.FILLING;
      run.context = { ...run.context, currentNodeId: next.id };
      run.deadlineAt = this.plusMinutes(new Date(), instance.flowTimeoutMinutes);
      await this.runs.save(run);
      replies.push(await this.renderQuestion(field, instance.id, run.id));
      return replies;
    }
    throw new BadRequestException('Não foi possível encontrar a próxima etapa do fluxo.');
  }

  private nextGraphNode(
    graph: WorkflowGraphDefinition,
    sourceId: string,
    answers: Record<string, unknown>,
    fields: WorkflowFieldDefinition[],
  ): WorkflowGraphNode | undefined {
    const source = graph.nodes.find(node => node.id === sourceId);
    const outgoing = graph.edges.filter(edge => edge.source === sourceId);
    const sourceField = source?.data.fieldId ? fields.find(field => field.id === source.data.fieldId) : undefined;
    const current = sourceField ? answers[this.answerKey(sourceField)] : undefined;
    const selected =
      outgoing.find(edge => edge.condition && this.matchesGraphCondition(edge.condition, current)) ??
      outgoing.find(edge => !edge.condition);
    return selected ? graph.nodes.find(node => node.id === selected.target) : undefined;
  }

  private matchesGraphCondition(condition: NonNullable<WorkflowGraphEdge['condition']>, current: unknown): boolean {
    if (condition.operator === 'filled')
      return current !== undefined && current !== null && current !== '' && current !== SKIPPED_VALUE;
    const left = this.valueText(current).toLocaleLowerCase('pt-BR');
    const right = this.valueText(condition.value).toLocaleLowerCase('pt-BR');
    if (condition.operator === 'contains')
      return Array.isArray(current)
        ? current.some(value => this.valueText(value).toLocaleLowerCase('pt-BR') === right)
        : left.includes(right);
    if (condition.operator === 'notEquals') return left !== right;
    return left === right;
  }

  private shouldCollectGraphField(
    run: WorkflowRun,
    field: WorkflowFieldDefinition,
    fields: WorkflowFieldDefinition[],
  ): boolean {
    if (!this.isFieldVisible(field, run.draft, fields)) return false;
    const collectFieldIds = this.contextStringArray(run, 'collectFieldIds');
    return this.contextMode(run) !== 'schema_update' || collectFieldIds.includes(field.id);
  }

  private reachableSchemaUpdateFields(
    version: WorkflowDefinitionVersion,
    answers: Record<string, unknown>,
    candidateFieldIds: string[],
  ): Set<string> {
    const graph = this.workflowGraph(version);
    const candidates = new Set(candidateFieldIds);
    const potentiallyVisible = (field: WorkflowFieldDefinition): boolean =>
      !field.visibleWhen ||
      candidates.has(field.visibleWhen.fieldId) ||
      this.isFieldVisible(field, answers, version.fields);
    if (!graph)
      return new Set(
        candidateFieldIds.filter(fieldId => {
          const field = version.fields.find(item => item.id === fieldId);
          return field ? potentiallyVisible(field) : false;
        }),
      );
    const reachable = new Set<string>();
    const visited = new Set<string>();
    const walk = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = graph.nodes.find(item => item.id === nodeId);
      if (!node) return;
      if (node.type === 'question' && node.data.fieldId) {
        const field = version.fields.find(item => item.id === node.data.fieldId);
        if (field && potentiallyVisible(field)) reachable.add(field.id);
      }
      const outgoing = graph.edges.filter(edge => edge.source === nodeId);
      if (node.type === 'question' && node.data.fieldId && candidates.has(node.data.fieldId)) {
        for (const edge of outgoing) walk(edge.target);
        return;
      }
      const next = this.nextGraphNode(graph, nodeId, answers, version.fields);
      if (next) walk(next.id);
    };
    walk(graph.startNodeId);
    return reachable;
  }

  private contextString(run: WorkflowRun, key: string): string | undefined {
    return typeof run.context[key] === 'string' ? run.context[key] : undefined;
  }

  private contextStringArray(run: WorkflowRun, key: string): string[] {
    return Array.isArray(run.context[key])
      ? run.context[key].filter((value): value is string => typeof value === 'string')
      : [];
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private async renderQuestion(
    field: WorkflowFieldDefinition | undefined,
    instanceId: string,
    runId: string,
  ): Promise<string> {
    if (!field) return 'Não há perguntas configuradas.';
    let suffix = field.required ? '' : '\nDigite PULAR para não responder.';
    let choices = '';
    if (field.type === 'select' || field.type === 'multiselect')
      choices = (field.options ?? [])
        .map((option, index) => (option === String(index + 1) ? option : `${index + 1}. ${option}`))
        .join('\n');
    if (field.type === 'consent') suffix += '\nResponda SIM para concordar.';
    if (field.type === 'appointment') {
      const slots = await this.listAvailableSlots(instanceId);
      const instance = await this.instances.findOne({ where: { id: instanceId }, relations: { department: true } });
      const timezone = instance?.department.timezone || 'America/Sao_Paulo';
      choices = slots.length
        ? slots
            .map(slot => ({ slot, remaining: Math.max(0, slot.capacity - slot.bookedCount) }))
            .map(({ slot, remaining }, index) =>
              `${index + 1}. ${slot.label || this.formatDateTime(slot.startsAt, timezone)} ${slot.location || ''} (${remaining} ${remaining === 1 ? 'vaga' : 'vagas'})`.trim(),
            )
            .join('\n')
        : 'Não há horários disponíveis no momento.';
    }
    const hasChoicesMarker = /\{(?:opções|opcoes)\}/i.test(field.prompt);
    const prompt = hasChoicesMarker ? placeWorkflowQuestionChoices(field.prompt, choices) : field.prompt;
    if (choices && !hasChoicesMarker) suffix += `\n${choices}`;
    void runId;
    return `${prompt}${suffix}\n\nDigite VOLTAR para retornar ou MENU para sair deste fluxo.`;
  }

  private listAvailableSlots(instanceId: string): Promise<WorkflowAppointmentSlot[]> {
    return this.slots.find({
      where: { instanceId, status: AppointmentSlotStatus.AVAILABLE, startsAt: MoreThan(new Date()) },
      order: { startsAt: 'ASC' },
      take: 20,
    });
  }

  private renderSectorMenu(department: WorkflowDepartment, instances: WorkflowInstance[]): string {
    const flows = instances.map((instance, index) => `${index + 1}. ${instance.name}`).join('\n');
    return this.templateMessage(
      department.messages,
      'sectorMenu',
      '*{setor}*\nEscolha um fluxo:\n{fluxos}\n\nVocê também pode enviar uma palavra-chave do fluxo.',
      { setor: department.name, fluxos: flows },
    );
  }

  private async renderRecordMenu(instance: WorkflowInstance, contactId: string): Promise<string> {
    const menu = this.recordMenu(instance);
    const title = menu.title || instance.name;
    const actions = await this.availableRecordMenuActions(instance, contactId);
    return `*${title}*\n${actions.map((item, index) => `${index + 1}. ${item.label}`).join('\n')}`;
  }

  private resolveRecordMenuAction(
    actions: WorkflowRecordMenuConfig['actions'],
    answer: string,
  ): WorkflowRecordMenuAction | null {
    const numeric = Number(answer);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= actions.length) return actions[numeric - 1].action;
    const normalized = answer.trim().toLocaleLowerCase('pt-BR');
    const byLabel = actions.find(item => item.label.trim().toLocaleLowerCase('pt-BR') === normalized);
    if (byLabel) return byLabel.action;
    const aliases: Array<[RegExp, WorkflowRecordMenuAction]> = [
      [/^(consultar|consultar dados|meus dados)$/i, WorkflowRecordMenuAction.VIEW],
      [/^(atualizar|atualizar dados)$/i, WorkflowRecordMenuAction.UPDATE],
      [
        /^(ver|visualizar|ver entrevista|visualizar entrevista|minha entrevista)$/i,
        WorkflowRecordMenuAction.VIEW_APPOINTMENT,
      ],
      [
        /^(remarcar|reagendar|remarcar entrevista|reagendar entrevista)$/i,
        WorkflowRecordMenuAction.RESCHEDULE_APPOINTMENT,
      ],
      [/^(cancelar|cancelar entrevista|desmarcar|desmarcar entrevista)$/i, WorkflowRecordMenuAction.CANCEL_APPOINTMENT],
      [/^(atendente|atendimento|atendimento humano|falar com atendente)$/i, WorkflowRecordMenuAction.HUMAN],
      [/^(encerrar|sair|fechar)$/i, WorkflowRecordMenuAction.CLOSE],
      [/^(excluir|apagar|solicitar exclusão)$/i, WorkflowRecordMenuAction.DELETE],
    ];
    return (
      aliases.find(
        ([pattern, candidate]) => actions.some(item => item.action === candidate) && pattern.test(answer),
      )?.[1] ?? null
    );
  }

  private recordMenu(instance: WorkflowInstance): WorkflowRecordMenuConfig {
    try {
      return this.normalizeRecordMenu(instance.recordMenu);
    } catch {
      return this.normalizeRecordMenu(DEFAULT_WORKFLOW_RECORD_MENU);
    }
  }

  private normalizeRecordMenu(menu?: WorkflowRecordMenuConfig): WorkflowRecordMenuConfig {
    const source = menu?.actions?.length ? menu : DEFAULT_WORKFLOW_RECORD_MENU;
    const seen = new Set<WorkflowRecordMenuAction>();
    const validActions = new Set(Object.values(WorkflowRecordMenuAction));
    const actions = source.actions.map(item => {
      if (!validActions.has(item.action)) throw new BadRequestException('O menu possui uma ação desconhecida.');
      if (seen.has(item.action)) throw new BadRequestException('A mesma ação não pode aparecer duas vezes no menu.');
      seen.add(item.action);
      const label = item.label?.trim();
      if (!label) throw new BadRequestException('Todas as ações do menu precisam de um nome.');
      return { action: item.action, label, enabled: item.enabled !== false };
    });
    if (!actions.some(item => item.enabled))
      throw new BadRequestException('Ative pelo menos uma ação no menu do fluxo.');
    for (const fallback of DEFAULT_WORKFLOW_RECORD_MENU.actions.filter(item =>
      [
        WorkflowRecordMenuAction.VIEW_APPOINTMENT,
        WorkflowRecordMenuAction.RESCHEDULE_APPOINTMENT,
        WorkflowRecordMenuAction.CANCEL_APPOINTMENT,
      ].includes(item.action),
    )) {
      if (!seen.has(fallback.action)) actions.push({ ...fallback });
    }
    return { title: menu?.title?.trim() ?? '', actions };
  }

  private async availableRecordMenuActions(
    instance: WorkflowInstance,
    contactId: string,
  ): Promise<WorkflowRecordMenuConfig['actions']> {
    const appointment = await this.findCurrentAppointment(instance.id, contactId);
    const department = await this.departments.findOneBy({ id: instance.departmentId });
    return this.recordMenu(instance).actions.filter(
      item =>
        item.enabled &&
        (department?.humanServiceEnabled !== false || item.action !== WorkflowRecordMenuAction.HUMAN) &&
        (appointment ||
          ![
            WorkflowRecordMenuAction.VIEW_APPOINTMENT,
            WorkflowRecordMenuAction.RESCHEDULE_APPOINTMENT,
            WorkflowRecordMenuAction.CANCEL_APPOINTMENT,
          ].includes(item.action)),
    );
  }

  private async findCurrentAppointment(instanceId: string, contactId: string): Promise<WorkflowAppointment | null> {
    const rows = await this.appointments.find({
      where: { instanceId, contactId, status: AppointmentStatus.CONFIRMED },
      relations: { slot: true },
      order: { createdAt: 'DESC' },
    });
    return rows.find(row => row.slot?.startsAt > new Date()) ?? null;
  }

  private renderAppointmentDetails(appointment: WorkflowAppointment, timezone: string): string {
    return `*Sua entrevista*\n${this.appointmentDetailsBlock(appointment.slot, timezone)}`;
  }

  private renderAvailableAppointmentSlots(slots: WorkflowAppointmentSlot[], timezone: string): string {
    return slots
      .map((slot, index) => {
        const remaining = Math.max(0, slot.capacity - slot.bookedCount);
        return `${index + 1}. ${slot.label || this.formatDateTime(slot.startsAt, timezone)}${
          slot.location ? ` — ${slot.location}` : ''
        } (${remaining} ${remaining === 1 ? 'vaga' : 'vagas'})`;
      })
      .join('\n');
  }

  private async renderSummary(
    instance: WorkflowInstance,
    fields: WorkflowFieldDefinition[],
    data: Record<string, unknown>,
  ): Promise<string> {
    const appointmentIds = fields
      .filter(field => field.type === 'appointment')
      .map(field => data[this.answerKey(field)])
      .filter((value): value is string => typeof value === 'string' && value !== SKIPPED_VALUE);
    const slots = appointmentIds.length
      ? await this.slots.find({ where: { id: In([...new Set(appointmentIds)]), instanceId: instance.id } })
      : [];
    const department = await this.departments.findOneBy({ id: instance.departmentId });
    const timezone = department?.timezone || 'America/Sao_Paulo';
    return fields
      .filter(
        field => field.customerVisible !== false && !field.confidential && this.isFieldVisible(field, data, fields),
      )
      .filter(
        (field, index, visible) => visible.findIndex(item => this.answerKey(item) === this.answerKey(field)) === index,
      )
      .map(field => {
        const value = data[this.answerKey(field)];
        if (field.type === 'appointment' && typeof value === 'string') {
          const slot = slots.find(item => item.id === value);
          if (slot) return this.appointmentDetailsBlock(slot, timezone);
        }
        return `*${field.label}:* ${this.displayFieldValue(field, value, slots, timezone)}`;
      })
      .join('\n');
  }

  private displayFieldValue(
    field: WorkflowFieldDefinition,
    value: unknown,
    slots: WorkflowAppointmentSlot[],
    timezone: string,
  ): string {
    if (value === SKIPPED_VALUE) return 'não informado (optou por pular)';
    if (value == null || value === '') return 'não informado';
    if (field.type === 'appointment' && typeof value === 'string') {
      const slot = slots.find(item => item.id === value);
      if (!slot) return 'horário não disponível';
      const date = this.zonedDateParts(slot.startsAt, timezone);
      return `${this.displayDate(date.date)} às ${date.time}${slot.location ? ` — ${slot.location}` : ''}`;
    }
    if (field.type === 'consent' || typeof value === 'boolean') return value ? 'Sim' : 'Não';
    if (field.type === 'pdf' && typeof value === 'object') {
      const filename = (value as Record<string, unknown>).filename;
      return typeof filename === 'string' && filename.trim() ? filename : 'PDF enviado';
    }
    if (field.type === 'date' && typeof value === 'string') {
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) return `${match[3]}/${match[2]}/${match[1]}`;
    }
    if (field.type === 'currency' && typeof value === 'number')
      return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
    return this.displayValue(value);
  }

  private renderCorrectionMenu(
    fields: WorkflowFieldDefinition[],
    data: Record<string, unknown>,
    editableOnly = false,
  ): string {
    return fields
      .filter(
        field =>
          field.customerVisible !== false &&
          !field.confidential &&
          (!editableOnly || field.customerEditable !== false) &&
          this.answerKey(field) in data &&
          this.isFieldVisible(field, data, fields),
      )
      .filter(
        (field, index, visible) => visible.findIndex(item => this.answerKey(item) === this.answerKey(field)) === index,
      )
      .map((field, index) => `${index + 1}. ${field.label}`)
      .join('\n');
  }

  private displayValue(value: unknown): string {
    if (value === SKIPPED_VALUE) return 'não informado (optou por pular)';
    if (value == null || value === '') return 'não informado';
    if (Array.isArray(value)) return value.join(', ');
    return this.valueText(value);
  }

  private message(
    instance: WorkflowInstance | null | undefined,
    key: string,
    fallback: string,
    variables: Record<string, unknown> = {},
  ): string {
    return this.templateMessage(instance?.messages, key, fallback, { fluxo: instance?.name ?? '', ...variables });
  }

  private templateMessage(
    messages: Record<string, string> | null | undefined,
    key: string,
    fallback: string,
    variables: Record<string, unknown>,
  ): string {
    const configured = completeWorkflowMessages(messages)[key];
    const defaultText = DEFAULT_WORKFLOW_MESSAGES[key] ?? fallback;
    const template = typeof configured === 'string' && configured.trim() ? configured.trim() : defaultText;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? this.valueText(variables[name]) : match,
    );
  }

  private normalizeMessages(messages: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(messages)
        .filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) && typeof value === 'string')
        .map(([key, value]): [string, string] => [key, value.trim().slice(0, 4000)])
        .filter(([, value]) => value.length > 0),
    );
  }

  private findInstance(instances: WorkflowInstance[], answer: string): WorkflowInstance | undefined {
    const numeric = Number(answer) - 1;
    if (Number.isInteger(numeric) && numeric >= 0) return instances[numeric];
    const normalized = answer.toLocaleLowerCase('pt-BR');
    return instances.find(instance => instance.keywords.includes(normalized));
  }

  private isYes(value: string): boolean {
    return /^(sim|s|aceito|concordo)$/i.test(value.trim());
  }

  private answerKey(field: WorkflowFieldDefinition): string {
    return field.answerKey?.trim() || field.id;
  }

  private isFieldVisible(
    field: WorkflowFieldDefinition,
    answers: Record<string, unknown>,
    fields: WorkflowFieldDefinition[] = [],
  ): boolean {
    const condition = field.visibleWhen;
    if (!condition) return true;
    const source = fields.find(item => item.id === condition.fieldId);
    const current = answers[source ? this.answerKey(source) : condition.fieldId];
    if (condition.operator === 'filled')
      return current !== undefined && current !== null && current !== '' && current !== SKIPPED_VALUE;
    if (condition.operator === 'contains')
      return Array.isArray(current)
        ? current.includes(condition.value)
        : this.valueText(current)
            .toLocaleLowerCase('pt-BR')
            .includes(this.valueText(condition.value).toLocaleLowerCase('pt-BR'));
    if (condition.operator === 'notEquals') return this.valueText(current) !== this.valueText(condition.value);
    return this.valueText(current) === this.valueText(condition.value);
  }

  private contextMode(run: WorkflowRun): string {
    return typeof run.context.mode === 'string' ? run.context.mode : 'registration';
  }

  private valueText(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    return JSON.stringify(value) ?? '';
  }

  private nextFieldIndex(
    fields: WorkflowFieldDefinition[],
    from: number,
    answers: Record<string, unknown>,
    mode: string,
    collectFieldIds: string[] = [],
  ): number {
    for (let index = Math.max(0, from); index < fields.length; index += 1) {
      const field = fields[index];
      if (mode === 'update' && field.customerEditable === false) continue;
      if (mode === 'schema_update' && !collectFieldIds.includes(field.id)) continue;
      if (this.isFieldVisible(field, answers, fields)) return index;
    }
    return fields.length;
  }

  private previousFieldIndex(
    fields: WorkflowFieldDefinition[],
    from: number,
    answers: Record<string, unknown>,
    mode: string,
    collectFieldIds: string[] = [],
  ): number {
    for (let index = Math.min(from, fields.length - 1); index >= 0; index -= 1) {
      const field = fields[index];
      if (mode === 'update' && field.customerEditable === false) continue;
      if (mode === 'schema_update' && !collectFieldIds.includes(field.id)) continue;
      if (this.isFieldVisible(field, answers, fields)) return index;
    }
    return -1;
  }

  private contextFieldIds(run: WorkflowRun): string[] {
    return Array.isArray(run.context.collectFieldIds)
      ? run.context.collectFieldIds.filter((value): value is string => typeof value === 'string')
      : [];
  }

  private parseDate(value: string): string | null {
    const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return null;
    const [, day, month, year] = match;
    const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    return date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() + 1 === Number(month) &&
      date.getUTCDate() === Number(day)
      ? `${year}-${month}-${day}`
      : null;
  }

  private isValidCpf(value: string): boolean {
    if (!/^\d{11}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
    const digit = (length: number) => {
      const sum = value
        .slice(0, length)
        .split('')
        .reduce((total, current, index) => total + Number(current) * (length + 1 - index), 0);
      const remainder = (sum * 10) % 11;
      return remainder === 10 ? 0 : remainder;
    };
    return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
  }

  private isValidCnpj(value: string): boolean {
    if (!/^\d{14}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
    const calculate = (length: number) => {
      const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const sum = value
        .slice(0, length)
        .split('')
        .reduce((total, current, index) => total + Number(current) * weights[index], 0);
      const remainder = sum % 11;
      return remainder < 2 ? 0 : 11 - remainder;
    };
    return calculate(12) === Number(value[12]) && calculate(13) === Number(value[13]);
  }

  private isWithinSchedule(schedule: WorkflowDepartment['schedule'], timezone: string, now: Date): boolean {
    if (!schedule?.weekdays || Object.values(schedule.weekdays).every(periods => !periods?.length)) return true;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || schedule.timezone || 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(now)
        .map(part => [part.type, part.value]),
    );
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const exception = schedule.exceptions?.find(item => item.date === date);
    if (exception?.closed) return false;
    const aliases: Record<string, string[]> = {
      Sun: ['0', 'sun', 'domingo'],
      Mon: ['1', 'mon', 'segunda'],
      Tue: ['2', 'tue', 'terca', 'terça'],
      Wed: ['3', 'wed', 'quarta'],
      Thu: ['4', 'thu', 'quinta'],
      Fri: ['5', 'fri', 'sexta'],
      Sat: ['6', 'sat', 'sabado', 'sábado'],
    };
    const periods = exception?.periods ?? aliases[parts.weekday]?.flatMap(key => schedule.weekdays[key] ?? []) ?? [];
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    return periods.some(period => {
      const toMinute = (value: string) => {
        const [hour, min] = value.split(':').map(Number);
        return hour * 60 + min;
      };
      return minute >= toMinute(period.start) && minute < toMinute(period.end);
    });
  }

  private zonedDateParts(value: Date, timezone: string): { date: string; time: string; hour: number } {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(value)
        .map(part => [part.type, part.value]),
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`,
      hour: Number(parts.hour),
    };
  }

  private displayDate(isoDate: string): string {
    const [year, month, day] = isoDate.split('-');
    return year && month && day ? `${day}/${month}/${year}` : isoDate;
  }

  private formatDateTime(value: Date, timezone: string): string {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(value);
  }

  private assertValidTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat('pt-BR', { timeZone: timezone }).format(new Date());
    } catch {
      throw new BadRequestException('Fuso horário inválido. Use um identificador como America/Sao_Paulo.');
    }
  }

  private assertValidSchedule(schedule: WorkflowDepartment['schedule']): void {
    this.assertValidTimezone(schedule.timezone || 'America/Sao_Paulo');
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const validatePeriods = (periods: Array<{ start: string; end: string }> | undefined) => {
      for (const period of periods ?? []) {
        if (!timePattern.test(period.start) || !timePattern.test(period.end) || period.start >= period.end)
          throw new BadRequestException('Horário de atendimento inválido. Use HH:mm e término posterior ao início.');
      }
    };
    for (const periods of Object.values(schedule.weekdays ?? {})) validatePeriods(periods);
    for (const exception of schedule.exceptions ?? []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.date))
        throw new BadRequestException('Data de exceção inválida. Use AAAA-MM-DD.');
      validatePeriods(exception.periods);
    }
    const locations = schedule.locations ?? [];
    if (!Array.isArray(locations) || locations.length > 100)
      throw new BadRequestException('Cadastre no máximo 100 locais por setor.');
    const locationIds = new Set<string>();
    const locationNames = new Set<string>();
    for (const location of locations) {
      if (
        !location ||
        typeof location.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(location.id) ||
        typeof location.name !== 'string' ||
        !location.name.trim() ||
        location.name.length > 160
      )
        throw new BadRequestException('Existe um local da agenda com identificador ou nome inválido.');
      if (locationIds.has(location.id)) throw new BadRequestException('Os locais da agenda precisam de IDs únicos.');
      locationIds.add(location.id);
      if ((location.internalName?.length ?? 0) > 160 || (location.address?.length ?? 0) > 500)
        throw new BadRequestException(`Os dados do local “${location.name}” excedem o tamanho permitido.`);
      const hasLatitude = location.latitude !== undefined;
      const hasLongitude = location.longitude !== undefined;
      if (hasLatitude !== hasLongitude)
        throw new BadRequestException(`Informe latitude e longitude juntas para o local “${location.name}”.`);
      if (
        (hasLatitude && (!Number.isFinite(location.latitude) || location.latitude! < -90 || location.latitude! > 90)) ||
        (hasLongitude &&
          (!Number.isFinite(location.longitude) || location.longitude! < -180 || location.longitude! > 180))
      )
        throw new BadRequestException(`As coordenadas do local “${location.name}” são inválidas.`);
      const normalizedName = (location.internalName?.trim() || location.name.trim()).toLocaleLowerCase('pt-BR');
      if (locationNames.has(normalizedName))
        throw new BadRequestException('Os locais da agenda precisam de nomes diferentes.');
      locationNames.add(normalizedName);
      if (location.mapsUrl) {
        let url: URL;
        try {
          url = new URL(location.mapsUrl);
        } catch {
          throw new BadRequestException(`O link do Google Maps de “${location.name}” é inválido.`);
        }
        if (!['http:', 'https:'].includes(url.protocol) || location.mapsUrl.length > 1000)
          throw new BadRequestException(`O link do Google Maps de “${location.name}” é inválido.`);
      }
      const contacts = location.notificationContacts ?? [];
      if (contacts.length > 20)
        throw new BadRequestException(`Cadastre no máximo 20 responsáveis para o local “${location.name}”.`);
      const phones = new Set<string>();
      for (const contact of contacts) {
        if (!contact.role || contact.role.length > 80)
          throw new BadRequestException(`Informe uma função válida para o responsável de “${location.name}”.`);
        if (!contact.name || contact.name.length > 120)
          throw new BadRequestException(`Informe o nome do responsável de “${location.name}”.`);
        if (!/^\d{1,3}$/.test(contact.ddi) || !/^\d{2,3}$/.test(contact.ddd) || !/^\d{6,10}$/.test(contact.number))
          throw new BadRequestException(
            `Informe DDI, DDD e número válidos para ${contact.name} em “${location.name}”.`,
          );
        const phone = `${contact.ddi}${contact.ddd}${contact.number}`;
        if (phones.has(phone))
          throw new BadRequestException(`Os responsáveis de “${location.name}” precisam ter telefones diferentes.`);
        phones.add(phone);
      }
    }
  }

  private runValidationScript(
    source: string,
    value: unknown,
    answers: Record<string, unknown>,
  ): { ok: true; value: unknown } | { ok: false; error: string } {
    try {
      const sandbox = {
        value: structuredClone(value),
        answers: Object.freeze(structuredClone(answers)),
        result: undefined as unknown,
      };
      const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
      new Script(`result = (function(value, answers) { "use strict"; ${source}\n})(value, answers);`).runInContext(
        context,
        { timeout: 500 },
      );
      const result = sandbox.result;
      if (result === false) return { ok: false, error: 'Resposta não aceita pela validação personalizada.' };
      if (result && typeof result === 'object') {
        const custom = result as { valid?: boolean; value?: unknown; error?: string };
        if (custom.valid === false) return { ok: false, error: custom.error || 'Resposta inválida.' };
        if ('value' in custom) return { ok: true, value: custom.value };
      }
      return { ok: true, value: result === undefined || result === true ? value : result };
    } catch {
      return { ok: false, error: 'A validação personalizada deste campo falhou. Avise o administrador.' };
    }
  }

  private async startHumanTicket(run: WorkflowRun, instance: WorkflowInstance): Promise<WorkflowTicket> {
    const now = new Date();
    const openKey = `${run.departmentId}:${run.chatId}`;
    return this.dataSource.transaction(async manager => {
      const departmentQuery = manager
        .getRepository(WorkflowDepartment)
        .createQueryBuilder('department')
        .where('department.id = :departmentId', { departmentId: run.departmentId });
      if (!['sqlite', 'better-sqlite3'].includes(String(manager.connection.options.type)))
        departmentQuery.setLock('pessimistic_write');
      const department = await departmentQuery.getOne();
      if (!department?.humanServiceEnabled)
        throw new ConflictException('O atendimento humano está indisponível no momento.');
      const runRepo = manager.getRepository(WorkflowRun);
      const ticketRepo = manager.getRepository(WorkflowTicket);
      const deadlineAt = this.plusMinutes(now, instance.humanInactivityMinutes);
      await runRepo.update({ id: run.id }, { state: WorkflowRunState.HUMAN, deadlineAt });
      let ticket = await ticketRepo.findOne({ where: { openKey } });
      if (!ticket) {
        ticket = await ticketRepo.save(
          ticketRepo.create({
            departmentId: run.departmentId,
            instanceId: instance.id,
            runId: run.id,
            contactId: run.contactId,
            chatId: run.chatId,
            openKey,
            status: WorkflowTicketStatus.ACTIVE,
            lastRelevantAt: now,
            deadlineAt,
          }),
        );
        await manager.getRepository(WorkflowTicketEvent).insert({
          ticketId: ticket.id,
          type: 'CREATED',
          actorId: null,
          metadata: {},
        });
      }
      run.state = WorkflowRunState.HUMAN;
      run.deadlineAt = deadlineAt;
      return ticket;
    });
  }

  private async resetTicketActivity(
    ticket: WorkflowTicket,
    type: string,
    actorId: string | null,
  ): Promise<WorkflowTicket> {
    if (!ticket.openKey) throw new ConflictException('O chamado já está encerrado.');
    const openKey = ticket.openKey;
    const instance = ticket.instance ?? (await this.instances.findOneByOrFail({ id: ticket.instanceId }));
    const now = new Date();
    const deadlineAt = this.plusMinutes(now, instance.humanInactivityMinutes);
    return this.dataSource.transaction(async manager => {
      const ticketRepo = manager.getRepository(WorkflowTicket);
      const claimed = await ticketRepo.update(
        { id: ticket.id, version: ticket.version, openKey },
        {
          status: WorkflowTicketStatus.ACTIVE,
          lastRelevantAt: now,
          deadlineAt,
          warningSentAt: null,
        },
      );
      if (!claimed.affected) throw new ConflictException('O chamado recebeu outra atualização. Tente novamente.');
      await manager
        .getRepository(WorkflowRun)
        .update({ id: ticket.runId }, { state: WorkflowRunState.HUMAN, deadlineAt });
      await manager.getRepository(WorkflowTicketEvent).insert({ ticketId: ticket.id, type, actorId, metadata: {} });
      return ticketRepo.findOneByOrFail({ id: ticket.id });
    });
  }

  private async transitionHumanToWarning(run: WorkflowRun, now: Date, graceMinutes: number): Promise<boolean> {
    return this.dataSource.transaction(async manager => {
      const ticketRepo = manager.getRepository(WorkflowTicket);
      const ticket = await ticketRepo.findOne({
        where: { runId: run.id, status: WorkflowTicketStatus.ACTIVE, deadlineAt: LessThanOrEqual(now) },
      });
      if (!ticket?.openKey) return false;
      const deadlineAt = this.plusMinutes(now, graceMinutes);
      const ticketResult = await ticketRepo.update(
        {
          id: ticket.id,
          version: ticket.version,
          status: WorkflowTicketStatus.ACTIVE,
          deadlineAt: LessThanOrEqual(now),
        },
        { status: WorkflowTicketStatus.IDLE_WARNING, warningSentAt: now, deadlineAt },
      );
      if (!ticketResult.affected) return false;
      const runResult = await manager
        .getRepository(WorkflowRun)
        .update(
          { id: run.id, version: run.version, state: WorkflowRunState.HUMAN, deadlineAt: LessThanOrEqual(now) },
          { state: WorkflowRunState.IDLE_WARNING, deadlineAt },
        );
      if (!runResult.affected) throw new ConflictException('A conversa recebeu atividade durante o aviso.');
      await manager.getRepository(WorkflowTicketEvent).insert({
        ticketId: ticket.id,
        type: 'INACTIVITY_WARNING',
        actorId: null,
        metadata: {},
      });
      return true;
    });
  }

  private async transitionWarningToClosed(run: WorkflowRun, now: Date): Promise<boolean> {
    return this.dataSource.transaction(async manager => {
      const ticketRepo = manager.getRepository(WorkflowTicket);
      const ticket = await ticketRepo.findOne({
        where: { runId: run.id, status: WorkflowTicketStatus.IDLE_WARNING, deadlineAt: LessThanOrEqual(now) },
      });
      if (!ticket?.openKey) return false;
      const ticketResult = await ticketRepo.update(
        {
          id: ticket.id,
          version: ticket.version,
          status: WorkflowTicketStatus.IDLE_WARNING,
          deadlineAt: LessThanOrEqual(now),
        },
        {
          status: WorkflowTicketStatus.CLOSED,
          openKey: null,
          closedAt: now,
          closeReason: WorkflowTicketCloseReason.INACTIVITY,
        },
      );
      if (!ticketResult.affected) return false;
      const runResult = await manager
        .getRepository(WorkflowRun)
        .update(
          { id: run.id, version: run.version, state: WorkflowRunState.IDLE_WARNING, deadlineAt: LessThanOrEqual(now) },
          { state: WorkflowRunState.CLOSED, openKey: null, draft: {}, deadlineAt: now },
        );
      if (!runResult.affected) throw new ConflictException('A conversa recebeu atividade antes do encerramento.');
      await manager.getRepository(WorkflowTicketEvent).insert({
        ticketId: ticket.id,
        type: WorkflowTicketCloseReason.INACTIVITY,
        actorId: null,
        metadata: {},
      });
      return true;
    });
  }

  private async addTicketEvent(
    ticketId: string,
    type: string,
    actorId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.ticketEvents.save(this.ticketEvents.create({ ticketId, type, actorId, metadata }));
  }

  private async requireTicket(
    sessionId: string,
    ticketId: string,
    allowedChats: string[] | null = null,
  ): Promise<WorkflowTicket> {
    const ticket = await this.tickets.findOne({
      where: { id: ticketId },
      relations: { department: true, instance: true },
    });
    if (!ticket || ticket.department.sessionId !== sessionId || !this.isChatAllowed(ticket.chatId, allowedChats))
      throw new NotFoundException('Chamado não encontrado.');
    return ticket;
  }

  private async releaseRunHolds(runId: string): Promise<void> {
    await this.slots.update(
      { heldByRunId: runId, status: AppointmentSlotStatus.HELD },
      { status: AppointmentSlotStatus.AVAILABLE, heldByRunId: null, holdUntil: null },
    );
  }

  private plusMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
  }

  private isChatAllowed(chatId: string, allowedChats: string[] | null, phone?: string | null): boolean {
    return isChatAllowedByScope(chatId, allowedChats, phone);
  }

  private async requireInstance(sessionId: string, id: string): Promise<WorkflowInstance> {
    const department = await this.getDepartment(sessionId);
    const row = await this.instances.findOne({ where: { id, departmentId: department.id } });
    if (!row) throw new NotFoundException('Fluxo não encontrado neste setor.');
    return row;
  }

  private validateFields(fields: WorkflowFieldDefinition[]): WorkflowFieldDefinition[] {
    const normalized = fields.map((field, index) => ({
      ...field,
      id: String(field.id).trim(),
      answerKey: field.answerKey ? String(field.answerKey).trim() : undefined,
      order: index + 1,
    }));
    const ids = new Set(normalized.map(field => field.id));
    if (ids.size !== normalized.length) throw new BadRequestException('Existem identificadores de campos duplicados.');
    const answerTypes = new Map<string, WorkflowFieldType>();
    return normalized.map(field => {
      if (!/^[a-z][a-z0-9_]{1,63}$/i.test(field.id)) throw new BadRequestException(`ID de campo inválido: ${field.id}`);
      const answerKey = this.answerKey(field);
      if (!/^[a-z][a-z0-9_]{1,63}$/i.test(answerKey))
        throw new BadRequestException(`Campo de resposta inválido: ${answerKey}`);
      const previousType = answerTypes.get(answerKey);
      if (previousType && previousType !== field.type)
        throw new BadRequestException(`O campo de resposta ${answerKey} está sendo usado com tipos diferentes.`);
      answerTypes.set(answerKey, field.type);
      if (!field.label?.trim() || !field.prompt?.trim())
        throw new BadRequestException(`Campo ${field.id} sem título ou pergunta.`);
      if (['select', 'multiselect'].includes(field.type)) {
        field.options = (field.options ?? []).map(option => String(option).trim()).filter(Boolean);
        if (!field.options.length) throw new BadRequestException(`Campo ${field.id} precisa de opções.`);
        if (new Set(field.options.map(option => option.toLocaleLowerCase('pt-BR'))).size !== field.options.length)
          throw new BadRequestException(`Campo ${field.id} possui opções repetidas.`);
      }
      if (field.talentPoolOption !== undefined) {
        field.talentPoolOption = String(field.talentPoolOption).trim();
        if (field.type !== 'select')
          throw new BadRequestException(`O Banco de Talentos só pode ser configurado em uma pergunta de seleção.`);
        if (!field.options?.includes(field.talentPoolOption))
          throw new BadRequestException(`A opção de Banco de Talentos do campo ${field.id} não existe.`);
      }
      if (field.visibleWhen) {
        const sourceIndex = normalized.findIndex(item => item.id === field.visibleWhen?.fieldId);
        const fieldIndex = normalized.findIndex(item => item.id === field.id);
        if (sourceIndex < 0 || sourceIndex >= fieldIndex)
          throw new BadRequestException(`A condição de ${field.label} deve depender de uma pergunta anterior.`);
      }
      if (field.validationScript) {
        try {
          new Script(`(function(value, answers) { "use strict"; ${field.validationScript}\n})`);
        } catch (error) {
          throw new BadRequestException(`Script inválido no campo ${field.id}: ${(error as Error).message}`);
        }
      }
      return field;
    });
  }

  private normalizeKeywords(values: string[] = []): string[] {
    return [...new Set(values.map(value => value.trim().toLocaleLowerCase('pt-BR')).filter(Boolean))].slice(0, 20);
  }

  private normalizeAppointmentNotificationNumbers(values: string[] = []): string[] {
    const normalized = values
      .map(value => value.replace(/\D/g, ''))
      .filter(value => value.length >= 10 && value.length <= 15);
    if (normalized.length !== values.length)
      throw new BadRequestException('Informe números válidos com DDI e DDD para as notificações da agenda.');
    return [...new Set(normalized)].slice(0, 20);
  }

  private normalizeAppointmentNotifications(
    values: Array<Partial<WorkflowAppointmentNotification>> = [],
  ): WorkflowAppointmentNotification[] {
    const allowedEvents = new Set<WorkflowAppointmentNotificationEvent>([
      'CONFIRMADA',
      'CANCELADA',
      'REAGENDADA',
      'CONCLUIDA',
    ]);
    const allowedPhases = new Set<WorkflowInterviewPhase>(Object.values(WorkflowInterviewPhase));
    const normalized = values.map((value, index) => {
      const ddi = String(value.ddi ?? '').replace(/\D/g, '');
      const ddd = String(value.ddd ?? '').replace(/\D/g, '');
      const number = String(value.number ?? '').replace(/\D/g, '');
      const events = [...new Set(value.events ?? [])].filter(event => allowedEvents.has(event));
      const locationIds = [...new Set(value.locationIds ?? [])].map(id => String(id).trim()).filter(Boolean);
      const interviewPhases = [...new Set(value.interviewPhases ?? [])].filter(phase => allowedPhases.has(phase));
      if (!/^\d{1,3}$/.test(ddi) || !/^\d{2,3}$/.test(ddd) || !/^\d{6,10}$/.test(number))
        throw new BadRequestException(`Informe DDI, DDD e número válidos no destinatário ${index + 1}.`);
      if (!events.length)
        throw new BadRequestException(`Selecione pelo menos um evento para o destinatário ${index + 1}.`);
      return {
        id: String(value.id ?? '').trim() || `notification-${ddi}${ddd}${number}`,
        name:
          String(value.name ?? '')
            .trim()
            .slice(0, 120) || `Gestor ${index + 1}`,
        ddi,
        ddd,
        number,
        events,
        locationIds,
        interviewPhases,
        enabled: value.enabled !== false,
      };
    });
    if (new Set(normalized.map(value => value.id)).size !== normalized.length)
      throw new BadRequestException('Cada destinatário precisa possuir um identificador único.');
    const phones = normalized.map(value => this.notificationPhone(value));
    if (new Set(phones).size !== phones.length)
      throw new BadRequestException(
        'O mesmo telefone não pode ser adicionado duas vezes. Marque todos os eventos nele.',
      );
    return normalized.slice(0, 20);
  }

  private notificationPhone(value: Pick<WorkflowAppointmentNotification, 'ddi' | 'ddd' | 'number'>): string {
    return `${value.ddi}${value.ddd}${value.number}`;
  }

  private normalizeLocationReference(value?: string | null): string {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLocaleLowerCase('pt-BR');
  }

  private interviewPhaseDisplayName(phase: WorkflowInterviewPhase): string {
    if (phase === WorkflowInterviewPhase.FOCUSED) return 'Entrevista teste';
    if (phase === WorkflowInterviewPhase.HIRING) return 'Entrevista com DP';
    return 'Entrevista simples';
  }

  private async uniqueSlug(departmentId: string, name: string): Promise<string> {
    const base =
      name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 90) || 'fluxo';
    let slug = base;
    for (let index = 2; await this.instances.exists({ where: { departmentId, slug } }); index += 1)
      slug = `${base}-${index}`;
    return slug;
  }
}
