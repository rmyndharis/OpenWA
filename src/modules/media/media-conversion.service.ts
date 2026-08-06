import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';
import { FfmpegConversionError, probeFfmpeg, runFfmpeg, videoEncodeArgs, voiceEncodeArgs } from './ffmpeg';
import type { ConvertMediaDto } from './dto/convert-media.dto';

/** What a conversion produced, in the same url-or-base64 vocabulary the send endpoints speak. */
export interface ConvertedMedia {
  /** The converted bytes, ready to hand straight to a send endpoint's `base64` field. */
  base64: string;
  /** The type the bytes now are — not the type they were. */
  mimetype: string;
  /** Decoded size, so a caller can check it against a send limit without decoding. */
  bytes: number;
}

@Injectable()
export class MediaConversionService {
  private readonly logger = createLogger('MediaConversionService');
  /** Result of the binary probe. Cached because it cannot change without a restart. */
  private binaryAvailable?: Promise<boolean>;
  /**
   * Bounds concurrent ffmpeg processes (the rate limiter caps admission per second, not how many
   * long-running processes stack up while each runs toward its timeout). Queue depth is a small
   * multiple of the cap: each parked task holds its input buffer in heap, so anything beyond it
   * answers 503 instead of accumulating.
   */
  private readonly ffmpegGate: ConcurrencyLimiter;

  constructor(private readonly configService: ConfigService) {
    const concurrency = this.configService.get<number>('mediaConversion.concurrency', 2);
    this.ffmpegGate = new ConcurrencyLimiter(concurrency, concurrency * 4);
  }

  /**
   * Convert to a WhatsApp voice note: Ogg/Opus, which is what produces a playable mic bubble.
   *
   * This exists because nothing else in the pipeline transcodes. A caller who posts MP3 bytes with
   * `ptt: true` gets them sent as-is, labelled `audio/ogg; codecs=opus` because that is the default
   * applied when no mimetype is given — the declared type and the actual bytes disagree, and the
   * recipient sees a voice note that will not play.
   */
  async convertToVoice(dto: ConvertMediaDto): Promise<ConvertedMedia> {
    return this.convert(dto, 'ogg', voiceEncodeArgs(), 'audio/ogg; codecs=opus');
  }

  /** Convert to an MP4 WhatsApp will accept and preview on every client. */
  async convertToVideo(dto: ConvertMediaDto): Promise<ConvertedMedia> {
    return this.convert(dto, 'mp4', videoEncodeArgs(), 'video/mp4');
  }

  /** Whether conversion is both switched on and actually runnable on this host. */
  async isAvailable(): Promise<boolean> {
    if (!this.configService.get<boolean>('mediaConversion.enabled', false)) return false;
    return this.probeOnce();
  }

  private async convert(
    dto: ConvertMediaDto,
    outputExtension: string,
    encodeArgs: string[],
    outputMimetype: string,
  ): Promise<ConvertedMedia> {
    await this.assertAvailable();
    const input = await this.resolveInput(dto);

    try {
      const output = await this.ffmpegGate.run(() =>
        runFfmpeg(input, 'bin', outputExtension, encodeArgs, {
          ffmpegPath: this.configService.get<string>('mediaConversion.ffmpegPath', 'ffmpeg'),
          timeoutMs: this.configService.get<number>('mediaConversion.timeoutMs', 60_000),
          maxOutputBytes: this.configService.get<number>('mediaConversion.maxOutputBytes', 50 * 1024 * 1024),
        }),
      );
      this.logger.log('Media converted', { inputBytes: input.length, outputBytes: output.length, outputMimetype });
      return { base64: output.toString('base64'), mimetype: outputMimetype, bytes: output.length };
    } catch (error) {
      if (error instanceof Error && error.message === 'ConcurrencyLimiter queue full') {
        throw new ServiceUnavailableException('Media conversion is busy — retry shortly');
      }
      if (error instanceof FfmpegConversionError) {
        // ffmpeg's stderr is about the caller's own bytes, so returning it is what makes a rejection
        // actionable. It never names a path the caller did not supply: the only paths in the command
        // are the temp files this process created.
        this.logger.warn('Media conversion failed', { reason: error.message, detail: error.detail });
        throw new BadRequestException(error.detail ? `${error.message}: ${error.detail}` : error.message);
      }
      throw error;
    }
  }

  /** Read the caller's media into memory, honouring the same caps and SSRF guard as a send. */
  private async resolveInput(dto: ConvertMediaDto): Promise<Buffer> {
    if (dto.base64) {
      // Checked before decoding, so an oversized payload is refused without allocating it.
      assertBase64WithinMediaCap(dto.base64);
      const data = Buffer.from(stripBase64DataUri(dto.base64) ?? '', 'base64');
      if (data.length === 0) throw new BadRequestException('base64 did not decode to any bytes');
      return data;
    }
    if (dto.url) {
      // Through the SSRF guard, exactly as a send does: it validates the host and pins the
      // connection to the vetted address. ffmpeg itself never sees a URL — it is restricted to the
      // file protocol and handed bytes this process already fetched and checked.
      try {
        const { data } = await loadRemoteMediaBuffer(dto.url);
        return data;
      } catch (error) {
        // The fetch layer throws plain Errors (bad status, over the byte cap) and SsrfBlockedError,
        // none of them HttpExceptions — unmapped they leave as a 500 for what is squarely a bad
        // input, while the send path answers 400 for the very same URL. An SSRF block is reported
        // generically: its raw message names the resolved internal address.
        if (error instanceof SsrfBlockedError) {
          throw new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE);
        }
        if (error instanceof HttpException) throw error;
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
    }
    throw new BadRequestException('Either url or base64 must be provided');
  }

  private async assertAvailable(): Promise<void> {
    if (!this.configService.get<boolean>('mediaConversion.enabled', false)) {
      throw new ServiceUnavailableException(
        'Media conversion is disabled. Set MEDIA_CONVERSION_ENABLED=true to enable it.',
      );
    }
    if (!(await this.probeOnce())) {
      throw new ServiceUnavailableException(
        'Media conversion is enabled but the ffmpeg binary could not be run. Install ffmpeg, or set FFMPEG_PATH.',
      );
    }
  }

  /**
   * Probe once per process. The promise itself is memoised rather than its result, so concurrent
   * first requests share one probe instead of each spawning their own.
   */
  private probeOnce(): Promise<boolean> {
    this.binaryAvailable ??= probeFfmpeg(this.configService.get<string>('mediaConversion.ffmpegPath', 'ffmpeg')).then(
      available => {
        if (!available) this.logger.warn('Media conversion is enabled but ffmpeg could not be run');
        return available;
      },
    );
    return this.binaryAvailable;
  }
}
