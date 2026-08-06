/**
 * Media resource — server-side conversion into the formats WhatsApp plays.
 *
 * Backed by `src/modules/media/media.controller.ts` (`@Controller('sessions/:sessionId/media')`).
 * @packageDocumentation
 */

import { encodeSegment } from '../http.js';
import type { OpenWAClient } from '../client.js';
import type { ConvertMediaInput, ConvertedMedia, MediaConversionAvailability } from '../types.js';

export class MediaResource {
  constructor(private readonly client: OpenWAClient) {}

  /**
   * Whether conversion is switched on for this deployment AND the ffmpeg binary can
   * be run. Worth checking once: a caller on a server without it must convert on its
   * own side rather than receiving an error per request.
   */
  conversionStatus(sessionId: string): Promise<MediaConversionAvailability> {
    return this.client.request<MediaConversionAvailability>({
      method: 'GET',
      path: `/api/sessions/${encodeSegment(sessionId)}/media/convert`,
    });
  }

  /**
   * Convert audio into a WhatsApp voice note (Ogg/Opus, mono, tuned for speech).
   *
   * WhatsApp shows a playable mic bubble only for this format — sending MP3 bytes with
   * `ptt: true` produces a voice note that will not play. Pass the returned `base64`
   * straight to `messages.sendAudio(..., { ptt: true })`. Requires an OPERATOR key.
   */
  convertVoice(sessionId: string, input: ConvertMediaInput): Promise<ConvertedMedia> {
    return this.client.request<ConvertedMedia>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/media/convert/voice`,
      body: input,
    });
  }

  /**
   * Convert video into an MP4 every WhatsApp client accepts: baseline H.264 with AAC
   * audio, long edge bounded at 1280, index moved to the front for immediate playback.
   * Requires an OPERATOR key.
   */
  convertVideo(sessionId: string, input: ConvertMediaInput): Promise<ConvertedMedia> {
    return this.client.request<ConvertedMedia>({
      method: 'POST',
      path: `/api/sessions/${encodeSegment(sessionId)}/media/convert/video`,
      body: input,
    });
  }
}
