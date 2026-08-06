<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Search resource — full-text search across persisted messages.
 *
 * Backed by src/modules/search/search.controller.ts (GET /search). Requires an
 * active search provider (SEARCH_PROVIDER); responds 501 when none is configured
 * and 400 for an empty/whitespace `q`.
 */
class SearchResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * Search persisted messages via the active search provider.
     *
     * Only `q` is required; every other filter is optional and null values are
     * dropped before the request is sent (so absent optionals are not serialized
     * into the query string). Numeric filters are passed through as-is; the
     * gateway coerces and validates them server-side.
     *
     * @param array{
     *     q:string,
     *     sessionId?:string|null,
     *     chatId?:string|null,
     *     direction?:string|null,
     *     type?:string|null,
     *     from?:string|null,
     *     dateFrom?:int|float|string|null,
     *     dateTo?:int|float|string|null,
     *     limit?:int|string|null,
     *     offset?:int|string|null
     * } $params Query filters. `q` must be non-empty.
     *
     * @return array{
     *     hits:array<int,array<string,mixed>>,
     *     total:int,
     *     tookMs:int,
     *     provider:string
     * } Decoded SearchResults payload (empty array only on an unexpected null body).
     */
    public function search(array $params): array
    {
        return $this->http->request('GET', '/api/search', $params) ?? [];
    }
}
