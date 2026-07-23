import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

export enum AuditAction {
  // API Key events
  API_KEY_CREATED = 'api_key_created',
  API_KEY_UPDATED = 'api_key_updated',
  API_KEY_USED = 'api_key_used',
  API_KEY_REVOKED = 'api_key_revoked',
  API_KEY_DELETED = 'api_key_deleted',
  API_KEY_AUTH_FAILED = 'api_key_auth_failed',

  // Session events
  SESSION_CREATED = 'session_created',
  SESSION_STARTED = 'session_started',
  SESSION_STOPPED = 'session_stopped',
  SESSION_FORCE_KILLED = 'session_force_killed',
  SESSION_DELETED = 'session_deleted',
  SESSION_QR_GENERATED = 'session_qr_generated',
  SESSION_CONNECTED = 'session_connected',
  SESSION_DISCONNECTED = 'session_disconnected',

  // Message events
  MESSAGE_SENT = 'message_sent',
  MESSAGE_FAILED = 'message_failed',

  // Webhook events
  WEBHOOK_CREATED = 'webhook_created',
  WEBHOOK_DELETED = 'webhook_deleted',
  WEBHOOK_TRIGGERED = 'webhook_triggered',
  WEBHOOK_FAILED = 'webhook_failed',

  // Integration plugin-instance events
  INTEGRATION_INSTANCE_CREATED = 'integration_instance_created',
  INTEGRATION_INSTANCE_UPDATED = 'integration_instance_updated',
  INTEGRATION_INSTANCE_SECRET_REGENERATED = 'integration_instance_secret_regenerated',
  INTEGRATION_INSTANCE_DELETED = 'integration_instance_deleted',

  // Infrastructure events (ADMIN-only operations on the infra module: credential-bearing config
  // mutation, server restart / Docker orchestration, and full-DB / storage export+import).
  INFRA_CONFIG_SAVED = 'infra_config_saved',
  INFRA_RESTART_REQUESTED = 'infra_restart_requested',
  INFRA_DATA_EXPORTED = 'infra_data_exported',
  INFRA_DATA_IMPORTED = 'infra_data_imported',
  INFRA_STORAGE_EXPORTED = 'infra_storage_exported',
  INFRA_STORAGE_IMPORTED = 'infra_storage_imported',
}

export enum AuditSeverity {
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 50 })
  action: AuditAction;

  @Column({ type: 'varchar', length: 10, default: AuditSeverity.INFO })
  severity: AuditSeverity;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  apiKeyId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  apiKeyName: string | null;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sessionName: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  method: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  path: string | null;

  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  // The "main" database connection is always SQLite (boot config),
  // so we use simple-json regardless of the user's data DB choice.
  @Column({ type: 'simple-json', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Index()
  @CreateDateColumn()
  createdAt: Date;
}
