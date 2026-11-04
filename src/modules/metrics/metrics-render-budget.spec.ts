import { MetricsService, METRICS_RENDER_TTL_MS, STATS_STALE_MAX_MS } from './metrics.service';
import { StatsService, type OverviewStats } from '../stats/stats.service';

const STATS_BUDGET_MS = 2000;
const overview: OverviewStats = {
  sessions: { active: 2, total: 3, byStatus: { ready: 2, failed: 1 } },
  messages: { sent: 4, received: 5, failed: 1, today: { sent: 1, received: 1 } },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const services: MetricsService[] = [];
function fixture(read: () => Promise<OverviewStats>) {
  // This stand-in has no cache or inflight map, matching a disabled stats memo.
  const stats = { getOverview: jest.fn(read) };
  const config = {
    get: (key: string) => (key === 'METRICS_TOKEN' ? 'fixture-token' : key === 'stats.cacheTtlMs' ? 0 : undefined),
  };
  const service = new MetricsService(config as never, stats as never);
  services.push(service);
  const scrape = () => {
    service.assertScrapeAuthorized('Bearer fixture-token', {
      headers: {},
      socket: { remoteAddress: '192.0.2.1' },
    });
    return service.render();
  };
  return { service, stats, scrape };
}
const observe = (pending: Promise<string>) => {
  const result: { text?: string; error?: unknown } = {};
  const done = pending.then(
    text => {
      result.text = text;
    },
    error => {
      result.error = error;
    },
  );
  return { result, done };
};
function degraded(result: { text?: string; error?: unknown }) {
  expect(result.error).toBeUndefined();
  expect(result.text).toBeDefined();
  expect(result.text).toContain('openwa_up 1');
  expect(result.text).toContain('openwa_stats_available 0');
  expect(result.text).toContain('openwa_process_resident_memory_bytes');
  expect(result.text).toContain('openwa_webhook_delivery_failures_total');
  expect(result.text).not.toContain('openwa_sessions_active');
  expect(result.text).not.toContain('openwa_messages_total');
}

describe('MetricsService bounded degraded renders', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1000000 }));
  afterEach(() => {
    for (const service of services.splice(0)) service.onModuleDestroy();
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('returns independent process series after a pending stats read spends its budget', async () => {
    const held = deferred<OverviewStats>();
    const f = fixture(() => held.promise);
    const call = observe(f.scrape());
    try {
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      degraded(call.result);
      expect(f.stats.getOverview).toHaveBeenCalledTimes(1);
    } finally {
      held.resolve(overview);
      await call.done;
    }
  });

  it('shares one pending overview across concurrent and repeated uncached scrapes', async () => {
    const held = deferred<OverviewStats>();
    const f = fixture(() => held.promise);
    const calls = [observe(f.scrape()), observe(f.scrape())];
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(f.stats.getOverview).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      calls.forEach(call => degraded(call.result));
      const cached = observe(f.scrape());
      calls.push(cached);
      await jest.advanceTimersByTimeAsync(0);
      degraded(cached.result);
      await jest.advanceTimersByTimeAsync(METRICS_RENDER_TTL_MS + 1);
      const repeated = observe(f.scrape());
      calls.push(repeated);
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      degraded(repeated.result);
      expect(f.stats.getOverview).toHaveBeenCalledTimes(1);
    } finally {
      held.resolve(overview);
      await Promise.all(calls.map(call => call.done));
    }
  });

  it.each(['resolve', 'reject'] as const)('ignores a late %s after a newer degraded render', async outcome => {
    const held = deferred<OverviewStats>();
    const f = fixture(() => held.promise);
    const uptime = jest.spyOn(process, 'uptime').mockReturnValue(100);
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', listener);
    const calls = [observe(f.scrape())];
    try {
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      degraded(calls[0].result);
      await jest.advanceTimersByTimeAsync(METRICS_RENDER_TTL_MS + 1);
      uptime.mockReturnValue(200);
      const newer = observe(f.scrape());
      calls.push(newer);
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      degraded(newer.result);
      expect(newer.result.text).toContain('openwa_process_uptime_seconds 200');
      expect(f.stats.getOverview).toHaveBeenCalledTimes(1);
      if (outcome === 'resolve') held.resolve(overview);
      else held.reject(new Error('late stats failure'));
      await jest.advanceTimersByTimeAsync(1);
      expect(await f.scrape()).toBe(newer.result.text);
      expect(unhandled).toEqual([]);
    } finally {
      held.resolve(overview);
      await Promise.allSettled([held.promise, ...calls.map(call => call.done)]);
      process.removeListener('unhandledRejection', listener);
    }
  });

  it('keeps the numbers of a newer read when a read given up on settles afterwards', async () => {
    const abandoned = deferred<OverviewStats>();
    const hung = deferred<OverviewStats>();
    const newer: OverviewStats = { ...overview, sessions: { ...overview.sessions, active: 7 } };
    const f = fixture(() => abandoned.promise);
    f.stats.getOverview.mockImplementationOnce(() => abandoned.promise);
    f.stats.getOverview.mockImplementationOnce(() => Promise.resolve(newer));
    f.stats.getOverview.mockImplementationOnce(() => hung.promise);
    const calls = [observe(f.scrape())];
    try {
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      degraded(calls[0].result);
      await jest.advanceTimersByTimeAsync(STATS_STALE_MAX_MS);
      const second = await f.scrape();
      expect(f.stats.getOverview).toHaveBeenCalledTimes(2);
      expect(second).toContain('openwa_sessions_active 7');

      abandoned.resolve(overview);
      await jest.advanceTimersByTimeAsync(METRICS_RENDER_TTL_MS + 1);
      const third = observe(f.scrape());
      calls.push(third);
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      expect(f.stats.getOverview).toHaveBeenCalledTimes(3);
      expect(third.result.text).toContain('openwa_stats_available 1');
      expect(third.result.text).toContain('openwa_sessions_active 7');
    } finally {
      abandoned.resolve(overview);
      hung.resolve(overview);
      await Promise.all(calls.map(call => call.done));
    }
  });

  it('retains healthy values and serves the completed render from cache', async () => {
    const f = fixture(() => Promise.resolve(overview));
    const first = await f.scrape();
    expect(first).toContain('openwa_stats_available 1');
    expect(first).toContain('openwa_sessions_active 2');
    expect(await f.scrape()).toBe(first);
    expect(f.stats.getOverview).toHaveBeenCalledTimes(1);
  });

  it('omits only database series when the overview immediately rejects', async () => {
    const f = fixture(() => Promise.reject(new Error('stats unavailable')));
    const call = observe(f.scrape());
    await jest.advanceTimersByTimeAsync(0);
    await call.done;
    degraded(call.result);
    expect(f.stats.getOverview).toHaveBeenCalledTimes(1);
  });

  it('clears wait timers and resumes database series after a timed-out read settles', async () => {
    const held = deferred<OverviewStats>();
    const f = fixture(() => Promise.resolve(overview));
    f.stats.getOverview.mockImplementationOnce(() => held.promise);
    const samplerTimers = jest.getTimerCount();
    const call = observe(f.scrape());
    try {
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      degraded(call.result);
      expect(jest.getTimerCount()).toBe(samplerTimers);
      held.resolve(overview);
      await jest.advanceTimersByTimeAsync(0);
      expect(await f.scrape()).toBe(call.result.text);
      await jest.advanceTimersByTimeAsync(METRICS_RENDER_TTL_MS + 1);
      const recovered = await f.scrape();
      expect(recovered).toContain('openwa_stats_available 1');
      expect(recovered).toContain('openwa_sessions_active 2');
      expect(f.stats.getOverview).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(samplerTimers);
    } finally {
      held.resolve(overview);
      await call.done;
    }
  });

  it('reuses a timed-out wait without starting another deadline while its read is pending', async () => {
    const held = deferred<OverviewStats>();
    const f = fixture(() => held.promise);
    const calls = [observe(f.scrape())];
    try {
      await jest.advanceTimersByTimeAsync(STATS_BUDGET_MS);
      degraded(calls[0].result);
      await jest.advanceTimersByTimeAsync(METRICS_RENDER_TTL_MS + 1);
      const samplerTimers = jest.getTimerCount();
      const repeated = observe(f.scrape());
      calls.push(repeated);
      await jest.advanceTimersByTimeAsync(0);
      degraded(repeated.result);
      expect(f.stats.getOverview).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(samplerTimers);
    } finally {
      held.resolve(overview);
      await Promise.all(calls.map(call => call.done));
    }
  });
});

describe('MetricsService statistics slower than its budget, with the real stats memo', () => {
  // The memo lives 30 s from completion, so a scan of 3 s run by a scrape every 15 s or 60 s always meets it cold.
  const SCAN_MS = 3000;
  const later = <T>(value: T, delay = SCAN_MS) => new Promise<T>(resolve => setTimeout(() => resolve(value), delay));
  function slowDatabase() {
    const state: { fail: boolean; delay: number; hang?: { promise: Promise<unknown[]>; release: () => void } } = {
      fail: false,
      delay: SCAN_MS,
    };
    const hold = () => {
      let release!: () => void;
      const promise = new Promise<unknown[]>(resolve => {
        release = () => resolve([{ status: 'ready' }]);
      });
      state.hang = { promise, release };
    };
    const query = (): Record<string, unknown> => {
      const chain: Record<string, unknown> = {};
      for (const step of ['select', 'addSelect', 'where', 'groupBy']) chain[step] = () => chain;
      chain.getRawMany = () => later([{ direction: 'outgoing', count: '4' }], state.delay);
      return chain;
    };
    const sessions = {
      find: () =>
        state.hang
          ? state.hang.promise
          : state.fail
            ? Promise.reject(new Error('pool exhausted'))
            : later([{ status: 'ready' }], state.delay),
    };
    const messages = { createQueryBuilder: query, count: () => later(1, state.delay) };
    const stats = new StatsService(
      sessions as never,
      messages as never,
      {
        get: (key: string, fallback?: unknown) => (key === 'stats.cacheTtlMs' ? 30000 : fallback),
      } as never,
    );
    const service = new MetricsService(
      { get: (key: string) => (key === 'METRICS_TOKEN' ? 'fixture-token' : undefined) } as never,
      stats,
    );
    services.push(service);
    const scrape = () => {
      service.assertScrapeAuthorized('Bearer fixture-token', { headers: {}, socket: { remoteAddress: '192.0.2.1' } });
      return service.render();
    };
    return { state, hold, scrape };
  }
  const scrapeAfter = async (scrape: () => Promise<string>, interval: number): Promise<string> => {
    const pending = scrape();
    await jest.advanceTimersByTimeAsync(interval);
    return pending;
  };

  beforeEach(() => jest.useFakeTimers({ now: 1000000 }));
  afterEach(() => {
    for (const service of services.splice(0)) service.onModuleDestroy();
    jest.clearAllTimers();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([15_000, 60_000])('keeps the database series on every scrape after the first, at %i ms', async interval => {
    const db = slowDatabase();
    const texts: string[] = [];
    for (let i = 0; i < 6; i++) texts.push(await scrapeAfter(db.scrape, interval));

    expect(texts[0]).toContain('openwa_stats_available 0');
    for (const text of texts.slice(1)) {
      expect(text).toContain('openwa_stats_available 1');
      expect(text).toContain('openwa_sessions_active');
      expect(text).toContain('openwa_messages_total{direction="outgoing"} 4');
    }
  });

  it('stops serving the kept result 5 minutes after its read started while a read hangs, then recovers', async () => {
    const db = slowDatabase();
    db.state.delay = 0;
    expect(await scrapeAfter(db.scrape, 60_000)).toContain('openwa_stats_available 1');
    db.hold();

    const flags: string[] = [];
    // Scrapes at 60 s steps from the good read: ages 62 s to 242 s are served from the kept result.
    for (let i = 0; i < 4; i++) flags.push(await scrapeAfter(db.scrape, 60_000));
    for (const text of flags) {
      expect(text).toContain('openwa_stats_available 1');
      expect(text).toContain('openwa_messages_total{direction="outgoing"} 4');
    }
    // At 5 minutes the kept result is too old, and so is the read: it is given up on and a new one starts.
    for (let i = 0; i < 2; i++) {
      const text = await scrapeAfter(db.scrape, 60_000);
      expect(text).toContain('openwa_stats_available 0');
      expect(text).not.toContain('openwa_sessions_active');
    }

    db.state.hang!.release();
    await jest.advanceTimersByTimeAsync(METRICS_RENDER_TTL_MS + 1);
    const recovered = await scrapeAfter(db.scrape, 1);
    expect(recovered).toContain('openwa_stats_available 1');
    expect(recovered).toContain('openwa_messages_total{direction="outgoing"} 4');
  });

  it('does not serve numbers from before a failed read when a later read is late', async () => {
    const db = slowDatabase();
    db.state.delay = 0;
    await scrapeAfter(db.scrape, 60_000);
    db.state.fail = true;
    const failed = await scrapeAfter(db.scrape, 60_000);
    expect(failed).toContain('openwa_stats_available 0');
    db.state.fail = false;
    db.state.delay = SCAN_MS;
    const late = await scrapeAfter(db.scrape, 60_000);
    expect(late).toContain('openwa_stats_available 0');
    expect(late).not.toContain('openwa_sessions_active');
    // The late read completed, so it is what the next late read falls back to.
    const next = await scrapeAfter(db.scrape, 60_000);
    expect(next).toContain('openwa_stats_available 1');
  });
});
