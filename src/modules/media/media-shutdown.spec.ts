import childProcess from 'node:child_process';
import files from 'node:fs/promises';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { MediaConversionService } from './media-conversion.service';
import * as ffmpeg from './ffmpeg';
import * as remoteMedia from '../../common/media/load-remote-media';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session } from '../session/entities/session.entity';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>(done => setImmediate(done));

describe('media conversion shutdown', () => {
  const input = Buffer.from('tiny');
  let service: MediaConversionService;
  let run: jest.SpyInstance;
  let probe: jest.SpyInstance;

  beforeEach(() => {
    probe = jest.spyOn(ffmpeg, 'probeFfmpeg').mockResolvedValue(true);
    run = jest.spyOn(ffmpeg, 'runFfmpeg').mockResolvedValue(input);
    jest.spyOn(ffmpeg, 'killRunningConversions').mockImplementation(() => undefined);
    const config = {
      get: (key: string, fallback: unknown) =>
        key === 'mediaConversion.enabled' ? true : key === 'mediaConversion.concurrency' ? 1 : fallback,
    };
    service = new MediaConversionService(config as ConfigService, new EngineRegistry(), {
      findOne: jest.fn().mockResolvedValue(null),
    } as unknown as Repository<Session>);
  });
  afterEach(() => jest.restoreAllMocks());

  for (const method of ['convertToVoice', 'convertToVideo'] as const) {
    it(`${method} rejects parked work without invoking another runner`, async () => {
      const active = deferred<Buffer>();
      run.mockImplementationOnce(() => active.promise);
      const first = service[method]('session', { base64: input.toString('base64') });
      const second = service[method]('session', { base64: input.toString('base64') });
      const rejected = second.catch(error => error as { status: number });
      await tick();
      expect(run).toHaveBeenCalledTimes(1);
      service.onApplicationShutdown();
      expect(await rejected).toMatchObject({ status: 503 });
      active.resolve(input);
      await first;
      expect(run).toHaveBeenCalledTimes(1);
      await expect(service[method]('session', { base64: input.toString('base64') })).rejects.toMatchObject({
        status: 503,
      });
    });

    it(`${method} refuses an input that finishes loading after shutdown`, async () => {
      const loaded = deferred<{ data: Buffer; mimetype: string }>();
      const load = jest.spyOn(remoteMedia, 'loadRemoteMediaBuffer').mockReturnValue(loaded.promise);
      const pending = service[method]('session', { url: 'https://media.invalid/tiny.wav' });
      const rejected = pending.catch(error => error as { status: number });
      await tick();
      expect(load).toHaveBeenCalledTimes(1);
      service.onApplicationShutdown();
      loaded.resolve({ data: input, mimetype: 'audio/wav' });
      expect(await rejected).toMatchObject({ status: 503 });
      expect(run).not.toHaveBeenCalled();
    });

    it(`${method} refuses a successful availability probe that settles after shutdown`, async () => {
      const ready = deferred<boolean>();
      probe.mockReturnValue(ready.promise);
      const pending = service[method]('session', { base64: input.toString('base64') });
      const rejected = pending.catch(error => error as { status: number });
      service.onApplicationShutdown();
      ready.resolve(true);
      expect(await rejected).toMatchObject({ status: 503 });
      expect(run).not.toHaveBeenCalled();
    });
  }

  it('reports unavailable when the probe succeeds after shutdown', async () => {
    const ready = deferred<boolean>();
    probe.mockReturnValue(ready.promise);
    const pending = service.isAvailable();
    service.onApplicationShutdown();
    ready.resolve(true);
    expect(await pending).toBe(false);
    expect(await service.isAvailable()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('conversion process cancellation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('checks cancellation after input preparation and before spawning', async () => {
    const cancellation = new AbortController();
    const write = files.writeFile;
    jest.spyOn(files, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      cancellation.abort();
    });
    const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('A cancelled conversion must not spawn');
    });
    await expect(
      ffmpeg.runFfmpeg(Buffer.from('tiny'), 'bin', 'raw', [], {
        signal: cancellation.signal,
        ffmpegPath: 'unused',
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
