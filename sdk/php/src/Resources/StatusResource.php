<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Status (Stories) resource — WhatsApp status updates.
 *
 * Backed by src/modules/status/status.controller.ts.
 * NOTE: this is WhatsApp "Status/Stories", distinct from session lifecycle status.
 */
class StatusResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /** @return array<string,mixed> */
    public function list(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status") ?? [];
    }

    /** @return array<string,mixed> */
    public function fromContact(string $sessionId, string $contactId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/{$this->http->encodeSegment($contactId)}") ?? [];
    }

    /**
     * Fetch the stored media bytes for a status update (404 when there is no stored media).
     *
     * @return array{data: string, contentType: ?string}
     */
    public function media(string $sessionId, string $statusId): array
    {
        return $this->http->requestBinary('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/{$this->http->encodeSegment($statusId)}/media");
    }

    /**
     * @param array<string,mixed> $body Body may include a `recipients` key (list<string> of JIDs).
     *                                   Required on the Baileys engine (absent/empty -> 400 there);
     *                                   ignored by whatsapp-web.js — omit it there.
     * @return array<string,mixed>
     */
    public function sendText(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/send-text", [], $body);
    }

    /**
     * @param array<string,mixed> $body Body may include a `recipients` key (list<string> of JIDs).
     *                                   Required on the Baileys engine (absent/empty -> 400 there);
     *                                   ignored by whatsapp-web.js — omit it there.
     * @return array<string,mixed>
     */
    public function sendImage(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/send-image", [], $body);
    }

    /**
     * @param array<string,mixed> $body Body may include a `recipients` key (list<string> of JIDs).
     *                                   Required on the Baileys engine (absent/empty -> 400 there);
     *                                   ignored by whatsapp-web.js — omit it there.
     * @return array<string,mixed>
     */
    public function sendVideo(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/send-video", [], $body);
    }

    /**
     * Post an audio status as a voice note (OPERATOR). The body takes an `audio` wrapper and an
     * optional `recipients` list and an optional `backgroundColor` (#RRGGBB, Baileys only); it
     * carries no caption, since WhatsApp has nowhere to render one on a status voice note. WhatsApp plays one only as Ogg/Opus and neither engine transcodes —
     * convert first via MediaResource::convertVoice.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function sendVoice(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/send-voice", [], $body);
    }

    public function delete(string $sessionId, string $statusId): void
    {
        $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/{$this->http->encodeSegment($statusId)}");
    }
}
