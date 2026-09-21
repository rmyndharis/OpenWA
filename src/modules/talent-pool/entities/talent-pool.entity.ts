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
import { Session } from '../../session/entities/session.entity';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export type TalentFieldType = 'text' | 'email' | 'number' | 'date' | 'select' | 'multiselect' | 'pdf';

export interface TalentFieldDefinition {
  id: string;
  label: string;
  prompt: string;
  type: TalentFieldType;
  required: boolean;
  enabled: boolean;
  order: number;
  options?: string[];
  min?: number;
  max?: number;
}

export enum TalentCandidateStatus {
  VALID = 'CADASTRO_VALIDO',
  INACTIVE = 'CADASTRO_INATIVO',
}

export enum TalentFlowState {
  REGISTRATION = 'CADASTRO_EM_ANDAMENTO',
  REGISTRATION_EXPIRED = 'CADASTRO_EXPIRADO',
  MENU = 'MENU_CLIENTE',
  UPDATE_FIELD = 'ATUALIZACAO_ESCOLHENDO_CAMPO',
  UPDATE_VALUE = 'ATUALIZACAO_COLETANDO_VALOR',
  UPDATE_CONFIRM = 'ATUALIZACAO_AGUARDANDO_CONFIRMACAO',
  CHAT_CLOSED = 'CHAT_ENCERRADO',
}

export enum TalentTicketStatus {
  WAITING = 'AGUARDANDO_ATENDENTE',
  HUMAN = 'EM_ATENDIMENTO_HUMANO',
  IDLE_WARNING = 'AVISO_DE_INATIVIDADE',
  CLOSED = 'CHAMADO_ENCERRADO',
}

export enum TalentTicketCloseReason {
  AUTOMATIC_INACTIVITY = 'ENCERRADO_AUTOMATICAMENTE_POR_INATIVIDADE',
  MANUAL = 'ENCERRADO_MANUALMENTE',
}

@Entity('talent_pool_settings')
@Index('UQ_talent_pool_settings_session', ['sessionId'], { unique: true })
export class TalentPoolSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_talent_settings_session' })
  session!: Session;

  @Column({ default: false })
  enabled!: boolean;

  @Column({ type: jsonColumnType(), default: '[]' })
  fields!: TalentFieldDefinition[];

  @Column({ type: 'int', default: 30 })
  registrationTimeoutMinutes!: number;

  @Column({ type: 'int', default: 30 })
  updateTimeoutMinutes!: number;

  @Column({ type: 'int', default: 30 })
  menuTimeoutMinutes!: number;

  @Column({ type: 'int', default: 30 })
  humanInactivityMinutes!: number;

  @Column({ type: 'int', default: 5 })
  humanGraceMinutes!: number;

  @Column({ length: 100, default: 'RH' })
  queueName!: string;

  @Column({ type: jsonColumnType(), default: '{}' })
  messages!: Record<string, string>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity('talent_candidates')
@Index('UQ_talent_candidates_session_contact', ['sessionId', 'contactId'], { unique: true })
export class TalentCandidate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_talent_candidate_session' })
  session!: Session;

  @Column()
  contactId!: string;

  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', default: TalentCandidateStatus.VALID })
  status!: TalentCandidateStatus;

  @Column({ type: jsonColumnType(), default: '{}' })
  data!: Record<string, unknown>;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  validUntil!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity('talent_flow_sessions')
@Index('UQ_talent_flow_session_contact', ['sessionId', 'contactId'], { unique: true })
@Index('IDX_talent_flow_deadline', ['deadlineAt'])
export class TalentFlowSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_talent_flow_session' })
  session!: Session;

  @Column()
  contactId!: string;

  @Column()
  chatId!: string;

  @Column({ type: 'varchar', nullable: true })
  candidateId!: string | null;

  @ManyToOne(() => TalentCandidate, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'candidateId', foreignKeyConstraintName: 'FK_talent_flow_candidate' })
  candidate!: TalentCandidate | null;

  @Column({ type: 'varchar' })
  state!: TalentFlowState;

  @Column({ type: 'int', default: 0 })
  step!: number;

  @Column({ type: jsonColumnType(), default: '{}' })
  draft!: Record<string, unknown>;

  @Column({ type: 'varchar', nullable: true })
  lastMessageId!: string | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  deadlineAt!: Date;

  @VersionColumn()
  version!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity('talent_tickets')
@Index('UQ_talent_tickets_open_key', ['openKey'], { unique: true })
@Index('IDX_talent_tickets_due', ['status', 'nextActionAt'])
export class TalentTicket {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_talent_ticket_session' })
  session!: Session;

  @Column()
  candidateId!: string;

  @ManyToOne(() => TalentCandidate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'candidateId', foreignKeyConstraintName: 'FK_talent_ticket_candidate' })
  candidate!: TalentCandidate;

  @Column()
  contactId!: string;

  @Column()
  chatId!: string;

  /** Non-null only while open; UNIQUE enforces one open ticket per contact on SQLite and PostgreSQL. */
  @Column({ type: 'varchar', nullable: true })
  openKey!: string | null;

  @Column({ type: 'varchar', default: TalentTicketStatus.WAITING })
  status!: TalentTicketStatus;

  @Column({ length: 100, default: 'RH' })
  queueName!: string;

  @Column({ type: 'varchar', nullable: true })
  assigneeApiKeyId!: string | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  lastRelevantAt!: Date;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  nextActionAt!: Date;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  warnedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  closedAt!: Date | null;

  @Column({ type: 'varchar', nullable: true })
  closeReason!: TalentTicketCloseReason | null;

  @VersionColumn()
  version!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity('talent_ticket_events')
@Index('IDX_talent_ticket_events_ticket_created', ['ticketId', 'createdAt'])
export class TalentTicketEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  ticketId!: string;

  @ManyToOne(() => TalentTicket, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticketId', foreignKeyConstraintName: 'FK_talent_event_ticket' })
  ticket!: TalentTicket;

  @Column()
  type!: string;

  @Column({ type: 'varchar', nullable: true })
  actorId!: string | null;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity('talent_processed_messages')
@Index('UQ_talent_processed_session_message', ['sessionId', 'waMessageId'], { unique: true })
export class TalentProcessedMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_talent_processed_session' })
  session!: Session;

  @Column()
  waMessageId!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
