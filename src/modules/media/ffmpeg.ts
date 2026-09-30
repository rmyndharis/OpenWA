import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A conversion that ffmpeg refused, timed out on, or produced too much output for. */
export class FfmpegConversionError extends Error {
  constructor(
    message: string,
    /** ffmpeg's own last words, already trimmed. Empty when it never got that far. */
    readonly detail: string = '',
  ) {
    super(message);
    this.name = 'FfmpegConversionError';
  }
}

export interface FfmpegRunOptions {
  /** Binary to execute. Resolved through PATH unless absolute. */
  ffmpegPath: string;
  /** Wall-clock ceiling; the process is killed past it. */
  timeoutMs: number;
  /** Ceiling on the produced bytes. */
  maxOutputBytes: number;
}

/**
 * Input demuxers conversion accepts, by ffmpeg name. A name matches any demuxer that registers it,
 * so `mov` covers mp4, m4a and 3gp, `matroska` covers webm, and `mpeg` is MPEG-PS (.mpg, .vob).
 * Every one of them reads its input and nothing else.
 */
export const INPUT_FORMATS = [
  'mov',
  'matroska',
  'ogg',
  'mp3',
  'wav',
  'w64',
  'aac',
  'ac3',
  'eac3',
  'flac',
  'wv',
  'au',
  'amr',
  'avi',
  'mpeg',
  'mpegts',
  'asf',
  'flv',
  'caf',
  'aiff',
  'gif',
  'h264',
  'hevc',
].join(',');

/**
 * The arguments every conversion starts with, before any codec choice.
 *
 * `-protocol_whitelist file` is the load-bearing one for the network. ffmpeg treats its input as a URL,
 * and given an `http://` one it will happily make the request (verified against this project's own
 * image, where it reached for the link-local metadata address). The input here is always a file this
 * process just wrote, so restricting ffmpeg to the file protocol costs nothing, and neither the input
 * path nor anything a crafted container might reference can become a network request.
 *
 * The file protocol still reaches every local file, though, and some demuxers (playlists, manifests,
 * concatenation scripts) open the files their input names. `-format_whitelist` restricts the input
 * demuxers to the single-file media containers conversion supports, so the input is decoded as
 * itself and never as a pointer to something else on disk.
 *
 * `-nostdin` stops a prompt (an existing output file, a missing codec) from blocking forever on a
 * stdin nobody is attached to, and `-y` means there is nothing to prompt about in the first place.
 */
const BASE_ARGS = [
  '-hide_banner',
  '-nostdin',
  '-loglevel',
  'error',
  '-y',
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  INPUT_FORMATS,
] as const;

/**
 * The full argument list for one conversion. Split out from the spawn so the security-relevant
 * shape — restricted protocols, no stdin, and the fact that the only paths present are ones this
 * process chose — can be asserted without running a process.
 */
export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  encodeArgs: string[],
  maxOutputBytes: number,
): string[] {
  // `-fs` makes ffmpeg stop writing once the output reaches the limit, so a conversion cannot fill
  // the temp directory (a RAM-backed tmpfs in the compose files) before the size check after exit.
  // It is an output option, so it sits right before the output path. The limit is one byte above
  // the cap: a cut-off file is then always over the cap and rejected, and a complete one at the cap
  // still passes.
  return [...BASE_ARGS, '-i', inputPath, ...encodeArgs, '-fs', String(maxOutputBytes + 1), outputPath];
}

/**
 * Encoder arguments for a WhatsApp voice note.
 *
 * Ogg/Opus is what a WhatsApp client expects for a PTT bubble; anything else arrives as a file that
 * will not play in the mic UI. Mono at 48 kHz with the `voip` tuning is what the app's own recorder
 * produces, and 32 kbit/s is transparent for speech while keeping a long note small.
 */
export function voiceEncodeArgs(): string[] {
  return ['-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-application', 'voip'];
}

/**
 * Encoder arguments for a video WhatsApp will accept and preview.
 *
 * Baseline H.264 with yuv420p is the combination that plays on every WhatsApp client, including the
 * older Android ones that reject High profile. `faststart` relocates the index to the front so the
 * receiver can begin playback before the whole file arrives. The scale filter bounds the long edge
 * at 1280 while `-2` keeps the other edge even, which H.264 requires — and `min()` means a smaller
 * video is never upscaled into a larger file than it started as.
 */
export function videoEncodeArgs(): string[] {
  return [
    '-c:v',
    'libx264',
    '-profile:v',
    'baseline',
    '-level',
    '3.1',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    "scale='min(1280,iw)':-2",
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
  ];
}

/**
 * Convert `input` by running ffmpeg once, and return the produced bytes.
 *
 * The input is written to a freshly created private directory rather than being streamed in, because
 * the muxers used here seek: Ogg rewrites its page headers and `+faststart` moves the MP4 index to
 * the front, and neither can do that on a pipe. Writing both sides to a temp directory that is
 * removed in `finally` keeps that from turning into litter on the volume.
 *
 * The caller's bytes never reach the argument list — only paths this function chose — so nothing a
 * caller sends can be read as an ffmpeg option.
 */
export async function runFfmpeg(
  input: Buffer,
  inputExtension: string,
  outputExtension: string,
  encodeArgs: string[],
  options: FfmpegRunOptions,
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'openwa-convert-'));
  const inputPath = join(dir, `in.${inputExtension}`);
  const outputPath = join(dir, `out.${outputExtension}`);
  try {
    await writeFile(inputPath, input);
    await execute(buildFfmpegArgs(inputPath, outputPath, encodeArgs, options.maxOutputBytes), options);

    // Check the size on disk before reading, so an unexpectedly large result is refused instead of
    // being pulled into memory first. `-fs` stops ffmpeg at one byte over the cap and ffmpeg then
    // exits 0, so this check is also what rejects that cut-off file.
    const { size } = await stat(outputPath);
    if (size > options.maxOutputBytes) {
      throw new FfmpegConversionError(
        `Converted media is ${size} bytes, above the ${options.maxOutputBytes} byte limit`,
      );
    }
    if (size === 0) {
      throw new FfmpegConversionError('Conversion produced no output');
    }
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Spawn ffmpeg and resolve when it exits 0, else reject with whatever it wrote to stderr. */
function execute(args: string[], options: FfmpegRunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    // An argument array, never a shell string: nothing here can be word-split or expanded, so a
    // filename with a space or a quote is data rather than syntax.
    const child = spawn(options.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    let timedOut = false;
    // Bounded: a failing codec can produce error output indefinitely, and only the tail is useful.
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: the case being defended against is a codec stuck in a loop,
      // which is exactly the case that would ignore a polite signal.
      child.kill('SIGKILL');
      // Let go of our end of the stderr pipe too. A descendant of the killed process (ffmpeg under a
      // wrapper script) can still hold the inherited stderr, and the open pipe would keep this
      // process alive until that descendant exits.
      child.stderr.destroy();
      // Reject as soon as the signal is sent rather than waiting for `close`. `close` fires when the
      // stdio pipes close, not when the process dies, so anything still holding the inherited stderr
      // keeps it pending — which would leave the timeout bounding nothing at all.
      reject(new FfmpegConversionError(`Conversion timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      // Spawn itself failed — almost always a missing binary, which is worth saying plainly.
      reject(new FfmpegConversionError(`Could not run ffmpeg: ${err instanceof Error ? err.message : String(err)}`));
    });

    child.on('close', code => {
      clearTimeout(timer);
      // Already rejected by the timer; a late close has nothing left to report.
      if (timedOut) return;
      if (code !== 0) {
        reject(new FfmpegConversionError(`ffmpeg exited with code ${code}`, stderr.trim()));
        return;
      }
      resolve();
    });
  });
}

/**
 * Whether the configured binary can actually be run.
 *
 * Probed by executing it rather than by looking for the file, since a path on PATH, a wrong
 * architecture and a non-executable file all differ only at exec time.
 */
export async function probeFfmpeg(ffmpegPath: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    await execute(['-version'], { ffmpegPath, timeoutMs, maxOutputBytes: 0 });
    return true;
  } catch {
    return false;
  }
}
