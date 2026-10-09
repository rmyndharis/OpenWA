import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import configuration from '../../config/configuration';
import { LoggerModule } from './logger.module';
import { SHUTDOWN_TEARDOWN_LIMIT_MS } from './shutdown-budget';
import { ShutdownService } from './shutdown.service';

/**
 * Regression lock: shutdown must flip a draining flag the readiness probe can
 * read, so the LB stops routing before teardown. (shutdown() itself calls process.exit
 * and is not invoked here.)
 */
describe('ShutdownService (draining flag)', () => {
  it('is not draining initially', () => {
    expect(new ShutdownService().isShuttingDown()).toBe(false);
  });

  it('markShuttingDown flips the flag and is idempotent', () => {
    const svc = new ShutdownService();
    svc.markShuttingDown();
    expect(svc.isShuttingDown()).toBe(true);
    svc.markShuttingDown(); // no throw, stays true
    expect(svc.isShuttingDown()).toBe(true);
  });
});

describe('ShutdownService.shutdown (idempotent, bounded grace)', () => {
  let exitSpy: jest.SpyInstance;
  const ORIG_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    exitSpy.mockRestore();
    delete process.env.SHUTDOWN_DELAY_MS;
    if (ORIG_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIG_ENV;
  });

  const svcWithCb = (): { svc: ShutdownService; cb: jest.Mock } => {
    const svc = new ShutdownService();
    const cb = jest.fn().mockResolvedValue(undefined);
    svc.setShutdownCallback(cb);
    return { svc, cb };
  };

  it('flips the draining flag synchronously, before the grace elapses', () => {
    process.env.SHUTDOWN_DELAY_MS = '5000';
    const { svc } = svcWithCb();
    svc.shutdown();
    expect(svc.isShuttingDown()).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('marks teardown only once the grace has elapsed, before the teardown callback runs', async () => {
    process.env.SHUTDOWN_DELAY_MS = '2000';
    const svc = new ShutdownService();
    let tearingDownInCallback: boolean | undefined;
    svc.setShutdownCallback(() => {
      tearingDownInCallback = svc.isTearingDown();
      return Promise.resolve();
    });
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(1999);
    expect(svc.isTearingDown()).toBe(false); // still draining: requests are served
    await jest.advanceTimersByTimeAsync(1);
    expect(tearingDownInCallback).toBe(true);
  });

  it('runs the teardown callback and exits exactly once even when called repeatedly', async () => {
    process.env.SHUTDOWN_DELAY_MS = '0';
    const { svc, cb } = svcWithCb();
    svc.shutdown();
    svc.shutdown(); // repeated signal / admin-restart overlap — must be a no-op
    svc.shutdown();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('defaults the grace to 0 only for an explicit development/test env (fast dev hot-reload / Ctrl+C)', async () => {
    for (const env of ['development', 'test']) {
      process.env.NODE_ENV = env;
      delete process.env.SHUTDOWN_DELAY_MS;
      const { svc, cb } = svcWithCb();
      svc.shutdown();
      await jest.advanceTimersByTimeAsync(0);
      expect(cb).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the full 3s drain window in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SHUTDOWN_DELAY_MS;
    const { svc, cb } = svcWithCb();
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(cb).not.toHaveBeenCalled(); // grace has not elapsed
    await jest.advanceTimersByTimeAsync(3000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('keeps the 3s drain window when NODE_ENV is UNSET (an ad-hoc run outside the packaged runtimes)', async () => {
    // Regression guard: an unset NODE_ENV must NOT collapse the drain to 0 — only an explicit
    // dev/test does. Otherwise a rolling deploy loses its readiness window.
    delete process.env.NODE_ENV;
    delete process.env.SHUTDOWN_DELAY_MS;
    const { svc, cb } = svcWithCb();
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(cb).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(3000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('honours an explicit SHUTDOWN_DELAY_MS even outside production', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SHUTDOWN_DELAY_MS = '2000';
    const { svc, cb } = svcWithCb();
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(cb).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2000);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('ShutdownService exit status (teardown outcome)', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
    process.env.SHUTDOWN_DELAY_MS = '0';
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    exitSpy.mockRestore();
    delete process.env.SHUTDOWN_DELAY_MS;
  });

  it('exits 0 after a clean teardown', async () => {
    const svc = new ShutdownService();
    svc.setShutdownCallback(jest.fn().mockResolvedValue(undefined));
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when the teardown callback rejects (a failed drain is not a clean shutdown)', async () => {
    const svc = new ShutdownService();
    svc.setShutdownCallback(jest.fn().mockRejectedValue(new Error('engine disconnect wedged')));
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits non-zero when the teardown callback throws synchronously', async () => {
    const svc = new ShutdownService();
    svc.setShutdownCallback(
      jest.fn().mockImplementation(() => {
        throw new Error('sync failure');
      }),
    );
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('ShutdownService force-exit backstop', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    exitSpy.mockRestore();
    delete process.env.SHUTDOWN_DELAY_MS;
  });

  const hung = (delay: string, webhookDrainMs?: number): ShutdownService => {
    process.env.SHUTDOWN_DELAY_MS = delay;
    const config = { get: () => webhookDrainMs } as unknown as ConfigService;
    const svc = new ShutdownService(webhookDrainMs === undefined ? undefined : config);
    svc.setShutdownCallback(() => new Promise<void>(() => undefined));
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    return svc;
  };

  it('exits 1 exactly at SHUTDOWN_TEARDOWN_LIMIT_MS after the grace when teardown never finishes', async () => {
    hung('0').shutdown();
    await jest.advanceTimersByTimeAsync(SHUTDOWN_TEARDOWN_LIMIT_MS - 1);
    expect(exitSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('measures the limit from the end of the grace, so a raised SHUTDOWN_DELAY_MS moves the exit with it', async () => {
    hung('20000').shutdown();
    await jest.advanceTimersByTimeAsync(20_000 + SHUTDOWN_TEARDOWN_LIMIT_MS - 1);
    expect(exitSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('adds the excess of WEBHOOK_SHUTDOWN_DRAIN_MS over its 5 s default to the limit', async () => {
    hung('0', 15_000).shutdown();
    await jest.advanceTimersByTimeAsync(SHUTDOWN_TEARDOWN_LIMIT_MS + 10_000 - 1);
    expect(exitSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('lowers the limit for a drain shorter than the default', async () => {
    hung('0', 0).shutdown();
    await jest.advanceTimersByTimeAsync(SHUTDOWN_TEARDOWN_LIMIT_MS - 5_000);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps the timer inside what Node accepts for an enormous drain', async () => {
    hung('0', Number.MAX_SAFE_INTEGER).shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(exitSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2 ** 31 - 2);
    expect(exitSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('is cleared when teardown completes, so no second exit follows', async () => {
    process.env.SHUTDOWN_DELAY_MS = '0';
    const svc = new ShutdownService();
    svc.setShutdownCallback(jest.fn().mockResolvedValue(undefined));
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    await jest.advanceTimersByTimeAsync(SHUTDOWN_TEARDOWN_LIMIT_MS);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('is cleared when teardown fails, leaving the single exit(1) of the failure', async () => {
    process.env.SHUTDOWN_DELAY_MS = '0';
    const svc = new ShutdownService();
    svc.setShutdownCallback(jest.fn().mockRejectedValue(new Error('boom')));
    jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(SHUTDOWN_TEARDOWN_LIMIT_MS);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Fake timers make unref a no-op, so the handle of the budget timer is watched directly.
  it('keeps the timer referenced, so a teardown parked on a handle-less promise cannot exit 0', async () => {
    const real = global.setTimeout;
    const unrefs: jest.SpyInstance[] = [];
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn: () => void, ms?: number) => {
      const handle = real(fn, ms);
      if (ms === SHUTDOWN_TEARDOWN_LIMIT_MS) unrefs.push(jest.spyOn(handle, 'unref'));
      return handle;
    });
    try {
      hung('0').shutdown();
      await jest.advanceTimersByTimeAsync(0);
      expect(unrefs).toHaveLength(1);
      expect(unrefs[0]).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('arms one timer however often shutdown is requested', async () => {
    const svc = hung('0');
    svc.shutdown();
    svc.shutdown();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(SHUTDOWN_TEARDOWN_LIMIT_MS);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  // The constructor parameter is @Optional(), so a wiring break would silently fall back to the default
  // drain and the force-exit would stop following WEBHOOK_SHUTDOWN_DRAIN_MS.
  it('receives the real ConfigService, so the exit follows WEBHOOK_SHUTDOWN_DRAIN_MS', async () => {
    process.env.WEBHOOK_SHUTDOWN_DRAIN_MS = '12000';
    process.env.SHUTDOWN_DELAY_MS = '0';
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [configuration] }), LoggerModule],
      }).compile();
      const svc = moduleRef.get(ShutdownService);
      svc.setShutdownCallback(() => new Promise<void>(() => undefined));
      jest.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
      svc.shutdown();
      await jest.advanceTimersByTimeAsync(SHUTDOWN_TEARDOWN_LIMIT_MS + 7_000 - 1);
      expect(exitSpy).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.WEBHOOK_SHUTDOWN_DRAIN_MS;
    }
  });
});
