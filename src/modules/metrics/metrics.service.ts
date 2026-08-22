import { Injectable, Optional, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constantTimeEqual } from '../../common/security/constantTimeEqual';
import { StatsService } from '../stats/stats.service';
import { SessionService } from '../session/session.service';
import { getWebhookDeliveryFailuresTotal } from '../../common/metrics/webhook-delivery-metrics';
import {
  getSessionReconnectAttemptsTotal,
  getSessionReconnectLoopAlertsTotal,
} from '../../common/metrics/session-reconnect-metrics';
import { getRestrictedSessionCount } from '../../common/metrics/session-restriction-metrics';
import { getSendPacingRefusals } from '../../common/metrics/send-pacing-metrics';
import { renderHttpRequestMetrics } from '../../common/metrics/request-metrics';
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

@Injectable()
export class MetricsService {
  private readonly logger = createLogger('MetricsService');

  private cachedRender: { at: number; text: string } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly statsService: StatsService,
    // Trailing @Optional: the running app always provides it (MetricsModule imports SessionModule);
    // direct-construction specs omit it and simply render no node-capacity series.
    @Optional()
    private readonly sessionService?: SessionService,
  ) {}

  private get token(): string {
    return (this.config.get<string>('METRICS_TOKEN') ?? '').trim();
  }

  /**
   * Throws if the caller may not scrape: 404 when metrics are disabled (no token configured),
   * 401 when a token is configured but the request's bearer is missing or wrong.
   */
  assertScrapeAuthorized(authorizationHeader: string | undefined): void {
    const expected = this.token;
    if (!expected) {
      throw new NotFoundException('Metrics endpoint is disabled (set METRICS_TOKEN to enable)');
    }
    const provided = (authorizationHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!provided || !this.safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid metrics token');
    }
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
    const mem = process.memoryUsage();
    const lines: string[] = [];

    const gauge = (name: string, help: string, value: number, labels = ''): void => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labels} ${value}`);
    };

    gauge('openwa_up', 'Whether the OpenWA process is up (always 1 when scraped).', 1);

    // Node capacity: THIS process's engine load against its configured ceiling — the pair an
    // autoscaler should watch (scale on assigned/capacity, not CPU: engine load is session-shaped).
    if (this.sessionService) {
      try {
        const capacity = await this.sessionService.nodeSessionsHealth();
        gauge('openwa_node_engines', 'Engines currently live or initializing in this process.', capacity.engines);
        gauge(
          'openwa_node_sessions_assigned',
          'Session rows assigned to this node by the ownership lease.',
          capacity.sessions.assigned,
        );
        gauge(
          'openwa_node_session_capacity',
          'MAX_CONCURRENT_SESSIONS for this node; 0 means unlimited.',
          this.config.get<number>('sessions.maxConcurrent') ?? 0,
        );
      } catch {
        // Capacity is best-effort on a scrape; the DB-derived block below has its own availability flag.
      }
    }
    gauge('openwa_process_uptime_seconds', 'Process uptime in seconds.', Math.round(process.uptime()));
    gauge('openwa_process_resident_memory_bytes', 'Resident set size in bytes.', mem.rss);
    gauge('openwa_process_heap_used_bytes', 'V8 heap used in bytes.', mem.heapUsed);

    gauge(
      'openwa_stats_available',
      'Whether the database-derived series below could be read on this scrape (1) or not (0).',
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
      '# HELP openwa_webhook_delivery_failures_total Webhook deliveries that terminally failed (all retries exhausted) since process start.',
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

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }
}
