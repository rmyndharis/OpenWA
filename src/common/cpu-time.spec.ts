import { leastCpuMs, leastCpuMsAsync } from '../../test/helpers/cpu-time';

describe('leastCpuMs', () => {
  /** A clock whose n-th window reads `values[n]` milliseconds. A window opens with no argument and closes with one. */
  const clock = (values: number[]): string[] => {
    const events: string[] = [];
    let run = 0;
    jest.spyOn(process, 'cpuUsage').mockImplementation((since?: NodeJS.CpuUsage) => {
      events.push(since ? 'read' : 'open');
      return since ? { user: values[run++] * 1000, system: 0 } : { user: 0, system: 0 };
    });
    return events;
  };

  afterEach(() => jest.restoreAllMocks());

  it('reads the smallest of three runs, so a run that a collection fell into does not count', () => {
    clock([1400, 50, 60]);
    const run = jest.fn();

    expect(leastCpuMs(run)).toBe(50);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('reads a call that is slow in every run as slow', () => {
    clock([5000, 4800, 5200]);

    expect(leastCpuMs(() => undefined)).toBe(4800);
  });

  it('adds the user and the system time of a run, and takes the number of runs it is given', () => {
    let run = 0;
    jest.spyOn(process, 'cpuUsage').mockImplementation((since?: NodeJS.CpuUsage) => {
      return since ? { user: 2000 * ++run, system: 500 } : { user: 0, system: 0 };
    });

    expect(leastCpuMs(() => undefined, 2)).toBe(2.5);
    expect(run).toBe(2);
  });

  it('awaits each run before it reads the window', async () => {
    const events = clock([900, 40, 70]);

    const cpuMs = await leastCpuMsAsync(async () => {
      await Promise.resolve();
      events.push('work');
    });

    expect(cpuMs).toBe(40);
    expect(events).toEqual(['open', 'work', 'read', 'open', 'work', 'read', 'open', 'work', 'read']);
  });
});
