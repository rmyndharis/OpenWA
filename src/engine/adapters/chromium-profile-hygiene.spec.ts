import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { killOrphanedChromiumProcesses, removeStaleSingletonFiles } from './chromium-profile-hygiene';

// The real child_process, except that the command 'ps' is rewritten to a fake script set per test, or made to throw
// the way spawn does for every errno but EACCES, EAGAIN, EMFILE, ENFILE and ENOENT.
let fakePs = '';
let spawnThrows = false;
// When set, ps answers with this table before execFile has returned, as a mocked execFile does.
let answerAtOnce: string | undefined;
jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: (file: string, ...rest: unknown[]) => {
      if (spawnThrows) throw Object.assign(new Error('spawn ps ENOMEM'), { code: 'ENOMEM', errno: -12 });
      if (answerAtOnce !== undefined) {
        const callback = rest[rest.length - 1] as (error: null, stdout: string) => void;
        callback(null, answerAtOnce);
        return undefined;
      }
      return (actual.execFile as unknown as (...args: unknown[]) => unknown)(
        file === 'ps' && fakePs ? fakePs : file,
        ...rest,
      );
    },
  };
});

// Both steps run before the browser launches and are best-effort: a call that hangs is as harmless as one that throws.
jest.setTimeout(20_000);

const sleepMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
// The outcome of `work`, or 'still pending' after `ms`; the timer is cleared so the test leaves no handle behind.
const settledWithin = async (work: Promise<unknown>, ms: number): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => 'settled'),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve('still pending'), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('killOrphanedChromiumProcesses: a ps that does not answer', () => {
  const dirs: string[] = [];
  let pidFile = '';

  const installFakePs = (body: (pidFile: string) => string): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-ps-'));
    dirs.push(dir);
    pidFile = path.join(dir, 'ps.pid');
    const script = path.join(dir, 'ps');
    fs.writeFileSync(script, body(pidFile), { mode: 0o755 });
    fakePs = script;
  };

  const waitForPid = async (): Promise<number> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fs.existsSync(pidFile)) {
        const text = fs.readFileSync(pidFile, 'utf8').trim();
        if (text) return Number(text);
      }
      await sleepMs(20);
    }
    throw new Error('the fake ps never started');
  };

  afterEach(() => {
    fakePs = '';
    spawnThrows = false;
    answerAtOnce = undefined;
    jest.useRealTimers();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // The deadline is armed after execFile returns. Armed before, a spawn that throws left a timer that later read the
  // child it never got, and a throw from a timer ends the process.
  it('leaves no timer behind when the spawn itself throws', async () => {
    jest.useFakeTimers();
    spawnThrows = true;
    const logger = { debug: jest.fn(), log: jest.fn() };

    await expect(killOrphanedChromiumProcesses('s1', logger, 5_000)).resolves.toBeUndefined();

    expect(logger.debug).toHaveBeenCalledWith(
      'Could not enumerate processes for the orphaned Chromium sweep',
      expect.objectContaining({ error: expect.stringContaining('ENOMEM') as string }),
    );
    expect(jest.getTimerCount()).toBe(0);
    expect(() => jest.advanceTimersByTime(10_000)).not.toThrow();
  });

  // The deadline is armed before the spawn: armed after it, an answer that comes before execFile has returned ran its
  // callback against a timer that did not exist yet, and the sweep killed nothing.
  it('kills the orphan when ps answers before execFile has returned', async () => {
    answerAtOnce = '  1501 /opt/chrome/chrome --headless --openwa-session=s1\n   77 /bin/sh -c sleep 1\n';
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const logger = { debug: jest.fn(), log: jest.fn() };
    try {
      await expect(killOrphanedChromiumProcesses('s1', logger, 5_000)).resolves.toBeUndefined();

      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(1501, 'SIGKILL');
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Killed 1 orphaned Chromium'), {
        sessionId: 's1',
        pids: [1501],
      });
    } finally {
      kill.mockRestore();
    }
  });

  it('control: a ps that answers at once lets the sweep resolve', async () => {
    installFakePs(() => '#!/bin/sh\nexit 0\n');
    const logger = { debug: jest.fn(), log: jest.fn() };

    await expect(killOrphanedChromiumProcesses('s1', logger, 5_000)).resolves.toBeUndefined();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('gives up after the deadline, kills the ps and logs it, instead of holding the start', async () => {
    installFakePs(file => '#!/bin/sh\necho $$ > "' + file + '"\nexec sleep 600\n');
    const logger = { debug: jest.fn(), log: jest.fn() };

    const sweep = killOrphanedChromiumProcesses('s1', logger, 300);
    const pid = await waitForPid();
    const started = Date.now();
    const outcome = await settledWithin(sweep, 3000);
    try {
      expect(outcome).toBe('settled');
      expect(Date.now() - started).toBeLessThan(2000);
      expect(logger.debug).toHaveBeenCalledWith(
        'Could not enumerate processes for the orphaned Chromium sweep',
        expect.objectContaining({ error: expect.stringContaining('did not answer within 300 ms') as string }),
      );
      await sleepMs(200);
      expect(alive(pid)).toBe(false); // the child it started is not left behind
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL'); // exact pid of the fake ps this test started
    }
  });
});

describe('removeStaleSingletonFiles: a removal that does not return', () => {
  afterEach(() => jest.restoreAllMocks());

  it('control: removes the three lock files and says nothing', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-data-'));
    try {
      const profile = path.join(data, 'session-s1');
      fs.mkdirSync(profile, { recursive: true });
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Cookies']) {
        fs.writeFileSync(path.join(profile, name), 'x');
      }
      const logger = { debug: jest.fn(), log: jest.fn() };

      await removeStaleSingletonFiles('s1', data, logger, 5_000);

      expect(fs.readdirSync(profile)).toEqual(['Cookies']);
      expect(logger.debug).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  // The loop cannot be cancelled, so the files after the one in flight must not be issued late: by then the browser the
  // start went on to launch may have created its own.
  it('does not remove the remaining files once the start has gone on', async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-late-'));
    try {
      const profile = path.join(data, 'session-s1');
      fs.mkdirSync(profile, { recursive: true });
      for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        fs.writeFileSync(path.join(profile, name), 'stale');
      }
      const realRm = fs.promises.rm.bind(fs.promises);
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      let calls = 0;
      jest.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
        if (calls++ === 0) await gate; // the first removal waits on the slow volume
        return realRm(target, options);
      });
      const logger = { debug: jest.fn(), log: jest.fn() };

      await removeStaleSingletonFiles('s1', data, logger, 50); // returns at the deadline, the first rm still pending
      fs.writeFileSync(path.join(profile, 'SingletonSocket'), 'fresh'); // the browser the start went on to launch
      fs.writeFileSync(path.join(profile, 'SingletonCookie'), 'fresh');
      release();
      await sleepMs(150);

      expect(calls).toBe(1);
      expect(fs.existsSync(path.join(profile, 'SingletonSocket'))).toBe(true);
      expect(fs.existsSync(path.join(profile, 'SingletonCookie'))).toBe(true);
    } finally {
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  it('returns after the deadline and logs it, instead of holding the start', async () => {
    jest.spyOn(fs.promises, 'rm').mockImplementation(() => new Promise<void>(() => undefined));
    const logger = { debug: jest.fn(), log: jest.fn() };

    const outcome = await settledWithin(removeStaleSingletonFiles('s1', './data/sessions', logger, 100), 3000);

    expect(outcome).toBe('settled');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/took over 100 ms; starting without it/));
  });
});
