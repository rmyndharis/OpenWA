<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Labels resource — WhatsApp Business chat labels.
 *
 * Backed by src/modules/label/label.controller.ts (@Controller('sessions/:sessionId/labels')).
 * Labels are a WhatsApp Business feature; the session must be a business account.
 */
class LabelsResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /** @return array<int,array<string,mixed>> */
    public function list(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels") ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $labelId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/{$this->http->encodeSegment($labelId)}");
    }

    /** @return array<int,array<string,mixed>> */
    public function forChat(string $sessionId, string $chatId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/chat/{$this->http->encodeSegment($chatId)}") ?? [];
    }

    /**
     * Add a label to a chat. Requires an OPERATOR-level key.
     *
     * @param array<string,mixed> $body  Must contain 'labelId'.
     * @return array<string,mixed>
     */
    public function addToChat(string $sessionId, string $chatId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/chat/{$this->http->encodeSegment($chatId)}", [], $body);
    }

    /** Remove a label from a chat. Requires an OPERATOR-level key. */
    public function removeFromChat(string $sessionId, string $chatId, string $labelId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/chat/{$this->http->encodeSegment($chatId)}/{$this->http->encodeSegment($labelId)}");
    }
}
