import { Controller, Get, Req, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
  HealthCheckResponseDto,
  LivenessResponseDto,
  ReadinessResponseDto,
  SessionsHealthResponseDto,
} from './dto/health-response.dto';
import { SessionService } from '../session/session.service';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { SkipThrottle } from '@nestjs/throttler';
import { ShutdownService } from '../../common/services/shutdown.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SlidingWindowLimiter } from '../events/ws-rate-limit';
import { resolveClientIp } from '../../common/utils/ip';

interface DependencyStatus {
  status: 'up' | 'down';
}

interface HealthCheckResult {
  status: 'ok' | 'error';
  details: Record<string, DependencyStatus>;
}

/** Bound each dependency probe so a hung connection can't stall the readiness check. */
const READINESS_PROBE_TIMEOUT_MS = 3000;

// Source the running version from package.json (same pattern as swagger.config.ts) so authenticated
// callers (e.g. the dashboard) read it live and never show a stale build-time-baked version. Read
// once at module load.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: APP_VERSION } = require('../../../package.json') as { version: string };

@ApiTags('health')
@Controller('health')
@Public()
@SkipThrottle()
export class HealthController {
  constructor(
    @InjectDataSource('main') private readonly mainDataSource: DataSource,
    @InjectDataSource('data') private readonly dataDataSource: DataSource,
    private readonly shutdownService: ShutdownService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly sessionService: SessionService,
  ) {
    // Bounds the audit rows one source IP can write per minute through this deliberately
    // unthrottled route: the health probes themselves must never be rate-limited, but without a
    // cap a key-probing flood would turn the audit trail into the flood's storage.
    this.authFailureAuditLimiter = new SlidingWindowLimiter(10, 60_000);
  }

  private readonly authFailureAuditLimiter: SlidingWindowLimiter;

  @Get()
  @ApiOperation({ summary: 'Basic health check' })
  @ApiResponse({ status: 200, description: 'Application is healthy', type: HealthCheckResponseDto })
  async check(@Req() req: Request): Promise<{ status: string; timestamp: string; version?: string }> {
    const body: { status: string; timestamp: string; version?: string } = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
    // The exact running version is disclosed only to authenticated callers; the route itself stays
    // public so uptime probes keep working without credentials.
    if (await this.hasValidApiKey(req)) {
      body.version = APP_VERSION;
    }
    return body;
  }

  /**
   * The route is @Public, so the global ApiKeyGuard never runs here — resolve a presented key the
   * same way the guard does (X-API-Key header or Bearer token, trusted-proxy-aware client IP so an
   * allowedIps-restricted key is enforced identically). Any outcome other than a validated key —
   * none presented, invalid, revoked, IP-denied — withholds the version; it never fails the check.
   */
  private async hasValidApiKey(req: Request): Promise<boolean> {
    const xApiKey = req.headers['x-api-key'];
    const authHeader = req.headers['authorization'];
    const rawKey =
      (typeof xApiKey === 'string' && xApiKey) || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
    if (!rawKey) return false;
    try {
      const clientIp = resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []);
      await this.authService.validateApiKey(rawKey, clientIp);
      return true;
    } catch (err) {
      // A PRESENTED key that failed validation is a credential probe against an endpoint every
      // other key-validation surface audits (REST guard, WebSocket, MCP mount, Bull Board). This
      // route was the one blind spot: the failure only withheld the version, invisibly. Fire-and-
      // forget and rate-bounded per IP (constructor): audit logging must never fail the probe.
      const failureIp = resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []);
      if (this.authFailureAuditLimiter.allow(failureIp)) {
        void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
          ipAddress: failureIp,
          method: req.method,
          path: req.path,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      return false;
    }
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe for Kubernetes' })
  @ApiResponse({ status: 200, description: 'Application is alive', type: LivenessResponseDto })
  liveness(): { status: string } {
    // Liveness only reflects process liveness — deliberately static so a transient
    // dependency outage doesn't trigger a pod KILL (that's readiness' job).
    return { status: 'ok' };
  }

  @Get('sessions')
  @ApiOperation({
    summary: 'Session warm-up and capacity for this node — counts only, safe for probes and autoscalers',
  })
  @ApiResponse({ status: 200, description: 'Per-node session/engine counts', type: SessionsHealthResponseDto })
  async sessionsHealth(): Promise<SessionsHealthResponseDto> {
    // The DB readiness probe deliberately ignores sessions, so a pod reports Ready with zero engines
    // restored — this route is the missing capacity signal: an HPA scales on assigned/engines, a
    // rollout can gate on ready approaching assigned, and a drain watcher can wait for engines to
    // reach zero. Counts come from the session capability service (controllers must not touch the
    // engine registry directly), which also keeps the payload to numbers only.
    const capacity = await this.sessionService.nodeSessionsHealth();
    return {
      status: 'ok',
      draining: this.shutdownService.isShuttingDown(),
      ...capacity,
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — verifies the auth/audit + data databases respond' })
  @ApiResponse({ status: 200, description: 'Application is ready to accept traffic', type: ReadinessResponseDto })
  @ApiResponse({ status: 503, description: 'A required dependency is down' })
  async readiness(): Promise<HealthCheckResult> {
    // While draining (shutdown started), report 503 so the LB/orchestrator stops
    // routing new traffic before teardown — even if the DBs are still up.
    if (this.shutdownService.isShuttingDown()) {
      throw new ServiceUnavailableException({ status: 'error', details: { shutdown: { status: 'draining' } } });
    }

    const [main, data] = await Promise.all([
      this.probeDatabase(this.mainDataSource),
      this.probeDatabase(this.dataDataSource),
    ]);

    const details: Record<string, DependencyStatus> = {
      mainDatabase: { status: main },
      dataDatabase: { status: data },
    };

    if (main === 'down' || data === 'down') {
      // 503 so orchestrators/LBs stop routing traffic to a node with a dead DB.
      throw new ServiceUnavailableException({ status: 'error', details });
    }

    return { status: 'ok', details };
  }

  private async probeDatabase(dataSource: DataSource): Promise<'up' | 'down'> {
    try {
      await this.withTimeout(dataSource.query('SELECT 1'), READINESS_PROBE_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('readiness probe timed out')), ms);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
