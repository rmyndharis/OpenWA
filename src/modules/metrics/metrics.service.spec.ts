import { HttpException, HttpStatus, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { MetricsService, METRICS_RENDER_TTL_MS, QUEUE_READ_TIMEOUT_MS } from './metrics.service';
import { StatsService, OverviewStats } from '../stats/stats.service';
import { producerConnectWaitMs } from '../queue/redis-connection';
import { getWebhookDeliveryFailuresTotal } from '../../common/metrics/webhook-delivery-metrics';
import {
  getSessionReconnectAttemptsTotal,
  getSessionReconnectLoopAlertsTotal,
} from '../../common/metrics/session-reconnect-metrics';
import { setRestrictedSessionCount } from '../../common/metrics/session-restriction-metrics';
import { getUnhandledRejections, incrementUnhandledRejections } from '../../common/metrics/process-error-metrics';

describe('MetricsService', () => {
  const overview: OverviewStats = {
    sessions: { active: 2, total: 3, byStatus: { ready: 2, failed: 1 } },
    messages: { sent: 100, received: 50, failed: 3, today: { sent: 10, received: 5 } },
  };

  const makeService = (token?: string): MetricsService => {
    const config = { get: (k: string) => (k === 'METRICS_TOKEN' ? token : undefined) } as unknown as ConfigService;
    const stats = { getOverview: jest.fn().mockResolvedValue(overview) } as unknown as StatsService;
    return new MetricsService(config, stats);
  };

  describe('assertScrapeAuthorized', () => {
    it('returns 404 when no token is configured (endpoint disabled by default)', () => {
      const svc = makeService(undefined);
      expect(() => svc.assertScrapeAuthorized('Bearer anything')).toThrow(NotFoundException);
    });

    it('rejects a missing bearer with 401 when a token is configured', () => {
      const svc = makeService('s3cret');
      expect(() => svc.assertScrapeAuthorized(undefined)).toThrow(UnauthorizedException);
    });

    it('rejects a wrong token with 401', () => {
      const svc = makeService('s3cret');
      expect(() => svc.assertScrapeAuthorized('Bearer nope')).toThrow(UnauthorizedException);
    });

    it('accepts a correct bearer token', () => {
      const svc = makeService('s3cret');
      expect(() => svc.assertScrapeAuthorized('Bearer s3cret')).not.toThrow();
    });

    it('is tolerant of bearer casing/whitespace', () => {
      const svc = makeService('s3cret');
      expect(() => svc.assertScrapeAuthorized('bearer   s3cret')).not.toThrow();
    });

    // The route skips the shared throttler so scrapes cost no budget; failed compares get their own.
    it('answers 429 once one client has failed too often, without comparing further guesses', () => {
      const svc = makeService('s3cret');
      const guesser = { headers: {}, socket: { remoteAddress: '198.51.100.7' } };
      for (let i = 0; i < 10; i++) {
        expect(() => svc.assertScrapeAuthorized('Bearer nope', guesser)).toThrow(UnauthorizedException);
      }
      const locked = (): void => svc.assertScrapeAuthorized('Bearer s3cret', guesser);
      expect(locked).toThrow(HttpException);
      try {
        locked();
      } catch (err) {
        expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
      // Another client is unaffected.
      expect(() =>
        svc.assertScrapeAuthorized('Bearer s3cret', { headers: {}, socket: { remoteAddress: '203.0.113.9' } }),
      ).not.toThrow();
    });

    it('never charges a successful scrape against that budget', () => {
      const svc = makeService('s3cret');
      const scraper = { headers: {}, socket: { remoteAddress: '198.51.100.8' } };
      for (let i = 0; i < 50; i++) {
        expect(() => svc.assertScrapeAuthorized('Bearer s3cret', scraper)).not.toThrow();
      }
    });
  });

  describe('render', () => {
    it('emits Prometheus exposition with session + message gauges', async () => {
      const svc = makeService('s3cret');
      const out = await svc.render();

      expect(out).toContain('openwa_up 1');
      expect(out).toContain('openwa_sessions_active 2');
      expect(out).toContain('openwa_sessions_total 3');
      expect(out).toContain('openwa_sessions{status="ready"} 2');
      expect(out).toContain('openwa_sessions{status="failed"} 1');
      expect(out).toContain('openwa_messages_total{direction="outgoing"} 100');
      expect(out).toContain('openwa_messages_total{direction="incoming"} 50');
      expect(out).toContain('openwa_messages_failed_total 3');
      // Every metric must declare HELP/TYPE before its sample.
      expect(out).toContain('# TYPE openwa_messages_total gauge');
      expect(out).toContain('# TYPE openwa_messages_failed_total gauge');
      // Webhook terminal-failure counter is emitted with correct counter typing + current total.
      expect(out).toContain('# TYPE openwa_webhook_delivery_failures_total counter');
      expect(out).toContain(`openwa_webhook_delivery_failures_total ${getWebhookDeliveryFailuresTotal()}`);
      // Reconnect observability counters are emitted with correct counter typing + current totals.
      expect(out).toContain('# TYPE openwa_session_reconnect_attempts_total counter');
      expect(out).toContain(`openwa_session_reconnect_attempts_total ${getSessionReconnectAttemptsTotal()}`);
      expect(out).toContain('# TYPE openwa_session_reconnect_loop_alerts_total counter');
      expect(out).toContain(`openwa_session_reconnect_loop_alerts_total ${getSessionReconnectLoopAlertsTotal()}`);
      expect(out.endsWith('\n')).toBe(true);
    });

    // A gauge, not a counter: what matters is how many accounts are restricted right now, and a
    // restriction that is applied, lifted and re-applied is one recurring fact, not a running total.
    it('emits the restricted-session gauge from the live count', async () => {
      setRestrictedSessionCount(2);
      const out = await makeService('s3cret').render();

      expect(out).toContain('# TYPE openwa_sessions_restricted gauge');
      expect(out).toContain('openwa_sessions_restricted 2');
    });

    it('reports zero restricted sessions rather than omitting the gauge', async () => {
      setRestrictedSessionCount(0);
      const out = await makeService('s3cret').render();

      expect(out).toContain('openwa_sessions_restricted 0');
    });

    it('memoizes the rendered output within the TTL (one getOverview per window)', async () => {
      jest.useFakeTimers();
      try {
        const config = {
          get: (k: string) => (k === 'METRICS_TOKEN' ? 's3cret' : undefined),
        } as unknown as ConfigService;
        const getOverview = jest.fn().mockResolvedValue(overview);
        const svc = new MetricsService(config, { getOverview } as unknown as StatsService);

        await svc.render();
        await svc.render();
        expect(getOverview).toHaveBeenCalledTimes(1); // 2nd scrape served from the memo, no DB work

        jest.advanceTimersByTime(METRICS_RENDER_TTL_MS + 1);
        await svc.render();
        expect(getOverview).toHaveBeenCalledTimes(2); // window expired → recomputed
      } finally {
        jest.useRealTimers();
      }
    });
  });
});

// The scrape had a hard runtime dependency on the data database: render() awaited
// StatsService.getOverview() unguarded, so once the stats memo lapsed during a database problem
// EVERY scrape answered 500 and Prometheus lost the whole target — including the process and HTTP
// series that need no database at all, during the exact incident they exist for.
describe('MetricsService.render survives a failing stats query', () => {
  const healthyOverview: OverviewStats = {
    sessions: { active: 2, total: 3, byStatus: { ready: 2, failed: 1 } },
    messages: { sent: 100, received: 50, failed: 3, today: { sent: 10, received: 5 } },
  };

  const failing = (): MetricsService => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const stats = {
      getOverview: jest.fn().mockRejectedValue(new Error('SQLITE_BUSY: database is locked')),
    } as unknown as StatsService;
    return new MetricsService(config, stats);
  };

  it('still serves the series that need no database', async () => {
    const text = await failing().render();

    expect(text).toContain('openwa_up 1');
    expect(text).toContain('openwa_process_uptime_seconds');
    expect(text).toContain('openwa_process_resident_memory_bytes');
    expect(text).toContain('openwa_webhook_delivery_failures_total');
  });

  it('signals that the database-derived series are missing rather than reporting them as zero', async () => {
    const text = await failing().render();

    expect(text).toContain('openwa_stats_available 0');
    // A stale or invented 0 would be worse than an absent series: an alert on
    // openwa_sessions_active would fire as if every session had dropped.
    expect(text).not.toContain('openwa_sessions_active');
    expect(text).not.toContain('openwa_messages_total');
  });

  // Negative twin: a healthy scrape must still carry the database-derived series and say so.
  it('reports the stats source as available on a healthy scrape', async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const stats = { getOverview: jest.fn().mockResolvedValue(healthyOverview) } as unknown as StatsService;
    const text = await new MetricsService(config, stats).render();

    expect(text).toContain('openwa_stats_available 1');
    expect(text).toContain('openwa_sessions_active 2');
  });
});

describe('MetricsService runtime series', () => {
  const overview: OverviewStats = {
    sessions: { active: 0, total: 0, byStatus: {} },
    messages: { sent: 0, received: 0, failed: 0, today: { sent: 0, received: 0 } },
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  const stats = { getOverview: jest.fn().mockResolvedValue(overview) } as unknown as StatsService;
  const queue = (getJobCounts: () => Promise<Record<string, number>>): Queue =>
    ({ waitUntilReady: () => Promise.resolve(), getJobCounts }) as unknown as Queue;
  const services: MetricsService[] = [];
  const make = (webhook?: Queue, ingress?: Queue): MetricsService => {
    const svc = new MetricsService(config, stats, webhook, ingress);
    services.push(svc);
    return svc;
  };

  afterEach(() => {
    services.splice(0).forEach(svc => svc.onModuleDestroy());
    jest.useRealTimers();
  });

  const sample = (text: string, series: string): number => {
    const line = text.split('\n').find(l => l.startsWith(`${series} `));
    expect(line).toBeDefined();
    return Number(line!.split(' ')[1]);
  };

  it('reports event-loop delay since the previous uncached render, then starts a new window', async () => {
    const svc = make();
    const histogram = (svc as unknown as { loopDelay: { reset: () => void } }).loopDelay;
    const reset = jest.spyOn(histogram, 'reset');

    const text = await svc.render();

    expect(text).toContain('# TYPE openwa_event_loop_delay_p99_seconds gauge');
    expect(text).toContain('# TYPE openwa_event_loop_delay_max_seconds gauge');
    for (const series of ['openwa_event_loop_delay_p99_seconds', 'openwa_event_loop_delay_max_seconds']) {
      const value = sample(text, series);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('reports event-loop delay net of the sampling interval, so an idle loop reads zero', async () => {
    const svc = make();
    const histogram = (svc as unknown as { loopDelay: { percentile: (p: number) => number; max: number } }).loopDelay;
    // The histogram records the whole gap between its 20 ms timer callbacks: an idle loop reads about
    // 20 ms, and a 200 ms synchronous block reads about 220 ms.
    jest.spyOn(histogram, 'percentile').mockReturnValue(19.8e6);
    jest.spyOn(histogram, 'max', 'get').mockReturnValue(220e6);

    const text = await svc.render();

    expect(sample(text, 'openwa_event_loop_delay_p99_seconds')).toBe(0);
    expect(sample(text, 'openwa_event_loop_delay_max_seconds')).toBeCloseTo(0.2, 9);
  });

  // Resetting Node's interval histogram also dropped its previous-tick timestamp, so the first gap
  // after each render went unrecorded, and with it a stall that began right there.
  it('records a stall that begins right after an uncached render', async () => {
    const svc = make();
    const idle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 60));
    await idle();
    await svc.render();
    const until = Date.now() + 300;
    while (Date.now() < until) {
      // block the event loop
    }
    await idle();
    (svc as unknown as { cachedRender: unknown }).cachedRender = null;

    const text = await svc.render();

    expect(sample(text, 'openwa_event_loop_delay_max_seconds')).toBeGreaterThanOrEqual(0.25);
  });

  it('counts unhandled rejections by kind', async () => {
    const before = getUnhandledRejections();
    incrementUnhandledRejections('other');
    const text = await make().render();

    expect(text).toContain('# TYPE openwa_unhandled_rejections_total counter');
    expect(sample(text, 'openwa_unhandled_rejections_total{kind="other"}')).toBe(before.other + 1);
    expect(sample(text, 'openwa_unhandled_rejections_total{kind="page_context_lost"}')).toBe(before.page_context_lost);
  });

  it('reports job counts per queue and state', async () => {
    const text = await make(
      queue(() => Promise.resolve({ wait: 4, active: 1, delayed: 2, failed: 3 })),
      queue(() => Promise.resolve({ wait: 0, active: 0, delayed: 0, failed: 7 })),
    ).render();

    expect(text).toContain('# TYPE openwa_queue_jobs gauge');
    expect(text).toContain('openwa_queue_jobs{queue="webhook-queue",state="wait"} 4');
    expect(text).toContain('openwa_queue_jobs{queue="webhook-queue",state="failed"} 3');
    expect(text).toContain('openwa_queue_jobs{queue="ingress-queue",state="failed"} 7');
  });

  it('omits a queue whose read fails or hangs instead of reporting zero', async () => {
    jest.useFakeTimers();
    const rendering = make(
      queue(() => new Promise(() => undefined)),
      queue(() => Promise.reject(new Error('Connection is closed.'))),
    ).render();
    await jest.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS);
    const text = await rendering;

    expect(text).toContain('openwa_up 1');
    expect(text).not.toContain('openwa_queue_jobs');
  });

  it('leaves no job-count read pending on a queue whose Redis has never connected', async () => {
    jest.useFakeTimers();
    const getJobCounts = jest.fn(() => Promise.resolve({ wait: 1, active: 0, delayed: 0, failed: 0 }));
    const svc = make({ waitUntilReady: () => new Promise(() => undefined), getJobCounts } as unknown as Queue);

    const rendering = svc.render();
    await jest.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS);
    expect(await rendering).not.toContain('openwa_queue_jobs');

    // Once the first-connect wait has passed, a scrape skips the queue without waiting.
    await jest.advanceTimersByTimeAsync(producerConnectWaitMs());
    (svc as unknown as { cachedRender: unknown }).cachedRender = null;
    expect(await svc.render()).not.toContain('openwa_queue_jobs');
    expect(getJobCounts).not.toHaveBeenCalled();
  });

  it('keeps the healthy queue when only the other one fails', async () => {
    const text = await make(
      queue(() => Promise.resolve({ wait: 1, active: 0, delayed: 0, failed: 0 })),
      queue(() => Promise.reject(new Error('Connection is closed.'))),
    ).render();

    expect(text).toContain('openwa_queue_jobs{queue="webhook-queue",state="wait"} 1');
    expect(text).not.toContain('queue="ingress-queue"');
  });

  it('emits no queue series when the queue is disabled', async () => {
    expect(await make().render()).not.toContain('openwa_queue_jobs');
  });
});
