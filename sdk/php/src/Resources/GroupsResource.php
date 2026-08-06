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
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups", $query) ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $groupId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}");
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function create(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups", [], $body);
    }

    /**
     * Preview a group from its invite code, WITHOUT joining. Read-only, so it is safe to call on a
     * code from an untrusted source. There is no participant list — the account is not a member —
     * only a count, and only when WhatsApp discloses one.
     *
     * @return array<string,mixed>
     */
    public function joinInfo(string $sessionId, string $code): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/join-info", ['code' => $code]);
    }

    /**
     * Join a group via an invite code (the token from a chat.whatsapp.com/<code>
     * link). Returns {success: true, groupId}.
     *
     * @return array<string,mixed>
     */
    public function joinGroup(string $sessionId, string $inviteCode): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/join", [], ['inviteCode' => $inviteCode]);
    }

    /** @return array<string,mixed> */
    public function addParticipants(string $sessionId, string $groupId, array $participants): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/participants", [], ['participants' => $participants]);
    }

    /** @return array<string,mixed> */
    public function removeParticipants(string $sessionId, string $groupId, array $participants): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/participants", [], ['participants' => $participants]);
    }

    /** @return array<string,mixed> */
    public function promoteParticipants(string $sessionId, string $groupId, array $participants): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/participants/promote", [], ['participants' => $participants]);
    }

    /** @return array<string,mixed> */
    public function demoteParticipants(string $sessionId, string $groupId, array $participants): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/participants/demote", [], ['participants' => $participants]);
    }

    /** @return array<string,mixed> */
    public function setSubject(string $sessionId, string $groupId, string $subject): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/subject", [], ['subject' => $subject]);
    }

    /** @return array<string,mixed> */
    public function setDescription(string $sessionId, string $groupId, string $description): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/description", [], ['description' => $description]);
    }

    /**
     * Get group settings. Only the settings the active engine supports are
     * present — any of {announce, locked, ephemeralSeconds} may be absent.
     *
     * @return array<string,mixed>
     */
    public function getGroupSettings(string $sessionId, string $groupId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/settings");
    }

    /**
     * Update group settings. At least one of {announce, locked,
     * ephemeralSeconds, memberAddMode} is required (400 otherwise);
     * ephemeralSeconds responds 501 on engines without disappearing-message
     * support (whatsapp-web.js). memberAddMode is 'all' or 'admins'.
     *
     * @param array<string,mixed> $settings
     * @return array<string,mixed>
     */
    public function updateGroupSettings(string $sessionId, string $groupId, array $settings): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/settings", [], $settings);
    }

    /** @return array<string,mixed> */
    public function leave(string $sessionId, string $groupId): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/leave");
    }

    /**
     * Get the group's picture URL (null when it has none).
     *
     * @return array<string,mixed>
     */
    public function getPicture(string $sessionId, string $groupId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/picture") ?? [];
    }

    /**
     * Set the group's picture. Requires admin rights on the group.
     *
     * @param array<string,mixed> $body url OR base64 (base64 wins), plus mimetype with base64.
     * @return array<string,mixed>
     */
    public function setPicture(string $sessionId, string $groupId, array $body): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/picture", [], $body) ?? [];
    }

    /**
     * Remove the group's picture. Requires admin rights on the group.
     *
     * @return array<string,mixed>
     */
    public function deletePicture(string $sessionId, string $groupId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/picture") ?? [];
    }

    /** @return array<string,mixed> */
    public function inviteCode(string $sessionId, string $groupId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/invite-code");
    }

    /** @return array<string,mixed> */
    public function revokeInviteCode(string $sessionId, string $groupId): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/groups/{$this->http->encodeSegment($groupId)}/invite-code/revoke");
    }
}
