import { ConfigService } from '@nestjs/config';
import { MetricsService } from './metrics.service';
import { OverviewStats, StatsService } from '../stats/stats.service';

// Two scrapes that arrive together (two Prometheus replicas, or a scrape beside a manual curl) must both be
// answered from the same measurement. The event-loop series are read and then reset by a render, and the
// render a scrape gets is also the one cached for the next five seconds.
describe('MetricsService concurrent scrapes', () => {
  const overview: OverviewStats = {
    sessions: { active: 0, total: 0, byStatus: {} },
    messages: { sent: 0, received: 0, failed: 0, today: { sent: 0, received: 0 } },
  };

  const loopMax = (text: string): number =>
    Number(/^openwa_event_loop_delay_max_seconds (\S+)$/m.exec(text)?.[1] ?? Number.NaN);

  const makeService = (): { svc: MetricsService; getOverview: jest.Mock } => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const getOverview = jest.fn(() => new Promise<OverviewStats>(resolve => setTimeout(() => resolve(overview), 20)));
    const stats = { getOverview } as unknown as StatsService;
    return { svc: new MetricsService(config, stats), getOverview };
  };

  afterEach(() => jest.restoreAllMocks());

  it('reports the same event-loop delay to scrapes that arrive together', async () => {
    const { svc, getOverview } = makeService();
    try {
      // Block the loop for 300 ms, then let the sampler tick once so the stall is recorded.
      const until = Date.now() + 300;
      while (Date.now() < until) {
        // busy wait
      }
      await new Promise(resolve => setTimeout(resolve, 40));

      const [first, second] = await Promise.all([svc.render(), svc.render()]);
      const cached = await svc.render();

      expect(loopMax(first)).toBeGreaterThan(0.2);
      expect({ second: loopMax(second), cached: loopMax(cached) }).toEqual({
        second: loopMax(first),
        cached: loopMax(first),
      });
      expect(getOverview).toHaveBeenCalledTimes(1);
    } finally {
      svc.onModuleDestroy();
    }
  });

  it('answers every scrape that overlaps a failed render with that failure, and renders again afterwards', async () => {
    const { svc } = makeService();
    try {
      jest.spyOn(process, 'memoryUsage').mockImplementationOnce(() => {
        throw new Error('render failed');
      });

      const overlapping = await Promise.allSettled([svc.render(), svc.render()]);
      expect(overlapping.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);

      expect(await svc.render()).toContain('openwa_up 1');
    } finally {
      svc.onModuleDestroy();
    }
  });
});
