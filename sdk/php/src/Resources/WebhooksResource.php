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
     * Deliveries the gateway gave up on or could not dispatch: the diagnostic for a webhook that
     * stopped arriving. Rows with `attempts > 0` exhausted their retries against the receiver. Rows
     * with `attempts === 0` were not given up after retries: the payload was over the size cap or
     * could not be serialized after the webhook:before hooks, dispatch capacity was shed, or shutdown
     * interrupted the delivery (possibly between retries, after earlier attempts). A row is removed
     * once a later replay delivers the event. Requires an ADMIN-level key. A delivery a smart filter
     * suppressed never reaches this log.
     *
     * @param array<string,mixed> $query Optional filter: `sessionId`, `limit`, `offset`.
     *
     * @return array<int,array<string,mixed>> most recent first; each entry carries `id`, `webhookId`,
     *                                        `sessionId`, `event`, `url`, `attempts`, `lastError` and
     *                                        `createdAt`, plus nullable `idempotencyKey`, `deliveryId`
     *                                        and `lastStatusCode`, and `replayable` (true when the row
     *                                        still holds its event data and its webhook still exists;
     *                                        redriveDeliveryFailures replays it while that webhook is
     *                                        active and subscribed to the event)
     */
    public function deliveryFailures(array $query = [])
    {
        return $this->http->request('GET', '/api/webhooks/delivery-failures', $query);
    }

    /**
     * Replay recorded deliveries that still hold their event data (`replayable` in deliveryFailures),
     * fewest attempts first, then oldest, one bounded batch per call. Each replay reuses the stored
     * idempotency key, so a receiver that already handled the event can dedup it. Only rows recorded while the gateway's
     * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS is above 0 are replayable. Requires an ADMIN-level key;
     * rows outside the key's allowedSessions are never touched.
     *
     * @param array<string,mixed> $body Optional filter: `sessionId`, `webhookId`, `ids` (at most 500),
     *                                  `limit` (1-500, default 100). Empty uses the default batch filter.
     *
     * @return array<string,mixed> `redriven`, `delivered`, `enqueued`, `failed`, `skipped`, `remaining`
     */
    public function redriveDeliveryFailures(array $body = []): array
    {
        return $this->http->request('POST', '/api/webhooks/delivery-failures/redrive', [], (object) $body);
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
        // Preserve object-map shape without writing through caller-held references.
        if (isset($body['headers']) && is_array($body['headers'])) {
            $body = array_merge($body, ['headers' => (object) $body['headers']]);
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
        if (isset($body['headers']) && is_array($body['headers'])) {
            $body = array_merge($body, ['headers' => (object) $body['headers']]);
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
