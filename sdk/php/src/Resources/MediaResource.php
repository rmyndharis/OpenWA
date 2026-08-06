<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Media resource — server-side conversion into the formats WhatsApp plays.
 *
 * Backed by src/modules/media/media.controller.ts.
 */
class MediaResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * Whether conversion is switched on for this deployment AND the ffmpeg binary
     * can be run. Worth checking once: against a server without it a caller must
     * convert on its own side rather than take an error per request.
     *
     * @return array<string,mixed>
     */
    public function conversionStatus(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/media/convert");
    }

    /**
     * Convert audio into a WhatsApp voice note (Ogg/Opus, mono, tuned for speech).
     *
     * WhatsApp shows a playable mic bubble only for this format — MP3 bytes sent
     * with ptt produce a voice note that will not play. Pass the returned base64 to
     * sendAudio with ptt set. Requires an OPERATOR-level key.
     *
     * @param array<string,mixed> $media Exactly one of url or base64.
     * @return array<string,mixed>
     */
    public function convertVoice(string $sessionId, array $media): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/media/convert/voice", [], $media);
    }

    /**
     * Convert video into an MP4 every WhatsApp client accepts: baseline H.264 with
     * AAC audio, long edge bounded at 1280, index moved to the front for immediate
     * playback. Requires an OPERATOR-level key.
     *
     * @param array<string,mixed> $media Exactly one of url or base64.
     * @return array<string,mixed>
     */
    public function convertVideo(string $sessionId, array $media): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/media/convert/video", [], $media);
    }
}
