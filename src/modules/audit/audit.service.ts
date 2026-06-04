import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan } from 'typeorm';
import { AuditLog, AuditAction, AuditSeverity } from './entities/audit-log.entity';
import { ApiKey } from '../auth/entities/api-key.entity';

interface AuditContext {
  apiKey?: ApiKey;
  sessionId?: string;
  sessionName?: string;
  ipAddress?: string;
  userAgent?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
}

export interface AuditQueryOptions {
  action?: AuditAction;
  apiKeyId?: string;
  sessionId?: string;
  severity?: AuditSeverity;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(AuditLog, 'main')
    private readonly auditRepository: Repository<AuditLog>,
  ) {}

  /**
   * Schedule periodic audit-log cleanup. The audit table lives in `main` and
   * grows unbounded otherwise. Gated by AUDIT_CLEANUP_ENABLED (default on);
   * retention and interval are configurable. Dependency-free (no
   * @nestjs/schedule) — a single unref'd interval so it never blocks shutdown.
   */
  onModuleInit(): void {
    if (process.env.AUDIT_CLEANUP_ENABLED === 'false') {
      this.logger.log('Audit cleanup disabled via AUDIT_CLEANUP_ENABLED=false');
      return;
    }

    const retentionDays = this.positiveIntEnv(process.env.AUDIT_RETENTION_DAYS, 30);
    const intervalHours = this.positiveIntEnv(process.env.AUDIT_CLEANUP_INTERVAL_HOURS, 24);
    const intervalMs = intervalHours * 60 * 60 * 1000;

    const run = (): void => {
      this.cleanup(retentionDays)
        .then(deleted => {
          if (deleted > 0) {
            this.logger.log(`Audit cleanup removed ${deleted} log(s) older than ${retentionDays}d`);
          }
        })
        .catch(error => this.logger.error(`Audit cleanup failed: ${String(error)}`));
    };

    this.cleanupTimer = setInterval(run, intervalMs);
    this.cleanupTimer.unref(); // don't keep the event loop alive
    this.logger.log(`Audit cleanup scheduled every ${intervalHours}h (retention ${retentionDays}d)`);
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private positiveIntEnv(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  async log(
    action: AuditAction,
    context: AuditContext = {},
    severity: AuditSeverity = AuditSeverity.INFO,
  ): Promise<AuditLog> {
    const auditLog = this.auditRepository.create({
      action,
      severity,
      apiKeyId: context.apiKey?.id || null,
      apiKeyName: context.apiKey?.name || null,
      sessionId: context.sessionId || null,
      sessionName: context.sessionName || null,
      ipAddress: context.ipAddress || null,
      userAgent: context.userAgent || null,
      method: context.method || null,
      path: context.path || null,
      statusCode: context.statusCode || null,
      metadata: context.metadata || null,
      errorMessage: context.errorMessage || null,
    });

    return this.auditRepository.save(auditLog);
  }

  async logInfo(action: AuditAction, context: AuditContext = {}): Promise<AuditLog> {
    return this.log(action, context, AuditSeverity.INFO);
  }

  async logWarn(action: AuditAction, context: AuditContext = {}): Promise<AuditLog> {
    return this.log(action, context, AuditSeverity.WARN);
  }

  async logError(action: AuditAction, context: AuditContext = {}): Promise<AuditLog> {
    return this.log(action, context, AuditSeverity.ERROR);
  }

  async findAll(options: AuditQueryOptions = {}): Promise<{
    data: AuditLog[];
    total: number;
  }> {
    const where: Record<string, unknown> = {};

    if (options.action) where.action = options.action;
    if (options.apiKeyId) where.apiKeyId = options.apiKeyId;
    if (options.sessionId) where.sessionId = options.sessionId;
    if (options.severity) where.severity = options.severity;

    if (options.startDate && options.endDate) {
      where.createdAt = Between(options.startDate, options.endDate);
    }

    const [data, total] = await this.auditRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: options.limit || 50,
      skip: options.offset || 0,
    });

    return { data, total };
  }

  async getRecentByApiKey(apiKeyId: string, limit = 10): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { apiKeyId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getRecentBySession(sessionId: string, limit = 10): Promise<AuditLog[]> {
    return this.auditRepository.find({
      where: { sessionId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async cleanup(olderThanDays = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.auditRepository.delete({
      createdAt: LessThan(cutoffDate),
    });

    return result.affected || 0;
  }
}
