import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue-names';
import { constantTimeEqual } from '../../common/security/constantTimeEqual';
import { limiterKeyForIp, resolveClientIp, type RequestLike } from '../../common/utils/ip';
import { SlidingWindowLimiter } from '../events/ws-rate-limit';
import { StatsService } from '../stats/stats.service';
import { getWebhookDeliveryFailuresTotal } from '../../common/metrics/webhook-delivery-metrics';
import {
  getSessionReconnectAttemptsTotal,
  getSessionReconnectLoopAlertsTotal,
} from '../../common/metrics/session-reconnect-metrics';
import { getRestrictedSessionCount } from '../../common/metrics/session-restriction-metrics';
import { getSendPacingRefusals } from '../../common/metrics/send-pacing-metrics';
import { renderHttpRequestMetrics } from '../../common/metrics/request-metrics';
import { getUnhandledRejections } from '../../common/metrics/process-error-metrics';
import { createLogger } from '../../common/services/logger.service';

/**
 * Prometheus exposition for OpenWA. Kept dependency-free (no prom-client) — the
 * surface is small and the text format (v0.0.4) is trivial to emit by hand.
 *
 * Scraping is gated by METRICS_TOKEN: when it is unset the endpoint is disabled entirely
 * (404, so a scanner cannot even confirm it exists); when set, a matching `Bearer` token
 * is required. This keeps operational internals (session counts, failure totals) from
 * being exposed publicly by default on a self-hosted box.
 */
/**
 * How long a rendered scrape is reused before recomputing. getOverview() runs a full session scan plus
 * several aggregate queries, so back-to-back scrapes (or several Prometheus replicas) would otherwise
 * each pay the full DB cost. Stale-by-a-few-seconds metrics are fine for Prometheus.
 */
export const METRICS_RENDER_TTL_MS = 5000;

/** Bound on each queue's job-count read, so a connected but unresponsive Redis cannot stall the scrape. */
export const QUEUE_READ_TIMEOUT_MS = 2000;

/** The job states reported per queue. `completed` is left out: removeOnComplete trims it, so it means nothing. */
const QUEUE_JOB_STATES = ['wait', 'active', 'delayed', 'failed'] as const;

/**
 * Sampling interval of the event-loop delay histogram. Each sample is the whole gap between two timer
 * callbacks, this interval included, so it is subtracted before export: an idle loop reads zero.
 */
const LOOP_DELAY_RESOLUTION_MS = 20;
const LOOP_DELAY_FLOOR_NS = LOOP_DELAY_RESOLUTION_MS * 1e6;

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly logger = createLogger('MetricsService');

  private cachedRender: { at: number; text: string } | null = null;

  /**
   * The route skips the shared throttler so a scrape interval costs no request budget, which left
   * token guesses unbounded. This window is charged per client before the compare and refunded when
   * it succeeds, so only failures spend it: 10 a minute, then 429 until the window slides.
   */
  private readonly failedScrapeLimiter = new SlidingWindowLimiter(10, 60_000);

  /** Event-loop delay sampled between uncached renders (reset after each one). */
  private readonly loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });

  constructor(
    private readonly config: ConfigService,
    private readonly statsService: StatsService,
    // Registered only with QUEUE_ENABLED=true (see metrics.module.ts); absent otherwise.
    @Optional() @InjectQueue(QUEUE_NAMES.WEBHOOK) private readonly webhookQueue?: Queue,
    @Optional() @InjectQueue(QUEUE_NAMES.INGRESS) private readonly ingressQueue?: Queue,
  ) {
    this.loopDelay.enable();
  }

  onModuleDestroy(): void {
    this.loopDelay.disable();
  }

  private get token(): string {
    return (this.config.get<string>('METRICS_TOKEN') ?? '').trim();
  }

  /**
   * Throws if the caller may not scrape: 404 when metrics are disabled (no token configured),
   * 401 when a token is configured but the request's bearer is missing or wrong, 429 once `client`
   * has spent its failed-attempt window.
   */
  assertScrapeAuthorized(authorizationHeader: string | undefined, client?: RequestLike): void {
    const expected = this.token;
    if (!expected) {
      throw new NotFoundException('Metrics endpoint is disabled (set METRICS_TOKEN to enable)');
    }
    const subject = client
      ? limiterKeyForIp(resolveClientIp(client, this.config.get<string[]>('security.trustedProxies') ?? []))
      : '';
    if (!this.failedScrapeLimiter.allow(subject)) {
      throw new HttpException('Too many failed metrics token attempts', HttpStatus.TOO_MANY_REQUESTS);
    }
    const provided = (authorizationHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!provided || !this.safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid metrics token');
    }
    this.failedScrapeLimiter.refund(subject);
  }

  private safeEqual(a: string, b: string): boolean {
    // Length-hiding constant-time compare: hash both inputs with a per-process key (fixed-length
    // digests) then timingSafeEqual, so the expected token's byte-length is not leaked through a
    // fast length-mismatch return. This `/api/metrics` endpoint is @Public and timed by callers.
    return constantTimeEqual(a, b);
  }

  /** Render the current metrics in Prometheus text exposition format (memoized for a short TTL). */
  async render(): Promise<string> {
    const now = Date.now();
    if (this.cachedRender && now - this.cachedRender.at < METRICS_RENDER_TTL_MS) {
      return this.cachedRender.text;
    }

    // The database-derived series are best-effort. Awaiting them unguarded meant a single rejected
    // query — a statement timeout, pool exhaustion, SQLITE_BUSY under load, or a genuine outage —
    // answered the whole scrape with a 500, so Prometheus lost the process, HTTP and webhook series
    // too, and `up` conflated "process dead" with "database unreachable": the exact incident this
    // endpoint exists to describe. The series that need no database are emitted either way, and the
    // ones that do are OMITTED rather than reported as zero, because a zero would fire an alert
    // claiming every session had dropped.
    let overview: Awaited<ReturnType<StatsService['getOverview']>> | null = null;
    try {
      overview = await this.statsService.getOverview();
    } catch (err) {
      this.logger.warn(
        `Metrics scrape could not read stats; database-derived series omitted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const queueCounts = await this.readQueueCounts();
    const mem = process.memoryUsage();
    const lines: string[] = [];

    const gauge = (name: string, help: string, value: number, labels = ''): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${value}`);
    };

    gauge('openwa_up', 'Whether the OpenWA process is up (always 1 when scraped).', 1);
    gauge('openwa_process_uptime_seconds', 'Process uptime in seconds.', Math.round(process.uptime()));
    gauge('openwa_process_resident_memory_bytes', 'Resident set size in bytes.', mem.rss);
    gauge('openwa_process_heap_used_bytes', 'V8 heap used in bytes.', mem.heapUsed);
    gauge(
      'openwa_event_loop_delay_p99_seconds',
      'p99 event-loop delay since the previous uncached scrape, in seconds.',
      Math.max(0, this.loopDelay.percentile(99) - LOOP_DELAY_FLOOR_NS) / 1e9,
    );
    gauge(
      'openwa_event_loop_delay_max_seconds',
      'Maximum event-loop delay since the previous uncached scrape, in seconds.',
      Math.max(0, this.loopDelay.max - LOOP_DELAY_FLOOR_NS) / 1e9,
    );
    this.loopDelay.reset();

    const rejections = getUnhandledRejections();
    lines.push(
      '# HELP openwa_unhandled_rejections_total Promise rejections that reached the process-level handler since process start.',
    );
    lines.push('# TYPE openwa_unhandled_rejections_total counter');
    lines.push(`openwa_unhandled_rejections_total{kind="other"} ${rejections.other}`);
    lines.push(`openwa_unhandled_rejections_total{kind="page_context_lost"} ${rejections.page_context_lost}`);

    // Read from the shared Redis, so every node reports the same cluster-wide value. A queue that is
    // disabled or could not be read is omitted, not reported as empty.
    if (queueCounts.length > 0) {
      lines.push('# HELP openwa_queue_jobs Jobs in each BullMQ queue by state (cluster-wide).');
      lines.push('# TYPE openwa_queue_jobs gauge');
      for (const [name, counts] of queueCounts) {
        for (const state of QUEUE_JOB_STATES) {
          lines.push(`openwa_queue_jobs{queue="${name}",state="${state}"} ${counts[state] ?? 0}`);
        }
      }
    }

    gauge(
      'openwa_stats_available',
      'Whether the database-derived series below could be read (1) or not (0); cached up to STATS_CACHE_TTL_MS + 5 s.',
      overview ? 1 : 0,
    );

    if (overview) {
      gauge('openwa_sessions_total', 'Total number of configured sessions.', overview.sessions.total);
      gauge('openwa_sessions_active', 'Number of READY (active) sessions.', overview.sessions.active);

      // Per-status session counts share one metric name with a `status` label.
      lines.push('# HELP openwa_sessions Number of sessions by status.');
      lines.push('# TYPE openwa_sessions gauge');
      for (const [status, count] of Object.entries(overview.sessions.byStatus)) {
        lines.push(`openwa_sessions{status="${this.escapeLabel(status)}"} ${count}`);
      }

      lines.push('# HELP openwa_messages_total Current stored messages by direction.');
      lines.push('# TYPE openwa_messages_total gauge');
      lines.push(`openwa_messages_total{direction="outgoing"} ${overview.messages.sent}`);
      lines.push(`openwa_messages_total{direction="incoming"} ${overview.messages.received}`);

      lines.push('# HELP openwa_messages_failed_total Current stored messages in FAILED state.');
      lines.push('# TYPE openwa_messages_failed_total gauge');
      lines.push(`openwa_messages_failed_total ${overview.messages.failed}`);
    }

    lines.push(
      '# HELP openwa_webhook_delivery_failures_total Webhook delivery failures recorded since process start: retries exhausted, never sent (shed, refused at shutdown, rejected before sending), or stopped by shutdown between direct retries.',
    );
    lines.push('# TYPE openwa_webhook_delivery_failures_total counter');
    lines.push(`openwa_webhook_delivery_failures_total ${getWebhookDeliveryFailuresTotal()}`);

    lines.push(
      '# HELP openwa_session_reconnect_attempts_total Reconnect attempts scheduled across all sessions since process start.',
    );
    lines.push('# TYPE openwa_session_reconnect_attempts_total counter');
    lines.push(`openwa_session_reconnect_attempts_total ${getSessionReconnectAttemptsTotal()}`);

    lines.push('# HELP openwa_session_reconnect_loop_alerts_total Reconnect-loop alerts emitted since process start.');
    lines.push('# TYPE openwa_session_reconnect_loop_alerts_total counter');
    lines.push(`openwa_session_reconnect_loop_alerts_total ${getSessionReconnectLoopAlertsTotal()}`);

    lines.push('# HELP openwa_sessions_restricted Sessions whose account WhatsApp is currently restricting.');
    lines.push('# TYPE openwa_sessions_restricted gauge');
    lines.push(`openwa_sessions_restricted ${getRestrictedSessionCount()}`);

    // Emitted only once a refusal has actually happened, like the HTTP series: a family that appears
    // at its first occurrence is easier to alert on than one pinned at zero for every reason.
    const refusals = getSendPacingRefusals();
    if (refusals.size > 0) {
      lines.push('# HELP openwa_send_pacing_refusals_total Sends refused by the pacing governor since process start.');
      lines.push('# TYPE openwa_send_pacing_refusals_total counter');
      for (const [reason, count] of refusals) {
        lines.push(`openwa_send_pacing_refusals_total{reason="${this.escapeLabel(reason)}"} ${count}`);
      }
    }

    // HTTP RED metrics (request rate + duration per route), recorded by RequestMetricsInterceptor.
    // Included in the same cached render — a few seconds of staleness is fine for Prometheus.
    lines.push(...renderHttpRequestMetrics());

    const text = lines.join('\n') + '\n';
    this.cachedRender = { at: now, text };
    return text;
  }

  /** Job counts for each registered queue that answered within QUEUE_READ_TIMEOUT_MS. */
  private async readQueueCounts(): Promise<Array<[string, Record<string, number>]>> {
    const queues = [
      [QUEUE_NAMES.WEBHOOK, this.webhookQueue],
      [QUEUE_NAMES.INGRESS, this.ingressQueue],
    ] as const;
    const results: Array<[string, Record<string, number>]> = [];
    for (const [name, queue] of queues) {
      if (!queue) continue;
      let timer: NodeJS.Timeout | undefined;
      try {
        const counts = await Promise.race([
          queue.getJobCounts(...QUEUE_JOB_STATES),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out')), QUEUE_READ_TIMEOUT_MS);
          }),
        ]);
        results.push([name, counts]);
      } catch (err) {
        this.logger.warn(
          `Metrics scrape could not read ${name} job counts; series omitted: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }
    return results;
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }
}
