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
     * @return array<int,array<string,mixed>> most recent first; each entry carries `id`, `webhookId`,
     *                                        `sessionId`, `event`, `url`, `attempts`, `lastError` and
     *                                        `createdAt`, plus nullable `idempotencyKey`, `deliveryId`
     *                                        and `lastStatusCode`
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
     * A `secret` in $body signs every delivery as `X-OpenWA-Signature: sha256=<hex>`. The gateway
     * enforces a 16-character minimum on it and answers 400 below that; omit it for unsigned
     * deliveries. Neither `secret` nor `headers` is returned by a read.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function create(string $sessionId, array $body): array
    {
        // headers is a map: an empty PHP array would serialize as a JSON list [] and be rejected by
        // the gateway's object validation. Cast the empty map to stdClass so it encodes as {}.
        if (isset($body['headers']) && $body['headers'] === []) {
            $body['headers'] = new \stdClass();
        }
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/webhooks", [], $body);
    }

    /**
     * Partial update: an absent key is left alone. The create route's 16-character minimum on
     * `secret` applies here too, with one exception: `''` is the documented "clear the secret"
     * value and is accepted, as `[]` is for `headers`.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function update(string $sessionId, string $id, array $body): array
    {
        // Same empty-map cast as create(): headers must encode as {} when empty.
        if (isset($body['headers']) && $body['headers'] === []) {
            $body['headers'] = new \stdClass();
        }
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
