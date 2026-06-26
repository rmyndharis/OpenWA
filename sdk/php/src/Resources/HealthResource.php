<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Health resource — connectivity and readiness probes.
 *
 * Backed by src/modules/health/health.controller.ts.
 */
class HealthResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /** @return array<string,mixed> */
    public function check(): array
    {
        return $this->http->request('GET', '/api/health') ?? [];
    }

    /** @return array<string,mixed> */
    public function live(): array
    {
        return $this->http->request('GET', '/api/health/live') ?? [];
    }

    /** @return array<string,mixed> */
    public function ready(): array
    {
        return $this->http->request('GET', '/api/health/ready') ?? [];
    }
}
