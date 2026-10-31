import { performance } from 'node:perf_hooks';
import { installStopSignalHandlers, STOP_SIGNAL_REPEAT_WINDOW_MS } from './stop-signals';
import { ShutdownService } from '../common/services/shutdown.service';
import { shutdownTeardownLimitMs, DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS } from '../common/services/shutdown-budget';

/**
 * One stop request runs the bounded drain even when it reaches the process twice, which is what npm and
 * the Nest CLI do with one Ctrl+C or one signal to the process group: the parent forwards the signal it
 * received a fraction of a millisecond after the group delivery. Only a repeat a person makes, a second
 * or more after the first, forces the immediate exit.
 */
describe('stop signal handling', () => {
  type Listener = () => void;

  /** Install with a manual clock and a recorded exit, and hand back a way to deliver a signal. */
  const install = (shutdown: () => void) => {
    const listeners = new Map<NodeJS.Signals, Listener>();
    let clock = 0;
    const exit = jest.fn();
    installStopSignalHandlers({
      shutdown,
      exit,
      now: () => clock,
      listen: (signal, listener) => listeners.set(signal, listener),
    });
    return {
      exit,
      at: (ms: number, signal: NodeJS.Signals = 'SIGINT'): void => {
        clock = ms;
        listeners.get(signal)!();
      },
      signals: [...listeners.keys()].sort(),
    };
  };

  it('listens for SIGINT and SIGTERM', () => {
    expect(install(jest.fn()).signals).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('drains once and ignores the duplicate of a single stop request', () => {
    const shutdown = jest.fn();
    const { exit, at } = install(shutdown);

    at(0);
    at(0.2);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('ignores a burst of deliveries of either kind inside the window', () => {
    const shutdown = jest.fn();
    const { exit, at } = install(shutdown);

    at(0, 'SIGTERM');
    at(0.1, 'SIGTERM');
    at(0.3, 'SIGINT');
    at(STOP_SIGNAL_REPEAT_WINDOW_MS - 1, 'SIGTERM');

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('forces exit 130 for a repeat a second or more after the first signal', () => {
    const { exit, at } = install(jest.fn());

    at(0);
    at(STOP_SIGNAL_REPEAT_WINDOW_MS);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('measures the window from the first signal, not the latest repeat', () => {
    const { exit, at } = install(jest.fn());

    at(0);
    at(600);
    expect(exit).not.toHaveBeenCalled();
    at(1200);

    expect(exit).toHaveBeenCalledWith(130);
  });

  it('uses process.on, performance.now and process.exit by default, and stays installed', () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const added: Array<[NodeJS.Signals, Listener]> = [];
    const realOn = process.on.bind(process);
    jest.spyOn(process, 'on').mockImplementation(((event: NodeJS.Signals, listener: Listener) => {
      added.push([event, listener]);
      return realOn(event, listener);
    }) as typeof process.on);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const nowSpy = jest.spyOn(performance, 'now').mockReturnValue(1_000);
    const shutdown = jest.fn();
    try {
      installStopSignalHandlers({ shutdown });

      process.emit('SIGINT');
      nowSpy.mockReturnValue(1_000 + STOP_SIGNAL_REPEAT_WINDOW_MS);
      process.emit('SIGTERM');

      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(130);
      expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
      expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    } finally {
      for (const [event, listener] of added) process.removeListener(event, listener);
      jest.restoreAllMocks();
    }
  });

  describe('with the real shutdown service', () => {
    const envBackup = { ...process.env };
    let exitSpy: jest.SpyInstance;
    let logged: string[];

    beforeEach(() => {
      jest.useFakeTimers();
      exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      logged = [];
      for (const method of ['log', 'warn', 'error'] as const) {
        jest.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
      }
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
      process.env = { ...envBackup };
    });

    /** A service whose teardown never settles, driven by the handlers on one clock. */
    const hungDrain = () => {
      const service = new ShutdownService();
      service.setShutdownCallback(() => new Promise<void>(() => undefined));
      const handlers = install(() => service.shutdown());
      let now = 0;
      return {
        service,
        signal: (signal: NodeJS.Signals = 'SIGINT'): void => handlers.at(now, signal),
        advance: (ms: number): void => {
          now += ms;
          jest.advanceTimersByTime(ms);
        },
        forced: handlers.exit,
      };
    };

    it('drains past a duplicate and still force-exits 1 when the teardown hangs past its budget', () => {
      process.env.NODE_ENV = 'production';
      process.env.SHUTDOWN_DELAY_MS = '3000';
      const drain = hungDrain();

      drain.signal();
      drain.signal();
      drain.advance(3000);

      expect(logged.some(line => line.includes('Initiating shutdown...'))).toBe(true);
      expect(drain.forced).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();

      drain.advance(shutdownTeardownLimitMs(DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS));

      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('lets a deliberate second signal during a hung teardown exit 130 before the budget', () => {
      process.env.NODE_ENV = 'production';
      process.env.SHUTDOWN_DELAY_MS = '3000';
      const drain = hungDrain();

      drain.signal('SIGTERM');
      drain.advance(5000);
      drain.signal('SIGTERM');

      expect(drain.forced).toHaveBeenCalledWith(130);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('ignores the duplicate with no grace, once the teardown has already started', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.SHUTDOWN_DELAY_MS;
      const drain = hungDrain();

      drain.signal();
      drain.advance(0);
      drain.signal();

      expect(drain.service.isTearingDown()).toBe(true);
      expect(drain.forced).not.toHaveBeenCalled();
    });

    it('drains a first real signal during an admin-restart grace and forces only a later repeat', () => {
      process.env.NODE_ENV = 'production';
      process.env.SHUTDOWN_DELAY_MS = '3000';
      const drain = hungDrain();
      drain.service.shutdown();

      drain.signal('SIGTERM');
      expect(drain.forced).not.toHaveBeenCalled();
      drain.advance(STOP_SIGNAL_REPEAT_WINDOW_MS);
      drain.signal('SIGTERM');

      expect(drain.forced).toHaveBeenCalledWith(130);
    });
  });
});
