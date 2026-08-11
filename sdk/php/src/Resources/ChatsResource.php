<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Chats resource — chat-list operations (read/unread/delete/typing state).
 *
 * These endpoints live under the session controller (/api/sessions/:id/chats/*)
 * but are surfaced here as a dedicated resource for clarity.
 */
class ChatsResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * @param array<string,mixed> $query
     * @return array<int,array<string,mixed>>
     */
    public function list(string $sessionId, array $query = []): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats", $query) ?? [];
    }

    /**
     * Subscribe to a chat's presence; updates then arrive as `presence.update` events. Presence
     * cannot be fetched from either engine, only received. The subscription belongs to the
     * connection and does NOT survive a restart or an automatic reconnect, so re-issue it when the
     * session comes back. whatsapp-web.js answers 501.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function subscribePresence(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/presence/subscribe", [], $body);
    }

    /**
     * The last presence reported for a chat, or null when none has been — the chat was never
     * subscribed, or nothing has changed since. Held in memory, so a restart clears it.
     *
     * @return array<string,mixed>|null
     */
    public function getPresence(string $sessionId, string $chatId): ?array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/presence/{$this->http->encodeSegment($chatId)}");
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function markRead(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats/read", [], $body);
    }

    /** @return array<string,mixed> */
    public function markUnread(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats/unread", [], $body);
    }

    /**
     * Delete every message in a chat, keeping the chat itself.
     *
     * @return array<string,mixed>
     */
    public function clearMessages(string $sessionId, string $chatId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats/{$this->http->encodeSegment($chatId)}/messages") ?? [];
    }

    /**
     * Archive or unarchive a chat. A false `success` means the engine declined — on Baileys a chat
     * with no known history cannot be archived.
     *
     * @param array<string,mixed> $body chatId and archive (bool).
     * @return array<string,mixed>
     */
    public function archive(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats/archive", [], $body) ?? [];
    }

    /**
     * Pin a chat to the top of the list, or unpin it.
     *
     * `success: false` means WhatsApp declined — an account may pin only three chats at a time.
     *
     * @param array<string,mixed> $body chatId and pin (bool).
     * @return array<string,mixed>
     */
    public function pin(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats/pin", [], $body) ?? [];
    }

    /**
     * Mute a chat until an absolute timestamp, or unmute it with `muteUntil: null`.
     *
     * `muteUntil` is epoch MILLISECONDS. Passing seconds points at an instant in 1970, so the mute
     * expires the moment it is set while the call still succeeds — nothing in the response
     * distinguishes that from a mute that took effect. It is required, not optional: the two
     * readings of an omitted value, unmute now and mute indefinitely, are opposites.
     *
     * @param array<string,mixed> $body chatId and muteUntil (int epoch ms, or null to unmute).
     * @return array<string,mixed>
     */
    public function mute(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats/mute", [], $body) ?? [];
    }

    /** @return array<string,mixed> */
    public function delete(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats/delete", [], $body);
    }

    /** @return array<string,mixed> */
    public function sendState(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/chats/typing", [], $body);
    }
}
