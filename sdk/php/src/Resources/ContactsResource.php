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
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts", $query) ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $contactId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/{$this->http->encodeSegment($contactId)}");
    }

    /** @return array<string,mixed> */
    public function check(string $sessionId, string $number): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/check/{$this->http->encodeSegment($number)}");
    }

    /** @return array<string,mixed> */
    public function profilePicture(string $sessionId, string $contactId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/{$this->http->encodeSegment($contactId)}/profile-picture");
    }

    /**
     * Batch-resolve profile picture URLs for up to 50 contacts in one request.
     *
     * @param list<string> $ids
     * @return array{pictures: array<string,?string>} Map of contact id → URL (null when a lookup fails).
     */
    public function profilePictures(string $sessionId, array $ids): array
    {
        return $this->http->request(
            'GET',
            "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/profile-pictures",
            ['ids' => implode(',', $ids)]
        );
    }

    /** @return array<string,mixed> */
    public function phone(string $sessionId, string $contactId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/{$this->http->encodeSegment($contactId)}/phone");
    }

    /** @return array<string,mixed> */
    public function block(string $sessionId, string $contactId): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/{$this->http->encodeSegment($contactId)}/block");
    }

    /**
     * Save a contact to the addressbook, or edit an existing entry. Requires an OPERATOR key.
     *
     * @param array<string,mixed> $body firstName and an optional lastName.
     * @return array<string,mixed>
     */
    public function upsert(string $sessionId, string $contactId, array $body): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/{$this->http->encodeSegment($contactId)}", [], $body) ?? [];
    }

    /**
     * Remove a contact from the addressbook. Requires an OPERATOR key.
     *
     * @return array<string,mixed>
     */
    public function delete(string $sessionId, string $contactId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/{$this->http->encodeSegment($contactId)}") ?? [];
    }

    /** @return array<string,mixed> */
    public function unblock(string $sessionId, string $contactId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/{$this->http->encodeSegment($contactId)}/block");
    }

    /**
     * List the JIDs this account has blocked.
     *
     * Session-wide, so it takes no contact id — unlike block() and unblock(), which act on one
     * contact. Returns a bare list of ids, not contact records.
     *
     * @return array<int,string>
     */
    public function listBlocked(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/contacts/blocked");
    }
}
