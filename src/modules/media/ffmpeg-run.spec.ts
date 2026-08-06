import { chmod, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegConversionError, probeFfmpeg, runFfmpeg } from './ffmpeg';

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
  out="$a"
done
case "$mode" in
  fail)  echo "Invalid data found when processing input" >&2; exit 1 ;;
  hang)  sleep 30 ;;
  empty) : > "$out" ;;
  big)   head -c 4096 /dev/zero > "$out" ;;
  *)     printf 'converted-output' > "$out" ;;
esac
`,
    );
    await chmod(stubPath, 0o755);
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

  // A codec stuck in a loop is the case this defends against, so the kill has to be unconditional.
  it('kills a process that overruns its timeout, rather than waiting on it', async () => {
    const startedAt = Date.now();

    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('hang'), options({ timeoutMs: 200 })),
    ).rejects.toThrow(/timed out after 200ms/);

    // Comfortably below the stub's 30s sleep: proves it was killed, not awaited.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  // Transcoding can inflate as well as shrink, so the output needs a ceiling of its own.
  it('refuses output above the cap, and says what it measured', async () => {
    await expect(
      runFfmpeg(Buffer.from('input'), 'bin', 'ogg', mode('big'), options({ maxOutputBytes: 1000 })),
    ).rejects.toThrow(/4096 bytes, above the 1000 byte limit/);
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
    ).rejects.toBeInstanceOf(FfmpegConversionError);
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
