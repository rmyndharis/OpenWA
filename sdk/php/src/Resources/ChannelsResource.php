<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Channels resource — WhatsApp Channels / Newsletters.
 *
 * Backed by src/modules/channel/channel.controller.ts (@Controller('sessions/:sessionId/channels')).
 */
class ChannelsResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /** @return array<int,array<string,mixed>> */
    public function list(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels") ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $channelId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels/{$this->http->encodeSegment($channelId)}");
    }

    /**
     * Get recent messages from a channel.
     *
     * @param array<string,mixed> $query  e.g. ['limit' => 50].
     * @return array<int,array<string,mixed>>
     */
    public function messages(string $sessionId, string $channelId, array $query = []): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels/{$this->http->encodeSegment($channelId)}/messages", $query) ?? [];
    }

    /**
     * Subscribe to a channel using its invite code. Requires an OPERATOR-level key.
     *
     * @param array<string,mixed> $body  Must contain 'inviteCode'.
     * @return array<string,mixed>
     */
    public function subscribe(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels/subscribe", [], $body);
    }

    /** Unsubscribe from a channel. Requires an OPERATOR-level key. */
    public function unsubscribe(string $sessionId, string $channelId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels/{$this->http->encodeSegment($channelId)}");
    }
}
