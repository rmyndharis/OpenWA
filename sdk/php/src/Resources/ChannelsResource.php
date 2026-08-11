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
     * Create a channel. The account owns it, which is what makes delete() possible later.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function create(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels", [], $body);
    }

    /**
     * Delete a channel this account owns. Irreversible; every subscriber loses it.
     *
     * Note the path: unsubscribe is the DELETE route, and the two are deliberately not reachable by
     * the same request — leaving a channel and destroying it are very different acts.
     *
     * @return array<string,mixed>
     */
    public function delete(string $sessionId, string $channelId): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels/{$this->http->encodeSegment($channelId)}/delete");
    }

    /**
     * Mute or unmute a channel's notifications. The subscription is untouched either way.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function mute(string $sessionId, string $channelId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels/{$this->http->encodeSegment($channelId)}/mute", [], $body);
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
    /**
     * Demote a channel admin back to a subscriber. Requires an OPERATOR-level key.
     *
     * There is no promote counterpart: neither engine library has one, so an admin is promoted from
     * the WhatsApp app and demoted here. The whatsapp-web.js engine answers `501`.
     *
     * @param array{userId:string} $body
     * @return array<string,mixed>
     */
    public function demoteAdmin(string $sessionId, string $channelId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels/{$this->http->encodeSegment($channelId)}/admins/demote", [], $body);
    }

    /**
     * Hand a channel to a new owner. Requires an OPERATOR-level key.
     *
     * Irreversible: once the transfer lands this account stops being the owner and cannot take the
     * channel back. The whatsapp-web.js engine answers `501`.
     *
     * @param array{newOwnerId:string} $body
     * @return array<string,mixed>
     */
    public function transferOwnership(string $sessionId, string $channelId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/channels/{$this->http->encodeSegment($channelId)}/owner/transfer", [], $body);
    }

}
