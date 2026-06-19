import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { StatsService } from '../stats/stats.service';

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
  private cachedRender: { at: number; text: string } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly statsService: StatsService,
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
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    // timingSafeEqual requires equal lengths; compare to a fixed digest of `b` to avoid
    // leaking the expected length through an early return.
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  /** Render the current metrics in Prometheus text exposition format (memoized for a short TTL). */
  async render(): Promise<string> {
    const now = Date.now();
    if (this.cachedRender && now - this.cachedRender.at < METRICS_RENDER_TTL_MS) {
      return this.cachedRender.text;
    }

    const overview = await this.statsService.getOverview();
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

    gauge('openwa_sessions_total', 'Total number of configured sessions.', overview.sessions.total);
    gauge('openwa_sessions_active', 'Number of READY (active) sessions.', overview.sessions.active);

    // Per-status session counts share one metric name with a `status` label.
    lines.push('# HELP openwa_sessions Number of sessions by status.');
    lines.push('# TYPE openwa_sessions gauge');
    for (const [status, count] of Object.entries(overview.sessions.byStatus)) {
      lines.push(`openwa_sessions{status="${this.escapeLabel(status)}"} ${count}`);
    }

    lines.push('# HELP openwa_messages_total Total messages by direction.');
    lines.push('# TYPE openwa_messages_total counter');
    lines.push(`openwa_messages_total{direction="outgoing"} ${overview.messages.sent}`);
    lines.push(`openwa_messages_total{direction="incoming"} ${overview.messages.received}`);

    lines.push('# HELP openwa_messages_failed_total Total messages in FAILED state.');
    lines.push('# TYPE openwa_messages_failed_total counter');
    lines.push(`openwa_messages_failed_total ${overview.messages.failed}`);

    const text = lines.join('\n') + '\n';
    this.cachedRender = { at: now, text };
    return text;
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }
}
