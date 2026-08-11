<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Webhooks resource — configure event delivery to external HTTP endpoints.
 *
 * Backed by src/modules/webhook/webhook.controller.ts.
 */
class WebhooksResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * List webhooks across EVERY session the key can see, not one session's. Requires an
     * OPERATOR-level key.
     *
     * @param array<string,mixed> $query Optional pagination: `limit`, `offset`.
     *
     * @return array<int,array<string,mixed>>
     */
    public function listAll(array $query = []): array
    {
        return $this->http->request('GET', '/api/webhooks', $query) ?? [];
    }

    /**
     * Deliveries that were ATTEMPTED and failed — the diagnostic for a webhook that stopped arriving.
     * Requires an ADMIN-level key. A delivery a smart filter suppressed never reaches this log.
     *
     * @param array<string,mixed> $query Optional filter: `sessionId`, `limit`, `offset`.
     *
     * @return mixed the response has no published schema, so it is returned unshaped
     */
    public function deliveryFailures(array $query = [])
    {
        return $this->http->request('GET', '/api/webhooks/delivery-failures', $query);
    }

    /** @return array<int,array<string,mixed>> */
    public function list(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/webhooks") ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $id): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/webhooks/{$this->http->encodeSegment($id)}");
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function create(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/webhooks", [], $body);
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function update(string $sessionId, string $id, array $body): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/webhooks/{$this->http->encodeSegment($id)}", [], $body);
    }

    public function delete(string $sessionId, string $id): void
    {
        $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/webhooks/{$this->http->encodeSegment($id)}");
    }

    /** @return array<string,mixed> */
    public function test(string $sessionId, string $id): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/webhooks/{$this->http->encodeSegment($id)}/test");
    }
}
