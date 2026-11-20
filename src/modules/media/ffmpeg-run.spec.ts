import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegConversionError, FfmpegSpawnError, killRunningConversions, probeFfmpeg, runFfmpeg } from './ffmpeg';
import { waitUntil } from '../../../test/helpers/wait-until';

// The real spawn, wrapped so a test can reach the child process it created.
jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: jest.fn(actual.spawn) };
});

/**
 * Exercises the process wrapper itself — the timeout, the output ceiling, and the temp-directory
 * cleanup — none of which the argument-shape tests touch.
 *
 * It runs against a stub standing in for ffmpeg rather than the real binary, for two reasons: the
 * behaviours under test are about how this code handles a child process, not about transcoding, and
 * a suite that needed ffmpeg installed would simply be skipped on most machines, which is the same
 * as not having it.
 */
const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('runFfmpeg', () => {
  let stubPath: string;
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'openwa-ffmpeg-stub-'));
    stubPath = join(workDir, 'fake-ffmpeg');
    // Behaves like ffmpeg to the degree this code depends on: writes the file named last, and
    // reports failure on stderr with a non-zero exit.
    //
    // The mode travels in the ARGUMENTS rather than the environment, because Jest sandboxes
    // process.env while spawn hands the child the real one — a mode set here would never arrive.
    // Passing it as an encoder argument also exercises the fact that those are forwarded verbatim.
    await writeFile(
      stubPath,
      `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffmpeg version stub"; exit 0; fi
mode=ok
for a in "$@"; do
  case "$a" in MODE=*) mode="\${a#MODE=}" ;; esac
  [ "$prev" = "-i" ] && in="$a"
  prev="$a"
  out="$a"
done
case "$mode" in
  fail)  echo "Invalid data found when processing input" >&2; exit 1 ;;
  badinput) echo "$in: Invalid data found when processing input" >&2; exit 1 ;;
  hang)  sleep 10 ;;
  orphan) sleep 10 & echo $! > "$0.pid"; wait ;;
  empty) : > "$out" ;;
  big)   head -c 4096 /dev/zero > "$out" ;;
  argv)  printf '%s ' "$@" > "$out" ;;
  capped) head -c 1025 /dev/zero > "$out" ;;
  *)     printf 'converted-output' > "$out" ;;
esac
`,
    );
    await chmod(stubPath, 0o755);
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** Encoder arguments that put the stub into a given mode. */
  const mode = (name: string): string[] => [`MODE=${name}`];

  const options = (overrides: Partial<Parameters<typeof runFfmpeg>[4]> = {}) => ({
    ffmpegPath: stubPath,
    timeoutMs: 5_000,
    maxOutputBytes: 1024,
    ...overrides,
  });

  /** Temp directories this module creates, so cleanup can be asserted rather than assumed. */
  const convertDirs = async (): Promise<string[]> =>
    (await readdir(tmpdir())).filter(name => name.startsWith('openwa-convert-'));

  // ffmpeg decodes bytes a caller chose, on every Baileys voice note too: it gets no secret of the gateway's.
  // Read from the spawn options: Jest sandboxes process.env, so what the child printed could not tell.
  it('does not hand the gateway environment to ffmpeg', async () => {
    const spawned = jest.mocked(spawn);
    spawned.mockClear();
    process.env.OWA_PROBE_SECRET = 'hunter2';
    try {
      await runFfmpeg(Buffer.from('input'), 'bin', 'ogg', [], options());
    } finally {
      delete process.env.OWA_PROBE_SECRET;
    }

    const env = (spawned.mock.calls[0][2] as { env?: Record<string, string> }).env;
    expect(env).toBeDefined();
    expect(env).not.toHaveProperty('OWA_PROBE_SECRET');
    expect(env).toHaveProperty('PATH');
  });

  // An FFMPEG_PATH wrapper script, or a Windows host, needs a home, a temp directory or the system root.
  it('hands ffmpeg the variables a wrapper script and a Windows process load with', async () => {
    const spawned = jest.mocked(spawn);
    spawned.mockClear();
    const names = ['HOME', 'TEMP', 'TMP', 'SystemRoot'];
    const saved = names.map(name => process.env[name]);
    names.forEach(name => (process.env[name] = `value-of-${name}`));
    try {
      await runFfmpeg(Buffer.from('input'), 'bin', 'ogg', [], options());
    } finally {
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
    }

    const env = (spawned.mock.calls[0][2] as { env?: Record<string, string> }).env;
    for (const name of names) expect(env?.[name]).toBe(`value-of-${name}`);
  });

  it('returns the bytes the process produced', async () => {
    const output = await runFfmpeg(Buffer.from('input'), 'bin', 'ogg', [], options());

    expect(output).toEqual(Buffer.from('converted-output'));
  });

  it('removes its temp directory once it has succeeded', async () => {
    const before = await convertDirs();

    await runFfmpeg(Buffer.from('input'), 'bin', 'ogg', [], options());

    expect(await convertDirs()).toEqual(before);
  });

  // The input is a file, so a failure part-way through would otherwise leave it on the volume.
  it('removes its temp directory even when the conversion fails', async () => {
    const before = await convertDirs();

    await expect(runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('fail'), options())).rejects.toThrow();

    expect(await convertDirs()).toEqual(before);
  });

  it('reports a non-zero exit with the process’s own words', async () => {
    await expect(runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('fail'), options())).rejects.toMatchObject({
      message: expect.stringContaining('exited with code 1') as unknown,
      detail: 'Invalid data found when processing input',
    });
  });

  // ffmpeg names its input by the path it was handed, which is this process's own temp directory and
  // nothing the caller supplied, so it must not reach the reason the caller is shown.
  it('keeps its temp directory out of the reason it reports', async () => {
    await expect(runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('badinput'), options())).rejects.toMatchObject({
      detail: 'in.bin: Invalid data found when processing input',
    });
  });

  // A codec stuck in a loop is the case this defends against, so the kill has to be unconditional.
  it('kills a process that overruns its timeout, rather than waiting on it', async () => {
    const startedAt = Date.now();

    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('hang'), options({ timeoutMs: 200 })),
    ).rejects.toThrow(/timed out after 200ms/);

    // Below the stub's 10s sleep: proves it was killed, not awaited.
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 15_000);

  // The stub's `sleep` is a child of the killed shell and inherits its stderr, as a process under a
  // wrapper script would. Unless the parent lets go of the pipe, it stays open until that child exits
  // and keeps the process from exiting.
  it('releases the stderr pipe when a timed-out process leaves a descendant holding it', async () => {
    const spawned = jest.mocked(spawn);
    spawned.mockClear();
    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('hang'), options({ timeoutMs: 200 })),
    ).rejects.toThrow(/timed out after 200ms/);

    const child = spawned.mock.results[0].value as ChildProcess;
    expect(child.stderr?.destroyed).toBe(true);
  }, 15_000);

  // A wrapper that runs ffmpeg without `exec` leaves the real worker as a grandchild. Killing only the
  // wrapper would free the concurrency slot while that worker keeps running.
  it('kills the whole process group on timeout, not just the direct child', async () => {
    const pidFile = `${stubPath}.pid`;
    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('orphan'), options({ timeoutMs: 300 })),
    ).rejects.toThrow(/timed out after 300ms/);

    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await waitUntil(() => !alive());
      expect(alive()).toBe(false);
    } finally {
      if (alive()) process.kill(grandchild, 'SIGKILL');
    }
  }, 60_000);

  // Each run sits in its own process group, so a signal to the gateway's group never reaches it and its
  // timeout dies with the gateway. Whatever is still running has to be killed on the way out.
  it('kills every running conversion group when the gateway exits', async () => {
    expect(process.listeners('exit')).toContain(killRunningConversions);
    const pidFile = `${stubPath}.pid`;
    await rm(pidFile, { force: true });
    // The run's own timeout is longer than this test may take, so only the kill below can end it.
    const run = runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('orphan'), options({ timeoutMs: 60_000 }));
    const settled = run.catch((error: unknown) => error);

    let grandchild = 0;
    await waitUntil(async () => {
      grandchild = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
      return grandchild > 0;
    });
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      // The stub's own sleep ends in 10 s, so the kill has to land well before that to count: six seconds leaves four.
      const killedAt = Date.now();
      killRunningConversions();
      expect(await settled).toBeInstanceOf(FfmpegConversionError);
      await waitUntil(() => !alive(), 6_000);
      expect(alive()).toBe(false);
      expect(Date.now() - killedAt).toBeLessThan(6_000);
    } finally {
      if (alive()) process.kill(grandchild, 'SIGKILL');
    }
  }, 60_000);

  // Transcoding can inflate as well as shrink, so the output needs a ceiling of its own.
  it('refuses output above the cap, and says what it measured', async () => {
    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('big'), options({ maxOutputBytes: 1000 })),
    ).rejects.toThrow(/4096 bytes, above the 1000 byte limit/);
  });

  // The cap has to reach the process, or the output grows unbounded until ffmpeg exits.
  it('hands ffmpeg the size cap', async () => {
    const argv = (await runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('argv'), options())).toString();

    expect(argv).toContain('-fs 1025 ');
  });

  // Where ffmpeg stops at -fs it exits 0 with a cut-off file, which must never be returned as a result.
  it('refuses the cut-off file ffmpeg leaves when it stops at the cap', async () => {
    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('capped'), options({ maxOutputBytes: 1024 })),
    ).rejects.toThrow(/1025 bytes, above the 1024 byte limit/);
  });

  // An empty file is a silent failure: it would otherwise be returned as a valid zero-byte result.
  it('treats an empty result as a failure', async () => {
    await expect(runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('empty'), options())).rejects.toThrow(
      /produced no output/,
    );
  });

  it('says plainly when the binary cannot be executed at all', async () => {
    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', [], options({ ffmpegPath: join(workDir, 'not-here') })),
    ).rejects.toBeInstanceOf(FfmpegSpawnError);
    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', [], options({ ffmpegPath: join(workDir, 'not-here') })),
    ).rejects.toThrow(/Could not run ffmpeg/);
  });

  describe('probeFfmpeg', () => {
    it('is true for a runnable binary', async () => {
      await expect(probeFfmpeg(stubPath)).resolves.toBe(true);
    });

    it('is false when the binary is missing, rather than throwing', async () => {
      await expect(probeFfmpeg(join(workDir, 'not-here'))).resolves.toBe(false);
    });
  });
});
