import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan } from 'typeorm';
import { AuditLog, AuditAction, AuditSeverity } from './entities/audit-log.entity';
import { ApiKey } from '../auth/entities/api-key.entity';
import { createLogger } from '../../common/services/logger.service';

/** Upper bound on a single audit-log page, so a large `limit` can't load the whole table at once. */
export const MAX_AUDIT_PAGE_SIZE = 200;

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
  private readonly logger = createLogger('AuditService');
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(AuditLog, 'main')
    private readonly auditRepository: Repository<AuditLog>,
  ) {}

  /**
   * Periodically prune audit logs older than AUDIT_RETENTION_DAYS (default 90; set <= 0 to disable).
   * Runs once at startup, then daily. Without this the audit_logs table grows without bound — the
   * existing cleanup() method was never scheduled or called anywhere.
   */
  onModuleInit(): void {
    const parsed = Number.parseInt(process.env.AUDIT_RETENTION_DAYS ?? '', 10);
    const retentionDays = Number.isInteger(parsed) ? Math.max(0, parsed) : 90;
    if (retentionDays <= 0) {
      this.logger.log('Audit-log retention disabled (AUDIT_RETENTION_DAYS <= 0)');
      return;
    }
    const runCleanup = (): void => {
      this.cleanup(retentionDays)
        .then(n => {
          if (n > 0) this.logger.log(`Pruned ${n} audit log(s) older than ${retentionDays} day(s)`);
        })
        .catch(err => this.logger.error('Audit-log cleanup failed', err instanceof Error ? err.stack : String(err)));
    };
    runCleanup(); // prune once at startup
    this.cleanupTimer = setInterval(runCleanup, 24 * 60 * 60 * 1000);
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  async log(
    action: AuditAction,
    context: AuditContext = {},
    severity: AuditSeverity = AuditSeverity.INFO,
  ): Promise<AuditLog | null> {
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

    // Audit logging is best-effort: a failed insert must never turn a succeeded operation into a 500
    // (callers await this after the primary side-effect). Log and swallow.
    try {
      return await this.auditRepository.save(auditLog);
    } catch (error) {
      this.logger.error(
        `Failed to write audit log for ${String(action)}`,
        error instanceof Error ? error.stack : String(error),
        { action: String(action) },
      );
      return null;
    }
  }

  async logInfo(action: AuditAction, context: AuditContext = {}): Promise<AuditLog | null> {
    return this.log(action, context, AuditSeverity.INFO);
  }

  async logWarn(action: AuditAction, context: AuditContext = {}): Promise<AuditLog | null> {
    return this.log(action, context, AuditSeverity.WARN);
  }

  async logError(action: AuditAction, context: AuditContext = {}): Promise<AuditLog | null> {
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

    // Clamp the page size so an arbitrarily large `limit` can't load the whole table into one response.
    const requested = options.limit && options.limit > 0 ? options.limit : 50;
    const take = Math.min(requested, MAX_AUDIT_PAGE_SIZE);

    const [data, total] = await this.auditRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take,
      // Clamp to a non-negative skip: a negative offset (e.g. from an unvalidated `?offset=-5`) would
      // otherwise reach the query driver verbatim.
      skip: options.offset && options.offset > 0 ? options.offset : 0,
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
