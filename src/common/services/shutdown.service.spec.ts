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
