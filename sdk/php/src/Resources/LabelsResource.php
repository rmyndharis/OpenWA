<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Labels resource — WhatsApp Business chat labels.
 *
 * Backed by src/modules/label/label.controller.ts (@Controller('sessions/:sessionId/labels')).
 * Labels are a WhatsApp Business feature; the session must be a business account.
 */
class LabelsResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /** @return array<int,array<string,mixed>> */
    public function list(string $sessionId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels") ?? [];
    }

    /** @return array<string,mixed> */
    public function get(string $sessionId, string $labelId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/{$this->http->encodeSegment($labelId)}");
    }

    /**
     * Every chat carrying a label. whatsapp-web.js only — Baileys has label writes but no label
     * query of any kind, and answers 501.
     *
     * @return array<int,array<string,mixed>>
     */
    public function chats(string $sessionId, string $labelId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/{$this->http->encodeSegment($labelId)}/chats") ?? [];
    }

    /**
     * Create or update a label. Baileys only; whatsapp-web.js answers 501.
     *
     * PUT rather than POST because you choose the id: WhatsApp carries one write keyed on it, so
     * whether this creates or updates depends purely on whether that id already exists. Pick an
     * unused id to create — reusing one rewrites that label rather than failing. Omitted fields are
     * left alone.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function upsert(string $sessionId, string $labelId, array $body): array
    {
        return $this->http->request('PUT', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/{$this->http->encodeSegment($labelId)}", [], $body);
    }

    /**
     * Delete a label; it disappears from every chat it was on. Baileys only.
     *
     * @return array<string,mixed>
     */
    public function delete(string $sessionId, string $labelId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/{$this->http->encodeSegment($labelId)}");
    }

    /** @return array<int,array<string,mixed>> */
    public function forChat(string $sessionId, string $chatId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/chat/{$this->http->encodeSegment($chatId)}") ?? [];
    }

    /**
     * Add a label to a chat. Requires an OPERATOR-level key.
     *
     * @param array<string,mixed> $body  Must contain 'labelId'.
     * @return array<string,mixed>
     */
    public function addToChat(string $sessionId, string $chatId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/chat/{$this->http->encodeSegment($chatId)}", [], $body);
    }

    /** Remove a label from a chat. Requires an OPERATOR-level key. */
    public function removeFromChat(string $sessionId, string $chatId, string $labelId): array
    {
        return $this->http->request('DELETE', "/api/sessions/{$this->http->encodeSegment($sessionId)}/labels/chat/{$this->http->encodeSegment($chatId)}/{$this->http->encodeSegment($labelId)}");
    }
}
