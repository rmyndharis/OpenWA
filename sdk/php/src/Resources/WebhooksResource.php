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

    /** @return array<int,array<string,mixed>> */
    public function list(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/webhooks") ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $id): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/webhooks/{$id}");
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function create(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/webhooks", [], $body);
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function update(string $sessionId, string $id, array $body): array
    {
        return $this->http->request('PUT', "/api/sessions/{$sessionId}/webhooks/{$id}", [], $body);
    }

    public function delete(string $sessionId, string $id): void
    {
        $this->http->request('DELETE', "/api/sessions/{$sessionId}/webhooks/{$id}");
    }

    /** @return array<string,mixed> */
    public function test(string $sessionId, string $id): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/webhooks/{$id}/test");
    }
}
