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
