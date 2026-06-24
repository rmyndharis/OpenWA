<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Templates resource — stored message templates with {{variable}} placeholders.
 *
 * Backed by src/modules/template/template.controller.ts
 * (@Controller('sessions/:sessionId/templates')).
 */
class TemplatesResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /** @return array<int,array<string,mixed>> */
    public function list(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/templates") ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $templateId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/templates/{$this->http->encodeSegment($templateId)}");
    }

    /**
     * Create a template. Requires an OPERATOR-level key.
     *
     * @param array<string,mixed> $body  Must contain 'name' and 'body'; 'header'/'footer' optional.
     * @return array<string,mixed>
     */
    public function create(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/templates", [], $body);
    }

    /**
     * Update a template. Requires an OPERATOR-level key.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function update(string $sessionId, string $templateId, array $body): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/templates/{$this->http->encodeSegment($templateId)}", [], $body);
    }

    /** Delete a template. Requires an OPERATOR-level key. */
    public function delete(string $sessionId, string $templateId): void
    {
        $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/templates/{$this->http->encodeSegment($templateId)}");
    }
}
