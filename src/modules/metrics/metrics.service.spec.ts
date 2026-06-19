import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService, METRICS_RENDER_TTL_MS } from './metrics.service';
import { StatsService, OverviewStats } from '../stats/stats.service';

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
      expect(out).toContain('# TYPE openwa_messages_total counter');
      expect(out.endsWith('\n')).toBe(true);
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
