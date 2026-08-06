<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Messages resource — sending and querying messages.
 *
 * Backed by src/modules/message/message.controller.ts.
 * NOTE: the real paths use the /send- prefix, e.g. /messages/send-text.
 */
class MessagesResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * List messages, optionally filtered by chat or sender. Returns a page shaped
     * {messages: list, total: count} — iterate over the `messages` field, not the
     * result itself. Consistent with the JavaScript, Python, and Java SDKs.
     *
     * @param array<string,mixed> $query
     * @return array{messages: array<int,array<string,mixed>>, total: int}
     */
    public function list(string $sessionId, array $query = []): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages", $query)
            ?? ['messages' => [], 'total' => 0];
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function sendText(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/send-text", [], $body);
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function sendImage(string $sessionId, array $body): array
    {
        return $this->sendMedia($sessionId, 'send-image', $body);
    }

    /** @return array<string,mixed> */
    public function sendVideo(string $sessionId, array $body): array
    {
        return $this->sendMedia($sessionId, 'send-video', $body);
    }

    /** @return array<string,mixed> */
    public function sendAudio(string $sessionId, array $body): array
    {
        return $this->sendMedia($sessionId, 'send-audio', $body);
    }

    /** @return array<string,mixed> */
    public function sendDocument(string $sessionId, array $body): array
    {
        return $this->sendMedia($sessionId, 'send-document', $body);
    }

    /** @return array<string,mixed> */
    public function sendSticker(string $sessionId, array $body): array
    {
        return $this->sendMedia($sessionId, 'send-sticker', $body);
    }

    /** @return array<string,mixed> */
    private function sendMedia(string $sessionId, string $segment, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/{$this->http->encodeSegment($segment)}", [], $body);
    }

    /** @return array<string,mixed> */
    public function sendLocation(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/send-location", [], $body);
    }

    /** @return array<string,mixed> */
    public function sendContact(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/send-contact", [], $body);
    }

    /** @return array<string,mixed> */
    public function sendTemplate(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/send-template", [], $body);
    }

    /**
     * Send a native WhatsApp poll (2–12 options).
     *
     * @param array<string,mixed> $body {chatId, name, options, allowMultipleAnswers?}
     * @return array<string,mixed>
     */
    public function sendPoll(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/send-poll", [], $body);
    }

    /** @return array<string,mixed> */
    public function reply(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/reply", [], $body);
    }

    /** @return array<string,mixed> */
    public function forward(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/forward", [], $body);
    }

    /** @return array<string,mixed> */
    public function react(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/react", [], $body);
    }

    /** @return array<string,mixed> */
    public function delete(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/delete", [], $body);
    }

    /**
     * Edit the text of a message sent by this account. Body is
     * {chatId, messageId, body}; 404 when the message is not found.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function editMessage(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/edit", [], $body);
    }

    /**
     * @param array<string,mixed> $query
     * @return array<int,array<string,mixed>>
     */
    public function history(string $sessionId, string $chatId, array $query = []): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/{$this->http->encodeSegment($chatId)}/history", $query) ?? [];
    }

    /** @return array<int,array<string,mixed>> */
    public function reactions(string $sessionId, string $chatId, string $messageId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/{$this->http->encodeSegment($chatId)}/{$this->http->encodeSegment($messageId)}/reactions") ?? [];
    }

    /**
     * Pin a message in its chat.
     *
     * @param array<string,mixed> $body chatId, messageId and an optional durationSeconds of
     *                                   86400 (24h), 604800 (7d) or 2592000 (30d); defaults to 24h.
     * @return array<string,mixed>
     */
    public function pin(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/pin", [], $body) ?? [];
    }

    /**
     * Cast a vote on a poll. Not supported on the Baileys engine (501).
     *
     * @param array<string,mixed> $body chatId, pollMessageId and options (option TEXTS; [] clears).
     * @return array<string,mixed>
     */
    public function votePoll(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/vote-poll", [], $body) ?? [];
    }

    /**
     * Star or unstar a message. Best-effort on whatsapp-web.js, which silently ignores a message
     * it will not star.
     *
     * @param array<string,mixed> $body chatId, messageId and star (bool).
     * @return array<string,mixed>
     */
    public function star(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/star", [], $body) ?? [];
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function unpin(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/unpin", [], $body) ?? [];
    }

    /**
     * Fetch a message's archived media bytes (404 when nothing is archived for it).
     *
     * @return array{data: string, contentType: ?string}
     */
    public function media(string $sessionId, string $chatId, string $messageId): array
    {
        return $this->http->requestBinary('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/{$this->http->encodeSegment($chatId)}/{$this->http->encodeSegment($messageId)}/media");
    }

    /** @return array<string,mixed> */
    public function sendBulk(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/send-bulk", [], $body);
    }

    /** @return array<string,mixed> */
    public function batchStatus(string $sessionId, string $batchId): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/batch/{$this->http->encodeSegment($batchId)}");
    }

    /** @return array<string,mixed> */
    public function cancelBatch(string $sessionId, string $batchId): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/batch/{$this->http->encodeSegment($batchId)}/cancel");
    }
}
