import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { Session } from '../../session/entities/session.entity';

export type WorkflowFieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'number'
  | 'currency'
  | 'date'
  | 'cpf'
  | 'cnpj'
  | 'cep'
  | 'select'
  | 'multiselect'
  | 'consent'
  | 'pdf'
  | 'appointment';

export interface WorkflowFieldDefinition {
  id: string;
  /** Unique step identifier used by branching. Answers may share answerKey on exclusive branches. */
  answerKey?: string;
  label: string;
  prompt: string;
  type: WorkflowFieldType;
  required: boolean;
  order: number;
  options?: string[];
  /** Existing select option that routes the candidate to future opportunities instead of an open vacancy. */
  talentPoolOption?: string;
  min?: number;
  max?: number;
  confidential?: boolean;
  customerVisible?: boolean;
  customerEditable?: boolean;
  validationScript?: string;
  visibleWhen?: {
    fieldId: string;
    operator: 'equals' | 'notEquals' | 'contains' | 'filled';
    value?: unknown;
  };
}

export type WorkflowGraphNodeType = 'start' | 'message' | 'question' | 'review';

export interface WorkflowGraphNode {
  id: string;
  type: WorkflowGraphNodeType;
  position: { x: number; y: number };
  data: {
    label?: string;
    text?: string;
    fieldId?: string;
  };
}

export interface WorkflowGraphEdge {
  id: string;
  source: string;
  target: string;
  condition?: {
    operator: 'equals' | 'notEquals' | 'contains' | 'filled';
    value?: unknown;
  };
}

export interface WorkflowGraphDefinition {
  version: 1;
  startNodeId: string;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

export interface WorkflowVersionDefinition {
  graph?: WorkflowGraphDefinition;
  [key: string]: unknown;
}

export interface DepartmentSchedule {
  timezone: string;
  weekdays: Record<string, Array<{ start: string; end: string }>>;
  exceptions: Array<{ date: string; closed: boolean; periods?: Array<{ start: string; end: string }> }>;
  locations?: Array<{
    id: string;
    internalName?: string;
    name: string;
    address?: string;
    mapsUrl?: string;
    latitude?: number;
    longitude?: number;
    notificationContacts?: Array<{
      id: string;
      role: string;
      name: string;
      ddi: string;
      ddd: string;
      number: string;
      enabled: boolean;
    }>;
  }>;
}

export enum WorkflowProximityStatus {
  PENDING = 'PENDENTE',
  PROCESSING = 'PROCESSANDO',
  COMPLETED = 'CONCLUIDO',
  FAILED = 'FALHA',
  MISSING_DATA = 'SEM_DADOS',
}

export interface WorkflowProximityData {
  originAddress: string;
  originLatitude?: number;
  originLongitude?: number;
  destinationHash: string;
  results: Array<{
    posicao: number;
    locationId: string;
    nome: string;
    endereco: string;
    distanciaKm: number | null;
    tempoMinutos: number | null;
    routeAvailable: boolean;
  }>;
  errorCode?: string;
  calculatedAt?: string;
}

export interface WorkflowCandidateTableColumnPreference {
  /** Fixed column id (`name`, `contact`, ...) or `answer:<answerKey>`. */
  id: string;
  visible: boolean;
}

export type WorkflowAppointmentNotificationEvent = 'CONFIRMADA' | 'CANCELADA' | 'REAGENDADA' | 'CONCLUIDA';

export interface WorkflowAppointmentNotification {
  id: string;
  name: string;
  ddi: string;
  ddd: string;
  number: string;
  events: WorkflowAppointmentNotificationEvent[];
  /** Empty means every interview location. */
  locationIds: string[];
  /** Empty means every interview phase. */
  interviewPhases: WorkflowInterviewPhase[];
  enabled: boolean;
}

export enum WorkflowRecordMenuAction {
  VIEW = 'CONSULTAR_DADOS',
  UPDATE = 'ATUALIZAR_DADOS',
  VIEW_APPOINTMENT = 'VISUALIZAR_AGENDAMENTO',
  RESCHEDULE_APPOINTMENT = 'REMARCAR_AGENDAMENTO',
  CANCEL_APPOINTMENT = 'CANCELAR_AGENDAMENTO',
  HUMAN = 'ATENDIMENTO_HUMANO',
  CLOSE = 'ENCERRAR_ATENDIMENTO',
  DELETE = 'SOLICITAR_EXCLUSAO',
}

export interface WorkflowRecordMenuItem {
  action: WorkflowRecordMenuAction;
  label: string;
  enabled: boolean;
}

export interface WorkflowRecordMenuConfig {
  /** Empty means that the flow name is used. */
  title: string;
  actions: WorkflowRecordMenuItem[];
}

export const DEFAULT_WORKFLOW_RECORD_MENU: WorkflowRecordMenuConfig = {
  title: '',
  actions: [
    { action: WorkflowRecordMenuAction.VIEW, label: 'Consultar meus dados', enabled: true },
    { action: WorkflowRecordMenuAction.UPDATE, label: 'Atualizar meus dados', enabled: true },
    { action: WorkflowRecordMenuAction.VIEW_APPOINTMENT, label: 'Visualizar minha entrevista', enabled: true },
    { action: WorkflowRecordMenuAction.RESCHEDULE_APPOINTMENT, label: 'Remarcar minha entrevista', enabled: true },
    { action: WorkflowRecordMenuAction.CANCEL_APPOINTMENT, label: 'Cancelar minha entrevista', enabled: true },
    { action: WorkflowRecordMenuAction.HUMAN, label: 'Falar com atendimento humano', enabled: true },
    { action: WorkflowRecordMenuAction.CLOSE, label: 'Encerrar atendimento', enabled: true },
    { action: WorkflowRecordMenuAction.DELETE, label: 'Solicitar exclusão dos dados', enabled: true },
  ],
};

export enum WorkflowInstanceStatus {
  DRAFT = 'RASCUNHO',
  PUBLISHED = 'PUBLICADA',
  PAUSED = 'PAUSADA',
  ARCHIVED = 'ARQUIVADA',
}

export enum WorkflowVersionStatus {
  DRAFT = 'RASCUNHO',
  PUBLISHED = 'PUBLICADA',
  RETIRED = 'SUBSTITUIDA',
}

export enum WorkflowRunState {
  SECTOR_MENU = 'MENU_SETOR',
  SWITCH_CONFIRM = 'CONFIRMANDO_TROCA_FLUXO',
  CONSENT = 'AGUARDANDO_CONSENTIMENTO',
  FILLING = 'PREENCHIMENTO_EM_ANDAMENTO',
  REVIEW = 'REVISAO_FINAL',
  CORRECTION_FIELD = 'ESCOLHENDO_CAMPO_CORRECAO',
  REGISTERED_MENU = 'MENU_REGISTRO',
  APPOINTMENT_RESCHEDULE = 'REMARCANDO_AGENDAMENTO',
  APPOINTMENT_CANCEL_CONFIRM = 'CONFIRMANDO_CANCELAMENTO_AGENDAMENTO',
  HUMAN = 'EM_ATENDIMENTO_HUMANO',
  IDLE_WARNING = 'AVISO_DE_INATIVIDADE',
  EXPIRED = 'FLUXO_EXPIRADO',
  CLOSED = 'CHAT_ENCERRADO',
  DELETION_PENDING = 'PENDENTE_DE_EXCLUSAO',
}

export enum WorkflowRecordStatus {
  VALID = 'CADASTRO_VALIDO',
  EXPIRED = 'CADASTRO_VENCIDO',
  DELETION_PENDING = 'PENDENTE_DE_EXCLUSAO',
}

export enum AppointmentSlotStatus {
  AVAILABLE = 'DISPONIVEL',
  HELD = 'RESERVADO_TEMPORARIAMENTE',
  CONFIRMED = 'CONFIRMADO',
  BLOCKED = 'BLOQUEADO',
  COMPLETED = 'CONCLUIDO',
  REMOVED = 'REMOVIDO',
}

export enum AppointmentStatus {
  CONFIRMED = 'CONFIRMADO',
  CANCELLED = 'CANCELADO',
  COMPLETED = 'CONCLUIDO',
}

export enum WorkflowInterviewPhase {
  SIMPLE = 'FASE_1_ENTREVISTA_SIMPLES',
  FOCUSED = 'FASE_2_ENTREVISTA_FOCADA',
  HIRING = 'FASE_3_CONTRATACAO',
}

export enum WorkflowRecruitmentStatus {
  INTERVIEW_SCHEDULED = 'ENTREVISTA_MARCADA',
  EVALUATION = 'EM_AVALIACAO',
  APPROVED = 'APROVADO',
  SECOND_EVALUATION = 'EM_AVALIACAO_FASE_2',
  DOCUMENTATION = 'DOCUMENTACAO',
  HIRED = 'CONTRATADO',
  REJECTED = 'REPROVADO',
  NO_SHOW = 'NAO_COMPARECEU',
  WITHDRAWN = 'DESISTIU',
  CANCELLED = 'ENTREVISTA_CANCELADA',
}

export enum WorkflowTalentPoolStatus {
  AVAILABLE = 'DISPONIVEL',
  CONTACTED = 'CONTATADO',
  WAITING = 'AGUARDANDO_RESPOSTA',
  UNAVAILABLE = 'INDISPONIVEL',
  CONVERTED = 'CONVERTIDO_EM_CANDIDATO',
}

export enum DeletionRequestStatus {
  PENDING = 'PENDENTE',
  APPROVED = 'APROVADA',
  REJECTED = 'REJEITADA',
  CANCELLED = 'CANCELADA',
}

export enum WorkflowOutboxStatus {
  PENDING = 'PENDENTE',
  PROCESSING = 'PROCESSANDO',
  RETRYING = 'RETENTANDO',
  SENT = 'ENVIADA',
  FAILED = 'FALHA',
  CANCELLED = 'CANCELADA',
}

export enum WorkflowTicketStatus {
  WAITING = 'AGUARDANDO_ATENDENTE',
  ACTIVE = 'EM_ATENDIMENTO_HUMANO',
  IDLE_WARNING = 'AVISO_DE_INATIVIDADE',
  CLOSED = 'CHAMADO_ENCERRADO',
}

export enum WorkflowTicketCloseReason {
  MANUAL = 'ENCERRADO_MANUALMENTE',
  INACTIVITY = 'ENCERRADO_AUTOMATICAMENTE_POR_INATIVIDADE',
}

@Entity('workflow_departments')
@Index('UQ_workflow_department_session', ['sessionId'], { unique: true })
export class WorkflowDepartment {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() sessionId!: string;
  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_workflow_department_session' })
  session!: Session;
  @Column({ length: 120 }) name!: string;
  @Column({ default: true }) enabled!: boolean;
  @Column({ type: 'int', default: 10 }) menuTimeoutMinutes!: number;
  @Column({ type: jsonColumnType(), default: '{}' }) schedule!: DepartmentSchedule;
  @Column({ type: jsonColumnType(), default: '{}' }) messages!: Record<string, string>;
  @Column({ type: jsonColumnType(), default: '[]' })
  candidateTableColumns!: WorkflowCandidateTableColumnPreference[];
  @Column({ length: 80, default: 'America/Sao_Paulo' }) timezone!: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
  @Column({ default: true }) humanServiceEnabled!: boolean;
}

@Entity('workflow_identities')
@Index('UQ_workflow_identity_department_cpf', ['departmentId', 'cpf'], { unique: true })
export class WorkflowIdentity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() departmentId!: string;
  @ManyToOne(() => WorkflowDepartment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'departmentId', foreignKeyConstraintName: 'FK_workflow_identity_department' })
  department!: WorkflowDepartment;
  /** Digits-only CPF. Null while the person has only been identified by a WhatsApp contact. */
  @Column({ type: 'varchar', nullable: true }) cpf!: string | null;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_identity_contacts')
@Index('UQ_workflow_identity_contact_department_chat', ['departmentId', 'contactId'], { unique: true })
@Index('UQ_workflow_identity_contact_department_phone', ['departmentId', 'phone'], { unique: true })
export class WorkflowIdentityContact {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() departmentId!: string;
  @ManyToOne(() => WorkflowDepartment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'departmentId', foreignKeyConstraintName: 'FK_workflow_identity_contact_department' })
  department!: WorkflowDepartment;
  @Column() identityId!: string;
  @ManyToOne(() => WorkflowIdentity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'identityId', foreignKeyConstraintName: 'FK_workflow_identity_contact_identity' })
  identity!: WorkflowIdentity;
  /** WhatsApp address as received (`@c.us` or `@lid`). */
  @Column() contactId!: string;
  /** Canonical digits-only number when WhatsApp exposes the LID mapping. */
  @Column({ type: 'varchar', nullable: true }) phone!: string | null;
  @Column({ type: dateColumnType(), transformer: DateTransformer }) verifiedAt!: Date;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_instances')
@Index('UQ_workflow_instance_department_slug', ['departmentId', 'slug'], { unique: true })
@Index('IDX_workflow_instance_department_status', ['departmentId', 'status'])
export class WorkflowInstance {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() departmentId!: string;
  @ManyToOne(() => WorkflowDepartment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'departmentId', foreignKeyConstraintName: 'FK_workflow_instance_department' })
  department!: WorkflowDepartment;
  @Column({ length: 120 }) name!: string;
  @Column({ length: 100 }) slug!: string;
  @Column({ type: 'varchar', nullable: true }) description!: string | null;
  @Column({ type: 'varchar', default: WorkflowInstanceStatus.DRAFT }) status!: WorkflowInstanceStatus;
  @Column({ type: jsonColumnType(), default: '[]' }) keywords!: string[];
  @Column({ type: 'int', default: 30 }) flowTimeoutMinutes!: number;
  @Column({ type: 'int', default: 3 }) invalidAttemptLimit!: number;
  @Column({ type: 'int', default: 30 }) humanInactivityMinutes!: number;
  @Column({ type: 'int', default: 5 }) humanGraceMinutes!: number;
  @Column({ type: 'int', default: 12 }) validityMonths!: number;
  @Column({ type: 'int', default: 10485760 }) pdfMaxBytes!: number;
  @Column({ type: 'int', nullable: true }) proactiveReminderDays!: number | null;
  @Column({ type: jsonColumnType(), default: '[]' }) appointmentNotificationNumbers!: string[];
  @Column({ type: jsonColumnType(), default: '[]' })
  appointmentNotifications!: WorkflowAppointmentNotification[];
  @Column({ type: 'varchar', nullable: true }) currentVersionId!: string | null;
  @ManyToOne(() => WorkflowDefinitionVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'currentVersionId', foreignKeyConstraintName: 'FK_workflow_instance_current_version' })
  currentVersion!: WorkflowDefinitionVersion | null;
  @Column({ type: jsonColumnType(), default: '{}' }) messages!: Record<string, string>;
  @Column({ type: jsonColumnType(), default: '{}' }) recordMenu!: WorkflowRecordMenuConfig;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_versions')
@Index('UQ_workflow_version_instance_number', ['instanceId', 'versionNumber'], { unique: true })
export class WorkflowDefinitionVersion {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_version_instance' })
  instance!: WorkflowInstance;
  @Column({ type: 'int' }) versionNumber!: number;
  @Column({ type: 'varchar', default: WorkflowVersionStatus.DRAFT }) status!: WorkflowVersionStatus;
  @Column({ type: jsonColumnType(), default: '[]' }) fields!: WorkflowFieldDefinition[];
  @Column({ type: jsonColumnType(), default: '{}' }) definition!: WorkflowVersionDefinition;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) publishedAt!: Date | null;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_runs')
@Index('UQ_workflow_run_open_key', ['openKey'], { unique: true })
@Index('IDX_workflow_run_deadline', ['state', 'deadlineAt'])
@Index('IDX_workflow_runs_identity', ['identityId'])
export class WorkflowRun {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() departmentId!: string;
  @ManyToOne(() => WorkflowDepartment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'departmentId', foreignKeyConstraintName: 'FK_workflow_run_department' })
  department!: WorkflowDepartment;
  @Column({ type: 'varchar', nullable: true }) identityId!: string | null;
  @ManyToOne(() => WorkflowIdentity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'identityId', foreignKeyConstraintName: 'FK_workflow_run_identity' })
  identity!: WorkflowIdentity | null;
  @Column({ type: 'varchar', nullable: true }) instanceId!: string | null;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_run_instance' })
  instance!: WorkflowInstance | null;
  @Column({ type: 'varchar', nullable: true }) versionId!: string | null;
  @ManyToOne(() => WorkflowDefinitionVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'versionId', foreignKeyConstraintName: 'FK_workflow_run_version' })
  definitionVersion!: WorkflowDefinitionVersion | null;
  @Column() contactId!: string;
  @Column() chatId!: string;
  @Column({ type: 'varchar', nullable: true }) openKey!: string | null;
  @Column({ type: 'varchar' }) state!: WorkflowRunState;
  @Column({ type: 'int', default: 0 }) step!: number;
  @Column({ type: 'int', default: 0 }) invalidAttempts!: number;
  @Column({ type: jsonColumnType(), default: '{}' }) draft!: Record<string, unknown>;
  @Column({ type: jsonColumnType(), default: '{}' }) context!: Record<string, unknown>;
  @Column({ type: dateColumnType(), transformer: DateTransformer }) deadlineAt!: Date;
  @VersionColumn() version!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_records')
@Index('UQ_workflow_record_instance_contact', ['instanceId', 'contactId'], { unique: true })
@Index('IDX_workflow_record_proximity_due', ['proximityStatus', 'proximityNextAttemptAt'])
@Index('IDX_workflow_records_identity', ['identityId'])
export class WorkflowRecord {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_record_instance' })
  instance!: WorkflowInstance;
  @Column({ type: 'varchar', nullable: true }) identityId!: string | null;
  @ManyToOne(() => WorkflowIdentity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'identityId', foreignKeyConstraintName: 'FK_workflow_record_identity' })
  identity!: WorkflowIdentity | null;
  @Column() contactId!: string;
  @Column({ type: 'varchar', nullable: true }) phone!: string | null;
  @Column({ type: 'varchar', default: WorkflowRecordStatus.VALID }) status!: WorkflowRecordStatus;
  @Column({ type: jsonColumnType(), default: '{}' }) data!: Record<string, unknown>;
  @Column({ type: 'int', default: 1 }) currentVersion!: number;
  @Column({ type: 'varchar', nullable: true }) definitionVersionId!: string | null;
  @ManyToOne(() => WorkflowDefinitionVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'definitionVersionId', foreignKeyConstraintName: 'FK_workflow_record_definition_version' })
  definitionVersion!: WorkflowDefinitionVersion | null;
  @Column({ type: dateColumnType(), transformer: DateTransformer }) validUntil!: Date;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) reminderSentAt!: Date | null;
  @Column({ type: 'varchar', nullable: true }) proximityStatus!: WorkflowProximityStatus | null;
  @Column({ type: jsonColumnType(), nullable: true }) proximityData!: WorkflowProximityData | null;
  @Column({ type: 'int', default: 0 }) proximityAttempts!: number;
  /** Monotonic claim generation used to discard stale geocoding/routing results. */
  @Column({ type: 'int', default: 0 }) proximityRevision!: number;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  proximityNextAttemptAt!: Date | null;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_record_versions')
@Index('UQ_workflow_record_version', ['recordId', 'versionNumber'], { unique: true })
export class WorkflowRecordVersion {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() recordId!: string;
  @ManyToOne(() => WorkflowRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recordId', foreignKeyConstraintName: 'FK_workflow_record_version_record' })
  record!: WorkflowRecord;
  @Column({ type: 'int' }) versionNumber!: number;
  @Column({ type: jsonColumnType(), default: '{}' }) data!: Record<string, unknown>;
  @Column({ length: 40 }) source!: string;
  @Column({ type: 'varchar', nullable: true }) actorId!: string | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('workflow_record_ingest_events')
@Index('UQ_workflow_record_ingest_event_scope_key', ['instanceId', 'eventKey'], { unique: true })
export class WorkflowRecordIngestEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_record_ingest_event_instance' })
  instance!: WorkflowInstance;
  @Column({ length: 200 }) eventKey!: string;
  @Column({ length: 64 }) payloadHash!: string;
  @Column({ type: 'varchar', nullable: true }) recordId!: string | null;
  @ManyToOne(() => WorkflowRecord, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'recordId', foreignKeyConstraintName: 'FK_workflow_record_ingest_event_record' })
  record!: WorkflowRecord | null;
  @Column({ type: 'int', nullable: true }) versionNumber!: number | null;
  @Column() contactId!: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_consents')
@Index('IDX_workflow_consent_record_created', ['recordId', 'createdAt'])
export class WorkflowConsent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar', nullable: true }) recordId!: string | null;
  @ManyToOne(() => WorkflowRecord, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'recordId', foreignKeyConstraintName: 'FK_workflow_consent_record' })
  record!: WorkflowRecord | null;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_consent_instance' })
  instance!: WorkflowInstance;
  @Column() contactId!: string;
  @Column({ type: 'text' }) text!: string;
  @Column({ length: 40 }) termsVersion!: string;
  @Column({ length: 40 }) purpose!: string;
  @Column({ default: true }) accepted!: boolean;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('workflow_deletion_requests')
@Index('UQ_workflow_deletion_open_key', ['openKey'], { unique: true })
export class WorkflowDeletionRequest {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() recordId!: string;
  @ManyToOne(() => WorkflowRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recordId', foreignKeyConstraintName: 'FK_workflow_deletion_record' })
  record!: WorkflowRecord;
  @Column({ type: 'varchar', nullable: true }) openKey!: string | null;
  @Column({ type: 'varchar', default: DeletionRequestStatus.PENDING }) status!: DeletionRequestStatus;
  @Column({ type: 'varchar', nullable: true }) reason!: string | null;
  @Column({ type: 'varchar', nullable: true }) decidedBy!: string | null;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) decidedAt!: Date | null;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_appointment_slots')
@Index('IDX_workflow_slot_available', ['instanceId', 'status', 'startsAt'])
export class WorkflowAppointmentSlot {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_slot_instance' })
  instance!: WorkflowInstance;
  @Column({ type: dateColumnType(), transformer: DateTransformer }) startsAt!: Date;
  @Column({ type: 'varchar', nullable: true }) label!: string | null;
  /** Stable reference to a location stored in WorkflowDepartment.schedule.locations. */
  @Column({ type: 'varchar', nullable: true }) locationId!: string | null;
  @Column({ type: 'varchar', nullable: true }) location!: string | null;
  @Column({ type: 'varchar', nullable: true }) address!: string | null;
  @Column({ type: 'varchar', nullable: true }) instruction!: string | null;
  @Column({ type: 'varchar', nullable: true }) responsible!: string | null;
  @Column({ type: 'varchar', nullable: true }) mapsUrl!: string | null;
  @Column({ type: 'varchar', default: WorkflowInterviewPhase.SIMPLE }) interviewPhase!: WorkflowInterviewPhase;
  @Column({ type: 'int', default: 1 }) capacity!: number;
  @Column({ type: 'int', default: 0 }) bookedCount!: number;
  @Column({ type: 'varchar', default: AppointmentSlotStatus.AVAILABLE }) status!: AppointmentSlotStatus;
  @Column({ type: 'varchar', nullable: true }) heldByRunId!: string | null;
  @ManyToOne(() => WorkflowRun, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'heldByRunId', foreignKeyConstraintName: 'FK_workflow_slot_held_run' })
  heldByRun!: WorkflowRun | null;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) holdUntil!: Date | null;
  @VersionColumn() version!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_appointments')
@Index('UQ_workflow_appointment_slot_contact', ['slotId', 'contactId'], { unique: true })
export class WorkflowAppointment {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() slotId!: string;
  @ManyToOne(() => WorkflowAppointmentSlot, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'slotId', foreignKeyConstraintName: 'FK_workflow_appointment_slot' })
  slot!: WorkflowAppointmentSlot;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_appointment_instance' })
  instance!: WorkflowInstance;
  @Column() contactId!: string;
  @Column({ type: 'varchar', nullable: true }) recordId!: string | null;
  @ManyToOne(() => WorkflowRecord, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'recordId', foreignKeyConstraintName: 'FK_workflow_appointment_record' })
  record!: WorkflowRecord | null;
  @Column({ type: 'varchar', default: AppointmentStatus.CONFIRMED }) status!: AppointmentStatus;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) cancelledAt!: Date | null;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) reminderSentAt!: Date | null;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_recruitment_applications')
@Index('UQ_workflow_recruitment_instance_contact', ['instanceId', 'contactId'], { unique: true })
@Index('IDX_workflow_recruitment_instance_status', ['instanceId', 'status'])
export class WorkflowRecruitmentApplication {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_recruitment_instance' })
  instance!: WorkflowInstance;
  @Column() contactId!: string;
  @Column({ type: 'varchar', nullable: true }) recordId!: string | null;
  @ManyToOne(() => WorkflowRecord, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'recordId', foreignKeyConstraintName: 'FK_workflow_recruitment_record' })
  record!: WorkflowRecord | null;
  @Column({ type: 'varchar', nullable: true }) appointmentId!: string | null;
  @ManyToOne(() => WorkflowAppointment, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'appointmentId', foreignKeyConstraintName: 'FK_workflow_recruitment_appointment' })
  appointment!: WorkflowAppointment | null;
  @Column({ type: 'varchar', default: WorkflowRecruitmentStatus.INTERVIEW_SCHEDULED })
  status!: WorkflowRecruitmentStatus;
  @Column({ type: 'varchar', nullable: true }) owner!: string | null;
  @Column({ type: 'int', nullable: true }) rating!: number | null;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) nextActionAt!: Date | null;
  @VersionColumn() version!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_recruitment_events')
@Index('IDX_workflow_recruitment_event_application_created', ['applicationId', 'createdAt'])
export class WorkflowRecruitmentEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() applicationId!: string;
  @ManyToOne(() => WorkflowRecruitmentApplication, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'applicationId', foreignKeyConstraintName: 'FK_workflow_recruitment_event_application' })
  application!: WorkflowRecruitmentApplication;
  @Column({ length: 40 }) type!: string;
  @Column({ type: 'varchar', nullable: true }) fromStatus!: WorkflowRecruitmentStatus | null;
  @Column({ type: 'varchar', nullable: true }) toStatus!: WorkflowRecruitmentStatus | null;
  @Column({ type: 'varchar', nullable: true }) actorId!: string | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @Column({ type: jsonColumnType(), default: '{}' }) metadata!: Record<string, unknown>;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('workflow_talent_pool_entries')
@Index('UQ_workflow_talent_pool_record', ['recordId'], { unique: true })
@Index('IDX_workflow_talent_pool_instance_status', ['instanceId', 'status'])
export class WorkflowTalentPoolEntry {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_talent_pool_instance' })
  instance!: WorkflowInstance;
  @Column() recordId!: string;
  @ManyToOne(() => WorkflowRecord, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recordId', foreignKeyConstraintName: 'FK_workflow_talent_pool_record' })
  record!: WorkflowRecord;
  @Column() contactId!: string;
  @Column({ type: 'varchar', default: WorkflowTalentPoolStatus.AVAILABLE }) status!: WorkflowTalentPoolStatus;
  @Column({ type: 'varchar', nullable: true }) owner!: string | null;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) convertedAt!: Date | null;
  @VersionColumn() version!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_talent_pool_events')
@Index('IDX_workflow_talent_pool_event_entry_created', ['entryId', 'createdAt'])
export class WorkflowTalentPoolEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() entryId!: string;
  @ManyToOne(() => WorkflowTalentPoolEntry, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entryId', foreignKeyConstraintName: 'FK_workflow_talent_pool_event_entry' })
  entry!: WorkflowTalentPoolEntry;
  @Column({ length: 40 }) type!: string;
  @Column({ type: 'varchar', nullable: true }) fromStatus!: WorkflowTalentPoolStatus | null;
  @Column({ type: 'varchar', nullable: true }) toStatus!: WorkflowTalentPoolStatus | null;
  @Column({ type: 'varchar', nullable: true }) actorId!: string | null;
  @Column({ type: 'text', nullable: true }) note!: string | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('workflow_tickets')
@Index('UQ_workflow_ticket_open_key', ['openKey'], { unique: true })
@Index('IDX_workflow_ticket_deadline', ['status', 'deadlineAt'])
export class WorkflowTicket {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() departmentId!: string;
  @ManyToOne(() => WorkflowDepartment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'departmentId', foreignKeyConstraintName: 'FK_workflow_ticket_department' })
  department!: WorkflowDepartment;
  @Column() instanceId!: string;
  @ManyToOne(() => WorkflowInstance, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'instanceId', foreignKeyConstraintName: 'FK_workflow_ticket_instance' })
  instance!: WorkflowInstance;
  @Column() runId!: string;
  @ManyToOne(() => WorkflowRun, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'runId', foreignKeyConstraintName: 'FK_workflow_ticket_run' })
  run!: WorkflowRun;
  @Column() contactId!: string;
  @Column() chatId!: string;
  @Column({ type: 'varchar', nullable: true }) openKey!: string | null;
  @Column({ type: 'varchar', default: WorkflowTicketStatus.WAITING }) status!: WorkflowTicketStatus;
  @Column({ type: dateColumnType(), transformer: DateTransformer }) lastRelevantAt!: Date;
  @Column({ type: dateColumnType(), transformer: DateTransformer }) deadlineAt!: Date;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) warningSentAt!: Date | null;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) closedAt!: Date | null;
  @Column({ type: 'varchar', nullable: true }) closeReason!: WorkflowTicketCloseReason | null;
  @VersionColumn({ default: 1 }) version!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('workflow_ticket_events')
@Index('IDX_workflow_ticket_event_ticket_created', ['ticketId', 'createdAt'])
export class WorkflowTicketEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() ticketId!: string;
  @ManyToOne(() => WorkflowTicket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticketId', foreignKeyConstraintName: 'FK_workflow_ticket_event_ticket' })
  ticket!: WorkflowTicket;
  @Column({ length: 80 }) type!: string;
  @Column({ type: 'varchar', nullable: true }) actorId!: string | null;
  @Column({ type: jsonColumnType(), default: '{}' }) metadata!: Record<string, unknown>;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('workflow_privacy_events')
@Index('IDX_workflow_privacy_event_instance_created', ['instanceId', 'createdAt'])
export class WorkflowPrivacyEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() instanceId!: string;
  @Column({ length: 80 }) type!: string;
  @Column({ length: 64 }) anonymousSubjectHash!: string;
  @Column({ type: 'varchar', nullable: true }) actorId!: string | null;
  @Column({ type: jsonColumnType(), default: '{}' }) metadata!: Record<string, unknown>;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('workflow_outbox')
@Index('UQ_workflow_outbox_dedupe', ['dedupeKey'], { unique: true })
@Index('IDX_workflow_outbox_due', ['status', 'nextAttemptAt'])
export class WorkflowOutboxMessage {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() sessionId!: string;
  @Column() chatId!: string;
  @Column({ type: 'text' }) body!: string;
  @Column({ length: 160 }) dedupeKey!: string;
  @Column({ type: 'varchar', default: WorkflowOutboxStatus.PENDING }) status!: WorkflowOutboxStatus;
  @Column({ type: 'int', default: 0 }) attempts!: number;
  @Column({ type: 'int', default: 3 }) maxAttempts!: number;
  @Column({ type: dateColumnType(), transformer: DateTransformer }) nextAttemptAt!: Date;
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer }) sentAt!: Date | null;
  @Column({ type: 'text', nullable: true }) lastError!: string | null;
  @VersionColumn() version!: number;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}
