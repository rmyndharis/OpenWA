import { runBootstrapOrExit, BootstrapFatalDeps } from './bootstrap-fatal';

describe('runBootstrapOrExit', () => {
  const makeDeps = () => {
    const logs: Array<[string, string | undefined]> = [];
    const exitCalls: number[] = [];
    const deps: BootstrapFatalDeps = {
      logger: {
        error: (m: string, d?: string) => {
          logs.push([m, d]);
        },
      },
      exit: (code: number) => {
        exitCalls.push(code);
      },
    };
    return { deps, logs, exitCalls };
  };

  it('logs and exits(1) when bootstrap rejects with a bind failure (EADDRINUSE from listen())', async () => {
    const { deps, logs, exitCalls } = makeDeps();
    const err = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:2785'), {
      code: 'EADDRINUSE',
    });
    const closeApp = jest.fn().mockResolvedValue(undefined);

    await runBootstrapOrExit(() => Promise.reject(err), { ...deps, closeApp });

    expect(exitCalls).toEqual([1]);
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toMatch(/Fatal error during bootstrap/);
    expect(logs[0][1]).toContain('EADDRINUSE'); // err.stack
    // Teardown ran BEFORE the exit so sessions/connections don't outlive the process.
    expect(closeApp).toHaveBeenCalledTimes(1);
  });

  it('never logs, tears down, or exits on a successful boot', async () => {
    const { deps, logs, exitCalls } = makeDeps();
    const closeApp = jest.fn().mockResolvedValue(undefined);

    await runBootstrapOrExit(() => Promise.resolve(), { ...deps, closeApp });

    expect(exitCalls).toEqual([]);
    expect(logs).toEqual([]);
    expect(closeApp).not.toHaveBeenCalled();
  });

  it('still exits(1) when the teardown rejects', async () => {
    const { deps, exitCalls } = makeDeps();
    const closeApp = jest.fn().mockRejectedValue(new Error('close wedged'));

    await runBootstrapOrExit(() => Promise.reject(new Error('boom')), { ...deps, closeApp });

    expect(exitCalls).toEqual([1]);
  });

  it('still exits(1) when the teardown hangs past the bound', async () => {
    const { deps, exitCalls } = makeDeps();
    const closeApp = jest.fn(() => new Promise<void>(resolve => setTimeout(resolve, 250)));

    await runBootstrapOrExit(() => Promise.reject(new Error('boom')), { ...deps, closeApp, closeTimeoutMs: 5 });

    expect(exitCalls).toEqual([1]);
    expect(closeApp).toHaveBeenCalledTimes(1);
  });

  it('still exits(1) when the logger throws — the exit is the guarantee', async () => {
    const { deps, exitCalls } = makeDeps();
    deps.logger = {
      error: () => {
        throw new Error('logger is down');
      },
    };

    await runBootstrapOrExit(() => Promise.reject(new Error('boom')), deps);

    expect(exitCalls).toEqual([1]);
  });

  it('stringifies a non-Error rejection without throwing', async () => {
    const { deps, logs, exitCalls } = makeDeps();

    // Deliberately a non-Error rejection: the handler must stringify it and still exit.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await runBootstrapOrExit(() => Promise.reject('a bare string'), deps);

    expect(exitCalls).toEqual([1]);
    expect(logs[0][1]).toContain('a bare string');
  });

  it('skips teardown when no closeApp is provided (failure before app creation)', async () => {
    const { deps, logs, exitCalls } = makeDeps();

    await runBootstrapOrExit(() => Promise.reject(new Error('bad secrets')), deps);

    expect(exitCalls).toEqual([1]);
    expect(logs[0][1]).toContain('bad secrets');
  });
});
