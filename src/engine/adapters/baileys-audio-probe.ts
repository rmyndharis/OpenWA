import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { runFfmpeg } from '../../modules/media/ffmpeg';

/** What an outgoing audio message must carry so that Baileys reads nothing from the file itself. */
export interface AudioDescription {
  /** Playing time in whole seconds; 0 when it could not be read. */
  seconds: number;
  /** The amplitude bars WhatsApp draws on a voice note, 0 to 100 each; only on a voice note. */
  waveform?: Uint8Array;
}

/** Bars on a voice note, the count Baileys' own waveform uses. */
export const WAVEFORM_BARS = 64;
/** Height of every bar of a voice note whose waveform could not be read: visible, and not a loud one. */
const FLAT_BAR = 40;

/** Wall-clock ceiling for the duration read; the child is killed past it. */
const DURATION_TIMEOUT_MS = 30_000;
/** What the child may print: one small JSON line. */
const MAX_OUTPUT_CHARS = 1024;
/**
 * The waveform is read from 8 kHz mono 16-bit samples, 16 KB for each second of audio, and ffmpeg is
 * stopped at this many bytes, about 35 minutes. That is the most memory the bars are ever computed
 * from, whatever the file claims to hold. A longer note goes out with flat bars.
 */
const WAVEFORM_MAX_PCM_BYTES = 32 * 1024 * 1024;
const WAVEFORM_TIMEOUT_MS = 30_000;
const PCM_RATE = 8000;
/** One frame decodes in well under a second; past this the video goes out without a preview. */
const THUMBNAIL_TIMEOUT_MS = 10_000;
/** A 32-pixel-wide JPEG is a few hundred bytes. */
const THUMBNAIL_MAX_BYTES = 64 * 1024;
/** Reads running at once. Each is a whole child process. */
const reads = new ConcurrencyLimiter(2);
/** Thumbnails running at once, apart from the reads: a voice note read that hangs must not hold a video send. */
const thumbnails = new ConcurrencyLimiter(2);
/** The directory holding node_modules, whether this file runs from src/ or from dist/. */
const APP_ROOT = join(__dirname, '..', '..', '..');

/**
 * Run in a child, with the file on stdin: the duration the way Baileys reads it, with music-metadata.
 * A parser that aborts the process on a crafted file costs the child, not the gateway.
 */
const DURATION_SCRIPT = `
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
  try {
    const mm = await import('music-metadata');
    const metadata = await mm.parseBuffer(Buffer.concat(chunks), undefined, { duration: true });
    const duration = metadata.format.duration;
    if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      process.stdout.write(JSON.stringify({ seconds: Math.floor(duration) }) + '\\n');
    }
  } catch {}
});
`;

function readDuration(data: Buffer): Promise<number | undefined> {
  return new Promise(resolve => {
    let settled = false;
    let output = '';
    const child = spawn(process.execPath, ['-e', DURATION_SCRIPT], {
      cwd: APP_ROOT,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const finish = (seconds: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(seconds);
    };
    const parse = (): number | undefined => {
      try {
        const { seconds } = JSON.parse(output.trim()) as { seconds?: unknown };
        return typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 ? seconds : undefined;
      } catch {
        return undefined;
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(undefined);
    }, DURATION_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        child.kill('SIGKILL');
        finish(undefined);
      }
    });
    child.on('error', () => finish(undefined));
    child.on('close', () => finish(parse()));
    // The child may end before it has read everything it was sent.
    child.stdin.on('error', () => undefined);
    child.stdin.end(data);
  });
}

/** Bars of a mono 16-bit little-endian sample stream, scaled so the loudest is 100, and the sample count. */
function barsOf(pcm: Buffer): { waveform?: Uint8Array; samples: number } {
  const samples = Math.floor(pcm.length / 2);
  const view = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + samples * 2));
  const block = Math.floor(samples / WAVEFORM_BARS);
  if (block === 0) return { samples };
  const averages: number[] = [];
  for (let bar = 0; bar < WAVEFORM_BARS; bar++) {
    let sum = 0;
    for (let at = block * bar, end = at + block; at < end; at++) sum += Math.abs(view[at]);
    averages.push(sum / block);
  }
  const peak = Math.max(...averages);
  if (!(peak > 0)) return { samples };
  return { waveform: Uint8Array.from(averages, average => Math.floor((100 * average) / peak)), samples };
}

/**
 * Decode through ffmpeg, which streams and is stopped at a fixed output size, instead of through a
 * decoder that holds every sample in memory: a few hundred kilobytes of Opus packets decode into
 * gigabytes there, and a container that kills its whole cgroup on out-of-memory takes every session
 * with it. Without an ffmpeg binary there are no bars, and the note goes out with flat ones.
 */
async function readWaveform(data: Buffer): Promise<{ waveform?: Uint8Array; samples?: number }> {
  try {
    const pcm = await runFfmpeg(
      data,
      'bin',
      'raw',
      ['-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le'],
      {
        ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
        timeoutMs: WAVEFORM_TIMEOUT_MS,
        maxOutputBytes: WAVEFORM_MAX_PCM_BYTES,
      },
    );
    return barsOf(pcm);
  } catch {
    return {};
  }
}

/**
 * The duration of an outgoing audio file and, for a voice note, its waveform, read outside this process.
 *
 * Baileys makes both reads in the gateway's own process when the message does not carry them, with a
 * parser and a decoder run over bytes a caller chose: a 30-byte AIFF file aborts the process in
 * music-metadata's file read, and a small Opus file decodes into gigabytes of samples. Neither is an
 * error a request can catch. Every outgoing audio content is built from this answer instead, so
 * Baileys is never left to read the file: what could not be read goes out as a zero duration and flat
 * bars. Never rejects.
 */
export async function describeAudio(data: Buffer, ptt: boolean): Promise<AudioDescription> {
  const found = await reads
    .run(async () => {
      const [seconds, wave] = await Promise.all([
        readDuration(data),
        ptt ? readWaveform(data) : Promise.resolve<{ waveform?: Uint8Array; samples?: number }>({}),
      ]);
      // The decoded samples give the duration when the parser could not, as long as they were not cut off.
      const decoded =
        seconds === undefined && wave.samples !== undefined && wave.samples * 2 < WAVEFORM_MAX_PCM_BYTES
          ? Math.floor(wave.samples / PCM_RATE)
          : undefined;
      return { seconds: seconds ?? decoded, waveform: wave.waveform };
    })
    .catch(() => ({ seconds: undefined as number | undefined, waveform: undefined as Uint8Array | undefined }));
  return {
    seconds: found.seconds ?? 0,
    ...(ptt ? { waveform: found.waveform ?? new Uint8Array(WAVEFORM_BARS).fill(FLAT_BAR) } : {}),
  };
}

/**
 * The inline preview of an outgoing video: base64 of a 32-pixel-wide JPEG of its first frame, the image
 * Baileys would make. Baileys makes it, whenever the content has none, by running ffmpeg through a shell on
 * the caller's file with no protocol or format whitelist, no deadline and no bound on how many run at once:
 * a stream description or a manifest sent as a video reaches the network from there. Made here through
 * runFfmpeg instead, under a limiter of its own. Never rejects.
 */
export async function describeVideo(data: Buffer): Promise<{ jpegThumbnail: string }> {
  const jpeg = await thumbnails
    .run(() =>
      runFfmpeg(data, 'bin', 'jpg', ['-frames:v', '1', '-vf', 'scale=32:-1', '-f', 'image2'], {
        ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
        timeoutMs: THUMBNAIL_TIMEOUT_MS,
        maxOutputBytes: THUMBNAIL_MAX_BYTES,
      }),
    )
    .catch(() => undefined);
  // null, never undefined, when none could be made: Baileys makes its own for an undefined key, and leaves a
  // null one off the message, as when its own read fails. Its type says string, hence the cast.
  return { jpegThumbnail: (jpeg?.toString('base64') ?? null) as string };
}
