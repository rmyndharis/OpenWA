import { readFileSync } from 'fs';
import { join } from 'path';
import { describeAudio, describeVideo, WAVEFORM_BARS } from './baileys-audio-probe';
import { runFfmpeg } from '../../modules/media/ffmpeg';

// ffmpeg is the one dependency of the waveform; the duration read runs the real child process.
jest.mock('../../modules/media/ffmpeg', () => ({ runFfmpeg: jest.fn() }));
const ffmpeg = runFfmpeg as jest.Mock;

const u32be = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};

/** FORM/AIFF whose ID3 chunk declares 0xffffff00 bytes: music-metadata's file read aborts its process on it. */
function oversizedAiff(): Buffer {
  const body = Buffer.concat([
    Buffer.from('AIFF'),
    Buffer.from('ID3 '),
    u32be(0xffffff00),
    Buffer.from('ID3\x04', 'latin1'),
  ]);
  return Buffer.concat([Buffer.from('FORM'), u32be(body.length), body]);
}

/** Unsigned 8-bit mono PCM at 8 kHz, a square wave: music-metadata reads its duration from the header. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Buffer.alloc(rate * seconds);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.floor(i / 20) % 2 === 0 ? 200 : 56;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); // bytes per second
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/** What ffmpeg writes with `-ac 1 -ar 8000 -f s16le`: `count` samples, each `level(index)` high. */
function pcm(count: number, level: (index: number) => number): Buffer {
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) out.writeInt16LE(level(i), i * 2);
  return out;
}

describe('describeAudio', () => {
  // The duration read is a Node process that loads a parser.
  jest.setTimeout(60_000);

  beforeEach(() => ffmpeg.mockReset());

  it('reads the duration of an audio file and decodes nothing for a plain audio file', async () => {
    const described = await describeAudio(wav(3), false);

    expect(described).toEqual({ seconds: 3 });
    expect(ffmpeg).not.toHaveBeenCalled();
  });

  it('builds a voice note waveform of 64 bars, the loudest scaled to 100, from ffmpeg samples', async () => {
    // Quiet first half, loud second half: the bars must follow the signal, not be flat.
    const samples = 8000 * 3;
    ffmpeg.mockResolvedValue(pcm(samples, i => (i < samples / 2 ? 1000 : 8000)));

    const described = await describeAudio(wav(3), true);

    expect(described.seconds).toBe(3);
    const bars = described.waveform as Uint8Array;
    expect(bars).toHaveLength(WAVEFORM_BARS);
    expect(Math.max(...bars)).toBe(100);
    expect(bars[0]).toBe(12); // 1000 / 8000
    expect(bars[WAVEFORM_BARS - 1]).toBe(100);
    // Decoded as 8 kHz mono signed 16-bit and stopped at a fixed size, whatever the file claims to hold.
    expect(ffmpeg).toHaveBeenCalledWith(
      expect.any(Buffer),
      'bin',
      'raw',
      expect.arrayContaining(['-ac', '1', '-ar', '8000', '-f', 's16le']),
      expect.objectContaining({ maxOutputBytes: 32 * 1024 * 1024 }),
    );
  });

  it.each([
    ['ffmpeg cannot run or refuses the file', () => ffmpeg.mockRejectedValue(new Error('no ffmpeg'))],
    ['the decoded audio is silent', () => ffmpeg.mockResolvedValue(pcm(8000, () => 0))],
    ['the decoded audio is shorter than one sample per bar', () => ffmpeg.mockResolvedValue(pcm(10, () => 500))],
  ])('sends flat bars when %s', async (_name, arrange) => {
    arrange();

    const described = await describeAudio(wav(3), true);

    expect(described.seconds).toBe(3);
    expect(described.waveform).toEqual(new Uint8Array(WAVEFORM_BARS).fill(40));
  });

  it('takes the duration from the decoded samples when the parser could not read it', async () => {
    ffmpeg.mockResolvedValue(pcm(8000 * 5, i => (i % 2 === 0 ? 3000 : -3000)));

    const described = await describeAudio(Buffer.from('not audio at all'), true);

    expect(described.seconds).toBe(5);
  });

  it('does not trust a duration from samples that ffmpeg was cut off at', async () => {
    ffmpeg.mockResolvedValue(pcm((32 * 1024 * 1024) / 2, i => (i % 2 === 0 ? 3000 : -3000)));

    const described = await describeAudio(Buffer.from('not audio at all'), true);

    expect(described.seconds).toBe(0);
  });

  it('answers a zero duration and flat bars for bytes nothing reads, rather than rejecting', async () => {
    ffmpeg.mockRejectedValue(new Error('Invalid data found when processing input'));

    await expect(describeAudio(Buffer.from('not audio at all'), true)).resolves.toEqual({
      seconds: 0,
      waveform: new Uint8Array(WAVEFORM_BARS).fill(40),
    });
  });

  it('survives a file that aborts the process of a reader that opens it', async () => {
    // Opened as a file, music-metadata dies on this one with SIGABRT in node::fs::Read. Whatever the
    // child does with it, the caller must get an answer and keep running.
    ffmpeg.mockRejectedValue(new Error('refused'));

    await expect(describeAudio(oversizedAiff(), false)).resolves.toEqual({ seconds: 0 });
    await expect(describeAudio(oversizedAiff(), true)).resolves.toMatchObject({ seconds: 0 });
  });
});

describe('describeVideo', () => {
  beforeEach(() => ffmpeg.mockReset());

  it('makes the 32-pixel first-frame JPEG Baileys would, through the bounded ffmpeg run', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    ffmpeg.mockResolvedValue(jpeg);

    await expect(describeVideo(Buffer.from('video'))).resolves.toEqual({ jpegThumbnail: jpeg.toString('base64') });
    expect(ffmpeg).toHaveBeenCalledWith(
      Buffer.from('video'),
      'bin',
      'jpg',
      ['-frames:v', '1', '-vf', 'scale=32:-1', '-f', 'image2'],
      expect.objectContaining({ timeoutMs: 10_000, maxOutputBytes: 64 * 1024 }),
    );
  });

  it('answers a null thumbnail, never an undefined one, when none could be made', async () => {
    ffmpeg.mockRejectedValue(new Error('Format not on whitelist'));

    const described = await describeVideo(Buffer.from('v=0\nc=IN IP4 169.254.169.254\n'));

    expect(described).toHaveProperty('jpegThumbnail', null);
  });
});

/**
 * describeVideo answers null when it has no thumbnail, and that keeps Baileys from making one itself only
 * while the library tests the key for undefined. A falsy or `== null` test would run its unbounded ffmpeg
 * on every video that has no thumbnail, so an upgrade that changes the test fails here first.
 */
describe('Baileys makes a video thumbnail itself only when jpegThumbnail is undefined', () => {
  it('tests the key with typeof undefined', () => {
    const file = join(__dirname, '../../../node_modules/@whiskeysockets/baileys/lib/Utils/messages.js');
    const tests = readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.includes('requiresThumbnailComputation ='));

    expect(tests).toHaveLength(1);
    expect(tests[0]).toContain("typeof uploadData['jpegThumbnail'] === 'undefined'");
  });
});
