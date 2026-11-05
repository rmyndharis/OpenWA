import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthCheckResponseDto, LivenessResponseDto, ReadinessResponseDto } from './dto/health-response.dto';
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
import { limiterKeyForIp, resolveClientIp } from '../../common/utils/ip';
import { presentedApiKey } from '../../common/security/bearer-token';
import { createLogger } from '../../common/services/logger.service';

interface DependencyStatus {
  status: 'up' | 'down';
}

interface HealthCheckResult {
  status: 'ok' | 'error';
  details: Record<string, DependencyStatus>;
}

/** Bound each dependency probe so a hung connection can't stall the readiness check. */
const READINESS_PROBE_TIMEOUT_MS = 3000;

/** How long the verdict of one readiness probe answers the requests that follow it. */
const READINESS_VERDICT_TTL_MS = 1000;

interface ReadinessVerdict {
  main: DependencyStatus['status'];
  data: DependencyStatus['status'];
  /** When the probe finished. */
  at: number;
}

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
  ) {
    // Bounds the audit rows one source IP can write per minute through this deliberately
    // unthrottled route: the health probes themselves must never be rate-limited, but without a
    // cap a key-probing flood would turn the audit trail into the flood's storage.
    this.authFailureAuditLimiter = new SlidingWindowLimiter(10, 60_000);
  }

  private readonly authFailureAuditLimiter: SlidingWindowLimiter;

  // Bounds the key lookups one client can drive through this unthrottled route. Charged before the
  // lookup and refunded when the key validates, so only failed presentations spend it: past the
  // budget the probe still answers 200, without `version` and without touching the key table.
  private readonly keyValidationLimiter = new SlidingWindowLimiter(30, 60_000);

  private readonly logger = createLogger('HealthController');

  // A key table that cannot be read fails every presentation the same way: log it once a minute, not once a probe.
  private readonly keyStoreFailureLogLimiter = new SlidingWindowLimiter(1, 60_000);

  private verdict: ReadinessVerdict | null = null;
  private pendingProbe: Promise<ReadinessVerdict> | null = null;

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
    const rawKey = presentedApiKey(req.headers);
    if (!rawKey) return false;
    const clientIp = resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []);
    const subject = limiterKeyForIp(clientIp);
    const reservation = {};
    if (!this.keyValidationLimiter.allow(subject, reservation)) return false;
    try {
      await this.authService.validateApiKey(rawKey, clientIp);
      this.keyValidationLimiter.refund(subject, reservation);
      return true;
    } catch (err) {
      // Only a 401/403 refusal judged the credential. An unreadable key table gave no verdict, so it is not
      // audited as a credential probe, but its slot stays spent (as on the WebSocket handshake) to keep the
      // lookups against a failing store bounded, and the failure is logged for operators.
      if (!(err instanceof UnauthorizedException || err instanceof ForbiddenException)) {
        if (this.keyStoreFailureLogLimiter.allow('key-store')) {
          this.logger.error(
            'Health probe could not check the presented API key',
            err instanceof Error ? err.stack : String(err),
          );
        }
        return false;
      }
      // A PRESENTED key that failed validation is a credential probe against an endpoint every
      // other key-validation surface audits (REST guard, WebSocket, MCP mount, Bull Board). This
      // route was the one blind spot: the failure only withheld the version, invisibly. Fire-and-
      // forget and rate-bounded per IP (constructor): audit logging must never fail the probe.
      if (this.authFailureAuditLimiter.allow(subject)) {
        void this.auditService.logWarn(AuditAction.API_KEY_AUTH_FAILED, {
          ipAddress: clientIp,
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

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe — verifies the auth/audit + data databases respond' })
  @ApiResponse({ status: 200, description: 'Application is ready to accept traffic', type: ReadinessResponseDto })
  @ApiResponse({
    status: 503,
    description:
      'A required dependency is down, or the node is draining for shutdown (details.shutdown.status = draining)',
    type: ReadinessResponseDto,
  })
  async readiness(): Promise<HealthCheckResult> {
    // While draining (shutdown started), report 503 so the LB/orchestrator stops
    // routing new traffic before teardown — even if the DBs are still up.
    if (this.shutdownService.isShuttingDown()) {
      throw new ServiceUnavailableException({ status: 'error', details: { shutdown: { status: 'draining' } } });
    }

    const { main, data } = await this.probeDatabases();

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

  /**
   * The verdict on both databases. The route is public and exempt from the throttler, so a flood of callers would
   * otherwise queue two queries each in the connection pools, ahead of the application's own and of the load
   * balancer's probe. Requests that arrive while a probe runs share it, and its verdict answers the next second.
   */
  private probeDatabases(): Promise<ReadinessVerdict> {
    // A verdict dated in the future (the clock was set back) is not reused: the probe runs again.
    const age = this.verdict ? Date.now() - this.verdict.at : -1;
    if (this.verdict && age >= 0 && age < READINESS_VERDICT_TTL_MS) return Promise.resolve(this.verdict);
    this.pendingProbe ??= Promise.all([
      this.probeDatabase(this.mainDataSource),
      this.probeDatabase(this.dataDataSource),
    ])
      .then(([main, data]) => (this.verdict = { main, data, at: Date.now() }))
      .finally(() => {
        this.pendingProbe = null;
      });
    return this.pendingProbe;
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
