import {
  BadRequestException,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session } from '../session/entities/session.entity';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { assertBase64WithinMediaCap, stripBase64DataUri } from '../message/media-cap.util';
import {
  FfmpegConversionError,
  FfmpegSpawnError,
  killRunningConversions,
  probeFfmpeg,
  removeStaleConversionDirs,
  runFfmpeg,
  videoEncodeArgs,
  voiceEncodeArgs,
} from './ffmpeg';
import type { ConvertMediaDto } from './dto/convert-media.dto';

/** Youngest leftover conversion directory the start-up sweep removes. */
const STALE_CONVERSION_DIR_MIN_AGE_MS = 60 * 60 * 1000;

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
export class MediaConversionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = createLogger('MediaConversionService');
  /**
   * Result of the binary probe. Only a successful probe is kept: a failure can be a timeout or a
   * transient spawn error on a loaded host, so the next request probes again.
   */
  private binaryAvailable?: Promise<boolean>;
  /**
   * Bounds concurrent conversions, input load included (the rate limiter caps admission per second,
   * not how many long-running processes stack up while each runs toward its timeout). Queue depth is
   * a small multiple of the cap, so anything beyond it answers 503 instead of accumulating; a parked
   * request holds only its own body, and at most the cap's worth of inputs sit in heap at once.
   */
  private readonly ffmpegGate: ConcurrencyLimiter;
  private readonly shutdown = new AbortController();

  constructor(
    private readonly configService: ConfigService,
    private readonly engines: EngineRegistry,
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
  ) {
    const concurrency = this.configService.get<number>('mediaConversion.concurrency', 2);
    this.ffmpegGate = new ConcurrencyLimiter(concurrency, concurrency * 4);
  }

  /**
   * Clear what a previous process killed mid-conversion left in the temp dir. Not awaited, so a slow or
   * failing temp dir never holds up the boot. Twice the conversion timeout, and never under an hour, is older
   * than any conversion still running under the same settings in a process that shares the temp dir.
   */
  onModuleInit(): void {
    const timeoutMs = this.configService.get<number>('mediaConversion.timeoutMs', 60_000);
    void removeStaleConversionDirs(Math.max(STALE_CONVERSION_DIR_MIN_AGE_MS, 2 * timeoutMs), (message, error) =>
      this.logger.warn(message, { error: String(error) }),
    );
  }

  /**
   * Kill the detached ffmpeg groups still running. Nest's own signal handler re-raises the signal
   * once its hooks finish, so the process dies from it without ever emitting `exit`; this hook runs
   * on that path and on `app.close()`.
   */
  onApplicationShutdown(): void {
    this.shutdown.abort();
    this.ffmpegGate.close();
    killRunningConversions();
  }

  /**
   * Convert to a WhatsApp voice note: Ogg/Opus, which is what produces a playable mic bubble.
   *
   * This exists because nothing else in the pipeline transcodes. A caller who posts MP3 bytes with
   * `ptt: true` gets them sent as-is, labelled `audio/ogg; codecs=opus` because that is the default
   * applied when no mimetype is given — the declared type and the actual bytes disagree, and the
   * recipient sees a voice note that will not play.
   */
  async convertToVoice(sessionId: string, dto: ConvertMediaDto): Promise<ConvertedMedia> {
    return this.convert(sessionId, dto, 'ogg', voiceEncodeArgs(), 'audio/ogg; codecs=opus');
  }

  /** Convert to an MP4 WhatsApp will accept and preview on every client. */
  async convertToVideo(sessionId: string, dto: ConvertMediaDto): Promise<ConvertedMedia> {
    return this.convert(sessionId, dto, 'mp4', videoEncodeArgs(), 'video/mp4');
  }

  /** Whether conversion is both switched on and actually runnable on this host. */
  async isAvailable(): Promise<boolean> {
    if (this.shutdown.signal.aborted || !this.configService.get<boolean>('mediaConversion.enabled', false))
      return false;
    const available = await this.probeOnce();
    return available && !this.shutdown.signal.aborted;
  }

  private async convert(
    sessionId: string,
    dto: ConvertMediaDto,
    outputExtension: string,
    encodeArgs: string[],
    outputMimetype: string,
  ): Promise<ConvertedMedia> {
    this.assertRunning();
    await this.assertAvailable();

    try {
      // The input is loaded inside the gate: a download of up to MEDIA_DOWNLOAD_MAX_BYTES, or a decoded
      // base64 body, held for each request that had not yet reached a slot, would stack 50 MiB a request
      // in heap while the gate answers 503 only after the downloads finished.
      const { input, output } = await this.ffmpegGate.run(async () => {
        this.assertRunning();
        const loaded = await this.resolveInput(sessionId, dto);
        this.assertRunning();
        const converted = await runFfmpeg(loaded, 'bin', outputExtension, encodeArgs, {
          signal: this.shutdown.signal,
          ffmpegPath: this.configService.get<string>('mediaConversion.ffmpegPath', 'ffmpeg'),
          timeoutMs: this.configService.get<number>('mediaConversion.timeoutMs', 60_000),
          maxOutputBytes: this.configService.get<number>('mediaConversion.maxOutputBytes', 50 * 1024 * 1024),
        });
        return { input: loaded, output: converted };
      });
      this.logger.log('Media converted', { inputBytes: input.length, outputBytes: output.length, outputMimetype });
      return { base64: output.toString('base64'), mimetype: outputMimetype, bytes: output.length };
    } catch (error) {
      this.assertRunning();
      if (error instanceof Error && error.message === 'ConcurrencyLimiter queue full') {
        throw new ServiceUnavailableException('Media conversion is busy — retry shortly');
      }
      if (error instanceof FfmpegSpawnError) {
        // The host could not start ffmpeg (a binary removed since the probe, or a process, memory or
        // descriptor limit), which is no fault of the input. Probe again on the next call.
        this.binaryAvailable = undefined;
        this.logger.warn('Media conversion could not start ffmpeg', { reason: error.message });
        throw new ServiceUnavailableException(
          'Media conversion could not start the ffmpeg binary. Retry shortly, or check FFMPEG_PATH.',
        );
      }
      if (error instanceof FfmpegConversionError) {
        // ffmpeg's stderr is about the caller's own bytes, so returning it is what makes a rejection
        // actionable. It never names a path the caller did not supply: the only paths in the command
        // are the temp files this process created, and runFfmpeg strips their directory.
        this.logger.warn('Media conversion failed', { reason: error.message, detail: error.detail });
        throw new BadRequestException(error.detail ? `${error.message}: ${error.detail}` : error.message);
      }
      throw error;
    }
  }

  /**
   * The egress proxy a URL fetch made for this session must leave through.
   *
   * A running engine's proxy wins, including when it is none: it is the address every other byte of
   * that session leaves from, and `PATCH /proxy` can have changed the row since without restarting
   * the engine. With no engine running there is no such egress, so the stored row is used instead,
   * which keeps the fetch off the gateway's own address for a session an operator has proxied.
   */
  private async sessionProxy(sessionId: string): Promise<string | undefined> {
    if (this.engines.has(sessionId)) {
      return this.engines.proxyUrl(sessionId);
    }
    // Ids are varchar, and a restored session can keep a safe non-uuid id. A NUL cannot be bound by
    // PostgreSQL, so it answers "no session" instead of raising.
    if (sessionId.includes('\0')) return undefined;
    const session = await this.sessionRepository.findOne({ where: { id: sessionId }, select: { proxyUrl: true } });
    return session?.proxyUrl ?? undefined;
  }

  /** Read the caller's media into memory, honouring the same caps and SSRF guard as a send. */
  private async resolveInput(sessionId: string, dto: ConvertMediaDto): Promise<Buffer> {
    // Stripped first: a bare `data:...;base64,` prefix holds no bytes, so a url beside it is used.
    const base64 = stripBase64DataUri(dto.base64);
    if (base64) {
      // Checked before decoding, so an oversized payload is refused without allocating it.
      assertBase64WithinMediaCap(base64);
      const data = Buffer.from(base64, 'base64');
      if (data.length === 0) throw new BadRequestException('base64 did not decode to any bytes');
      return data;
    }
    if (dto.url) {
      // Through the SSRF guard, exactly as a send does: it validates the host and pins the
      // connection to the vetted address. ffmpeg itself never sees a URL — it is restricted to the
      // file protocol and handed bytes this process already fetched and checked. It also leaves
      // through the named session's proxy, exactly as a send by URL does (#1626).
      // Resolved BEFORE the try, which exists to map a bad URL to a 400: a session-row read that
      // fails is a server fault, and reporting it as a bad URL (with the driver's own message
      // attached) would tell a client not to retry something transient.
      const proxyUrl = await this.sessionProxy(sessionId);
      try {
        const { data } = await loadRemoteMediaBuffer(dto.url, proxyUrl);
        return data;
      } catch (error) {
        // The fetch layer already answers 400/413 for a bad status, a timeout, a failed connection
        // or a body over the cap (503 when the session proxy fails before any response), exactly
        // as on the send path. An SSRF block is reported
        // generically: its raw message names the resolved internal address. Anything else (a
        // malformed session proxy, say) is a server fault and stays a 500, as it does on a send,
        // rather than a 400 carrying a message that can name the proxy.
        if (error instanceof SsrfBlockedError) {
          throw new BadRequestException(SSRF_BLOCKED_CLIENT_MESSAGE);
        }
        throw error;
      }
    }
    throw new BadRequestException('Either url or base64 must be provided');
  }

  private assertRunning(): void {
    if (this.shutdown.signal.aborted) {
      throw new ServiceUnavailableException('Media conversion is shutting down');
    }
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
   * Probe until a probe succeeds. The promise itself is memoised rather than its result, so concurrent
   * first requests share one probe instead of each spawning their own.
   */
  private probeOnce(): Promise<boolean> {
    this.binaryAvailable ??= probeFfmpeg(this.configService.get<string>('mediaConversion.ffmpegPath', 'ffmpeg')).then(
      available => {
        if (!available) {
          this.binaryAvailable = undefined;
          this.logger.warn('Media conversion is enabled but ffmpeg could not be run');
        }
        return available;
      },
    );
    return this.binaryAvailable;
  }
}
