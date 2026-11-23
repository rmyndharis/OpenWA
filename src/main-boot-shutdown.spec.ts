import { wireBootstrapShutdown } from './main';

describe('main mid-boot SIGTERM shutdown coordinator', () => {
  it('awaits in-flight app.listen (initPromise) before calling app.close() once', async () => {
    let shuttingDown = false;
    let savedCallback: (() => Promise<void>) | undefined;
    const shutdownService = {
      markShuttingDown: jest.fn(() => {
        shuttingDown = true;
      }),
      isShuttingDown: () => shuttingDown,
      setShutdownCallback: (cb: () => Promise<void>) => {
        savedCallback = cb;
      },
      shutdown: jest.fn(() => {
        shuttingDown = true;
        return savedCallback?.();
      }),
    };

    let initResolved = false;
    let resolveListen!: () => void;
    const closeOrder: string[] = [];
    const app = {
      listen: jest.fn(
        () =>
          new Promise<void>(res => {
            resolveListen = () => {
              initResolved = true;
              closeOrder.push('listen-settled');
              res();
            };
          }),
      ),
      close: jest.fn(() => {
        expect(initResolved).toBe(true);
        closeOrder.push('app-close');
        return Promise.resolve();
      }),
    };

    const controller = wireBootstrapShutdown(shutdownService, () => app);
    const listening = controller.listen(2785);

    // Mid-boot SIGTERM arrives before app.listen settles.
    const sigtermDrain = shutdownService.shutdown();
    await new Promise(resolve => setImmediate(resolve));

    // Must NOT invoke app.close() concurrently while onModuleInit/onApplicationBootstrap are still running.
    expect(app.close).not.toHaveBeenCalled();

    resolveListen();
    await listening;
    await sigtermDrain;
    // Even if bootstrap fatal handler invokes closeApp again, app.close() only runs once.
    await controller.closeAppOnce();

    expect(closeOrder).toEqual(['listen-settled', 'app-close']);
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('skips listen and marks shutting down cleanly when stop signal arrives before listen()', async () => {
    let shuttingDown = false;
    let savedCallback: (() => Promise<void>) | undefined;
    const shutdownService = {
      markShuttingDown: jest.fn(() => {
        shuttingDown = true;
      }),
      isShuttingDown: () => shuttingDown,
      setShutdownCallback: (cb: () => Promise<void>) => {
        savedCallback = cb;
      },
    };
    const app = {
      listen: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const controller = wireBootstrapShutdown(shutdownService, () => app);
    shutdownService.markShuttingDown();

    const listened = await controller.listen(2785);
    expect(listened).toBe(false);
    expect(app.listen).not.toHaveBeenCalled();

    await savedCallback?.();
    await controller.closeAppOnce();
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('does not double-close if app.listen() rejects during a mid-boot SIGTERM', async () => {
    let shuttingDown = false;
    let savedCallback: (() => Promise<void>) | undefined;
    const shutdownService = {
      markShuttingDown: jest.fn(() => {
        shuttingDown = true;
      }),
      isShuttingDown: () => shuttingDown,
      setShutdownCallback: (cb: () => Promise<void>) => {
        savedCallback = cb;
      },
    };
    let rejectListen!: (err: Error) => void;
    const app = {
      listen: jest.fn(
        () =>
          new Promise<void>((_res, rej) => {
            rejectListen = rej;
          }),
      ),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const controller = wireBootstrapShutdown(shutdownService, () => app);
    const listening = controller.listen(2785);
    shutdownService.markShuttingDown();
    const drain = savedCallback!();
    await new Promise(resolve => setImmediate(resolve));
    expect(app.close).not.toHaveBeenCalled();

    rejectListen(new Error('bind failed'));
    await expect(listening).rejects.toThrow('bind failed');
    await drain;
    await controller.closeAppOnce();

    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
