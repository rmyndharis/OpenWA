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

  it('keeps the 3s drain window when NODE_ENV is UNSET (a bare `docker run` / k8s pod)', async () => {
    // Regression guard: the runtime image does not set NODE_ENV, so an unset env must NOT collapse the
    // drain to 0 — only an explicit dev/test does. Otherwise a rolling deploy loses its readiness window.
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
