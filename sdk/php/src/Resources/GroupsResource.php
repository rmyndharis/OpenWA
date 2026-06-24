<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Groups resource — WhatsApp group management.
 *
 * Backed by src/modules/group/group.controller.ts.
 */
class GroupsResource
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
        return $this->http->request('GET', "/api/sessions/{$sessionId}/groups", $query) ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $groupId): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/groups/{$groupId}");
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function create(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/groups", [], $body);
    }

    /** @return array<string,mixed> */
    public function addParticipants(string $sessionId, string $groupId, array $participants): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/groups/{$groupId}/participants", [], ['participants' => $participants]);
    }

    /** @return array<string,mixed> */
    public function removeParticipants(string $sessionId, string $groupId, array $participants): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$sessionId}/groups/{$groupId}/participants", [], ['participants' => $participants]);
    }

    /** @return array<string,mixed> */
    public function promoteParticipants(string $sessionId, string $groupId, array $participants): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/groups/{$groupId}/participants/promote", [], ['participants' => $participants]);
    }

    /** @return array<string,mixed> */
    public function demoteParticipants(string $sessionId, string $groupId, array $participants): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/groups/{$groupId}/participants/demote", [], ['participants' => $participants]);
    }

    /** @return array<string,mixed> */
    public function setSubject(string $sessionId, string $groupId, string $subject): array
    {
        return $this->http->request('PUT', "/api/sessions/{$sessionId}/groups/{$groupId}/subject", [], ['subject' => $subject]);
    }

    /** @return array<string,mixed> */
    public function setDescription(string $sessionId, string $groupId, string $description): array
    {
        return $this->http->request('PUT', "/api/sessions/{$sessionId}/groups/{$groupId}/description", [], ['description' => $description]);
    }

    /** @return array<string,mixed> */
    public function leave(string $sessionId, string $groupId): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/groups/{$groupId}/leave");
    }

    /** @return array<string,mixed> */
    public function inviteCode(string $sessionId, string $groupId): array
    {
        return $this->http->request('GET', "/api/sessions/{$sessionId}/groups/{$groupId}/invite-code");
    }

    /** @return array<string,mixed> */
    public function revokeInviteCode(string $sessionId, string $groupId): array
    {
        return $this->http->request('POST', "/api/sessions/{$sessionId}/groups/{$groupId}/invite-code/revoke");
    }
}
