import { BadRequestException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaConversionService } from './media-conversion.service';
import * as ffmpeg from './ffmpeg';
import * as loadRemoteMedia from '../../common/media/load-remote-media';

/**
 * The behaviours worth pinning here are the ones a caller can reach: that a host without ffmpeg says
 * so instead of failing at spawn time, that the caller's bytes are size-checked on the way in, and —
 * most of all — that a remote URL is fetched through the SSRF guard and never handed to ffmpeg,
 * which would resolve it itself.
 */
describe('MediaConversionService', () => {
  const config = (overrides: Record<string, unknown> = {}): ConfigService => {
    const values: Record<string, unknown> = {
      'mediaConversion.enabled': true,
      'mediaConversion.ffmpegPath': 'ffmpeg',
      'mediaConversion.timeoutMs': 60_000,
      'mediaConversion.maxOutputBytes': 50 * 1024 * 1024,
      ...overrides,
    };
    return { get: (key: string, fallback?: unknown) => values[key] ?? fallback } as unknown as ConfigService;
  };

  /** runFfmpeg(input, inputExtension, outputExtension, ...) — the third argument fixes the format. */
  const outputExtensionOf = (spy: jest.SpyInstance): unknown => (spy.mock.calls[0] as unknown[])[2];

  let runFfmpeg: jest.SpyInstance;
  let probeFfmpeg: jest.SpyInstance;

  beforeEach(() => {
    runFfmpeg = jest.spyOn(ffmpeg, 'runFfmpeg').mockResolvedValue(Buffer.from('converted-bytes'));
    probeFfmpeg = jest.spyOn(ffmpeg, 'probeFfmpeg').mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('availability', () => {
    it('refuses with 503 when conversion is switched off, without probing for the binary', async () => {
      const service = new MediaConversionService(config({ 'mediaConversion.enabled': false }));

      await expect(service.convertToVoice({ base64: 'AAAA' })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(probeFfmpeg).not.toHaveBeenCalled();
      expect(runFfmpeg).not.toHaveBeenCalled();
    });

    // Enabling the flag on a host with no ffmpeg must be a clear answer, not a spawn error.
    it('refuses with 503 when the binary cannot be run', async () => {
      probeFfmpeg.mockResolvedValue(false);
      const service = new MediaConversionService(config());

      await expect(service.convertToVoice({ base64: 'AAAA' })).rejects.toThrow(/ffmpeg binary could not be run/);
      expect(runFfmpeg).not.toHaveBeenCalled();
    });

    it('reports availability without converting anything', async () => {
      await expect(new MediaConversionService(config()).isAvailable()).resolves.toBe(true);
      await expect(
        new MediaConversionService(config({ 'mediaConversion.enabled': false })).isAvailable(),
      ).resolves.toBe(false);
    });

    // Concurrent first requests must not each spawn their own probe.
    it('probes the binary once per process, even under concurrent first calls', async () => {
      const service = new MediaConversionService(config());

      await Promise.all([service.isAvailable(), service.isAvailable(), service.convertToVoice({ base64: 'AAAA' })]);

      expect(probeFfmpeg).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolving the caller’s media', () => {
    // The point of the whole endpoint shape: ffmpeg is handed BYTES, never a URL. Given a URL it
    // would fetch the address itself, outside the guard that vets and pins the destination.
    it('fetches a URL through the SSRF guard and gives ffmpeg the bytes, not the URL', async () => {
      const load = jest
        .spyOn(loadRemoteMedia, 'loadRemoteMediaBuffer')
        .mockResolvedValue({ data: Buffer.from('remote-audio'), mimetype: 'audio/mpeg' });
      const service = new MediaConversionService(config());

      await service.convertToVoice({ url: 'https://example.com/note.m4a' });

      expect(load).toHaveBeenCalledWith('https://example.com/note.m4a');
      const [input] = runFfmpeg.mock.calls[0] as [Buffer];
      expect(input).toEqual(Buffer.from('remote-audio'));
      // Nothing resembling the URL may appear anywhere in the ffmpeg call.
      expect(JSON.stringify(runFfmpeg.mock.calls[0])).not.toContain('example.com');
    });

    it('decodes base64, stripping a data: prefix', async () => {
      const service = new MediaConversionService(config());

      await service.convertToVoice({ base64: `data:audio/mpeg;base64,${Buffer.from('inline').toString('base64')}` });

      expect((runFfmpeg.mock.calls[0] as [Buffer])[0]).toEqual(Buffer.from('inline'));
    });

    it('rejects base64 above the media cap with 413, before any conversion', async () => {
      const service = new MediaConversionService(config());
      const oversized = Buffer.alloc(51 * 1024 * 1024).toString('base64');

      await expect(service.convertToVoice({ base64: oversized })).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(runFfmpeg).not.toHaveBeenCalled();
    });

    it('rejects a request carrying neither url nor base64', async () => {
      await expect(new MediaConversionService(config()).convertToVoice({})).rejects.toThrow(
        /Either url or base64 must be provided/,
      );
    });

    it('rejects base64 that decodes to nothing', async () => {
      await expect(new MediaConversionService(config()).convertToVoice({ base64: '!!!' })).rejects.toThrow(
        /did not decode/,
      );
    });
  });

  describe('conversion', () => {
    it('returns Ogg/Opus for voice, which is what makes a playable mic bubble', async () => {
      const service = new MediaConversionService(config());

      const result = await service.convertToVoice({ base64: 'AAAA' });

      expect(result).toEqual({
        base64: Buffer.from('converted-bytes').toString('base64'),
        mimetype: 'audio/ogg; codecs=opus',
        bytes: 15,
      });
      expect(outputExtensionOf(runFfmpeg)).toBe('ogg');
    });

    it('returns MP4 for video', async () => {
      const service = new MediaConversionService(config());

      const result = await service.convertToVideo({ base64: 'AAAA' });

      expect(result.mimetype).toBe('video/mp4');
      expect(outputExtensionOf(runFfmpeg)).toBe('mp4');
    });

    // ffmpeg's complaint is about the caller's own bytes, so surfacing it is what makes a 400 useful.
    it('turns an ffmpeg refusal into a 400 carrying its reason', async () => {
      runFfmpeg.mockRejectedValue(new ffmpeg.FfmpegConversionError('ffmpeg exited with code 1', 'Invalid data found'));
      const service = new MediaConversionService(config());

      await expect(service.convertToVoice({ base64: 'AAAA' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.convertToVoice({ base64: 'AAAA' })).rejects.toThrow(/Invalid data found/);
    });

    // A programming error must not be relabelled as the caller's fault.
    it('lets an unexpected error through rather than reporting it as a bad request', async () => {
      runFfmpeg.mockRejectedValue(new TypeError('boom'));
      const service = new MediaConversionService(config());

      await expect(service.convertToVoice({ base64: 'AAAA' })).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe('concurrency gate', () => {
    // The rate limiter caps admission per second, not how many long-running ffmpeg processes stack
    // up while each runs toward its timeout — that bound lives here.
    it('bounds concurrent ffmpeg runs and answers 503 past the queue instead of stacking processes', async () => {
      // concurrency 1 → queue depth 4: five simultaneous requests fill the gate, the sixth is refused.
      const service = new MediaConversionService(config({ 'mediaConversion.concurrency': 1 }));
      let release!: () => void;
      runFfmpeg.mockImplementation(
        () =>
          new Promise<Buffer>(resolve => {
            release = () => resolve(Buffer.from('x'));
          }),
      );

      const inflight = Array.from({ length: 5 }, () => service.convertToVoice({ base64: 'AAAA' }));
      await new Promise(resolve => setImmediate(resolve));
      expect(runFfmpeg).toHaveBeenCalledTimes(1);

      await expect(service.convertToVoice({ base64: 'AAAA' })).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Drain: release each run in turn so every parked task completes and nothing leaks.
      for (let i = 0; i < 5; i++) {
        release();
        await new Promise(resolve => setImmediate(resolve));
      }
      await Promise.all(inflight);
      expect(runFfmpeg).toHaveBeenCalledTimes(5);
    });
  });
});
