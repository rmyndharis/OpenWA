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
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function sendText(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/send-text", [], $body);
    }

    /** @return array<string,mixed> */
    public function sendImage(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/send-image", [], $body);
    }

    /** @return array<string,mixed> */
    public function sendVideo(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/send-video", [], $body);
    }

    public function delete(string $sessionId, string $statusId): void
    {
        $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/status/{$this->http->encodeSegment($statusId)}");
    }
}
