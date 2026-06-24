<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Contacts resource — contact lookup and management.
 *
 * Backed by src/modules/contact/contact.controller.ts.
 */
class ContactsResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * @param array<string,mixed> $query
     * @return array<int,array<string,mixed>>
     */
    public function list(string $sessionId, array $query = []): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/contacts", $query) ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $contactId): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/contacts/{$contactId}");
    }

    /** @return array<string,mixed> */
    public function check(string $sessionId, string $number): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/contacts/check/{$number}");
    }

    /** @return array<string,mixed> */
    public function profilePicture(string $sessionId, string $contactId): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/contacts/{$contactId}/profile-picture");
    }

    /** @return array<string,mixed> */
    public function phone(string $sessionId, string $contactId): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/contacts/{$contactId}/phone");
    }

    /** @return array<string,mixed> */
    public function block(string $sessionId, string $contactId): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/contacts/{$contactId}/block");
    }

    /** @return array<string,mixed> */
    public function unblock(string $sessionId, string $contactId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$sessionId}/contacts/{$contactId}/block");
    }
}
