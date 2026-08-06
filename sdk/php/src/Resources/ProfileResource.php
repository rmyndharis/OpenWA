<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Profile resource — the connected account's own profile.
 *
 * Backed by src/modules/profile/profile.controller.ts.
 */
class ProfileResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * Set the account display name. Requires an OPERATOR-level key.
     *
     * @return array<string,mixed>
     */
    public function setProfileName(string $sessionId, string $name): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/profile/name", [], ['name' => $name]);
    }

    /**
     * Set the account about/status text; an empty string clears it. Requires an
     * OPERATOR-level key.
     *
     * @return array<string,mixed>
     */
    public function setProfileStatus(string $sessionId, string $status): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/profile/status", [], ['status' => $status]);
    }

    /**
     * Set the account profile picture. Body is either {url} or
     * {base64, mimetype}. Requires an OPERATOR-level key.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function setProfilePicture(string $sessionId, array $body): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/profile/picture", [], $body);
    }
}
