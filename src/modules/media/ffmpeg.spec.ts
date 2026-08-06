import { buildFfmpegArgs, voiceEncodeArgs, videoEncodeArgs } from './ffmpeg';

/**
 * These pin the two things about the argument lists that are load-bearing and easy to break while
 * "tidying": the quoting inside the scale filter, and the codec choices WhatsApp actually requires.
 *
 * The scale quoting is not cosmetic. ffmpeg splits a filter description on commas, so the comma
 * inside `min(1280,iw)` terminates the filter unless the expression is quoted — the unquoted form
 * fails with `Invalid size 'min(1280'`. Because these arguments are passed through spawn rather than
 * a shell, the quotes have to be part of the string itself; a reviewer removing them as redundant
 * shell syntax would break every video conversion, and nothing else here would notice.
 */
describe('ffmpeg encoder arguments', () => {
  /** Read `-flag value` out of an argv array, so assertions do not depend on argument order. */
  const valueOf = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };

  describe('voice', () => {
    const args = voiceEncodeArgs();

    // Ogg/Opus is what makes a WhatsApp client render a playable mic bubble rather than a file.
    it('encodes Opus', () => {
      expect(valueOf(args, '-c:a')).toBe('libopus');
    });

    it('drops any video stream, so converting a video yields audio only', () => {
      expect(args).toContain('-vn');
    });

    // Mono at 48 kHz with the voip tuning is what the app's own recorder produces.
    it('produces mono 48 kHz tuned for speech', () => {
      expect(valueOf(args, '-ac')).toBe('1');
      expect(valueOf(args, '-ar')).toBe('48000');
      expect(valueOf(args, '-application')).toBe('voip');
    });
  });

  describe('video', () => {
    const args = videoEncodeArgs();

    // Baseline + yuv420p is the pairing that plays on every WhatsApp client, including older Android.
    it('encodes baseline H.264 with a widely playable pixel format', () => {
      expect(valueOf(args, '-c:v')).toBe('libx264');
      expect(valueOf(args, '-profile:v')).toBe('baseline');
      expect(valueOf(args, '-pix_fmt')).toBe('yuv420p');
    });

    it('moves the index to the front so playback can start before the file finishes arriving', () => {
      expect(valueOf(args, '-movflags')).toBe('+faststart');
    });

    // The regression this exists for: unquoted, ffmpeg reads the filter as `scale=min(1280`.
    it('quotes the scale expression so its comma stays inside min()', () => {
      expect(valueOf(args, '-vf')).toBe("scale='min(1280,iw)':-2");
    });

    // -2 keeps the computed edge even, which H.264 requires; -1 would produce odd heights and fail.
    it('keeps the derived edge even', () => {
      expect(valueOf(args, '-vf')).toMatch(/:-2$/);
    });
  });
});

/**
 * ffmpeg resolves its input as a URL, and left unrestricted it will make the request: pointed at an
 * `http://` address it reaches the network, which on a cloud host includes the link-local metadata
 * endpoint. The input here is always a file this process just wrote, so confining ffmpeg to the file
 * protocol costs nothing and removes the class entirely. Losing that flag would be invisible —
 * every conversion would still succeed — which is exactly why it is pinned here.
 */
describe('ffmpeg invocation shape', () => {
  const args = buildFfmpegArgs('/tmp/openwa-convert-x/in.bin', '/tmp/openwa-convert-x/out.ogg', ['-c:a', 'libopus']);

  it('confines ffmpeg to the file protocol', () => {
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
  });

  it('never waits on stdin, and never prompts about an existing output', () => {
    expect(args).toContain('-nostdin');
    expect(args).toContain('-y');
  });

  it('names the input immediately after -i, and the output last', () => {
    expect(args[args.indexOf('-i') + 1]).toBe('/tmp/openwa-convert-x/in.bin');
    expect(args[args.length - 1]).toBe('/tmp/openwa-convert-x/out.ogg');
  });

  // Encoder flags have to land between the input and the output; ffmpeg applies options positionally,
  // so an encoder flag placed before -i would be read as an INPUT option and silently do nothing.
  it('places encoder arguments between the input and the output', () => {
    expect(args.indexOf('-c:a')).toBeGreaterThan(args.indexOf('-i'));
    expect(args.indexOf('-c:a')).toBeLessThan(args.length - 1);
  });
});
