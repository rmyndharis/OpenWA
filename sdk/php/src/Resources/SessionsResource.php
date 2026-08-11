<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Sessions resource — lifecycle management for WhatsApp sessions.
 *
 * Backed by src/modules/session/session.controller.ts.
 */
class SessionsResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * @param array<string,mixed> $query Optional pagination: `limit`, `offset`.
     *
     * @return array<int,array<string,mixed>>
     */
    public function list(array $query = []): array
    {
        return $this->http->request('GET', '/api/sessions', $query) ?? [];
    }

    /**
     * Read a session's effective configuration.
     *
     * @return array<string,mixed>
     */
    public function getConfig(string $id): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($id)}/config");
    }

    /**
     * Update a RUNNING session's configuration — no re-link and no QR scan. All three fields were
     * fixed at creation before this route existed.
     *
     * @param array<string,mixed> $body autoRejectCalls, maxReconnectAttempts, reconnectBaseDelay
     *
     * @return array<string,mixed>
     */
    public function updateConfig(string $id, array $body): array
    {
        return $this->http->request('PATCH', "/api/sessions/{$this->http->encodeSegment($id)}/config", [], $body);
    }

    /** @return array<string,mixed> */
    public function get(string $id): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($id)}");
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function create(array $body): array
    {
        return $this->http->request('POST', '/api/sessions', [], $body);
    }

    public function delete(string $id): void
    {
        $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($id)}");
    }

    /** @return array<string,mixed> */
    public function start(string $id): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($id)}/start");
    }

    /** @return array<string,mixed> */
    public function stop(string $id): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($id)}/stop");
    }

    /**
     * Attempt an engine-native unlink of this device, then stop the session. A 200 means the
     * unlink operation AND the required local credential cleanup completed — it is not an
     * independent observation that the handset UI no longer shows the linked device. Because a
     * completed unlink wipes the stored credentials, a later start() requires a fresh QR scan or
     * pairing code. Requires a running session. Throws on HTTP 502 with
     * `code: 'SESSION_LOGOUT_INCOMPLETE'` when the session was stopped locally but the logout
     * operation did not complete (no send, no acknowledgement, timeout/transport error, or local
     * cleanup failure); `phone` is cleared and no success audit is written. Start the session
     * again and retry the logout; do not assume the retry reconnects automatically or lands in a
     * guaranteed QR state.
     *
     * @return array<string,mixed>
     */
    public function logout(string $id): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($id)}/logout");
    }

    /** @return array<string,mixed> */
    public function forceKill(string $id): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($id)}/force-kill");
    }

    /** @return array<string,mixed> */
    public function getQrCode(string $id): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($id)}/qr");
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function requestPairingCode(string $id, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($id)}/pairing-code", [], $body);
    }

    /** @return array<string,mixed> */
    public function stats(): array
    {
        return $this->http->request('GET', '/api/sessions/stats/overview');
    }

    /**
     * Set the account's own global presence — appear online, or offline.
     *
     * `available: false` hands notifications back to the phone: a linked device that stays online
     * suppresses the phone's own alerts. This is the ACCOUNT's presence, not a chat's — see
     * ChatsResource for per-chat typing/recording states.
     *
     * @param array{available:bool} $body
     * @return array<string,mixed>
     */
    public function setOnlinePresence(string $id, array $body): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($id)}/presence", [], $body);
    }

}
