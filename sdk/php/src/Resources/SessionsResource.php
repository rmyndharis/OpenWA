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

    /** @return array<int,array<string,mixed>> */
    public function list(): array
    {
        return $this->http->request('GET', '/api/sessions') ?? [];
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
}
