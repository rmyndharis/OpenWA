<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Calls resource — incoming voice/video call handling.
 *
 * Backed by src/modules/call/call.controller.ts.
 */
class CallsResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * Reject a ringing incoming call (the callId from the call.received event).
     * 404 when the call is not found or no longer ringing. Requires an
     * OPERATOR-level key.
     *
     * @return array<string,mixed>
     */
    public function rejectCall(string $sessionId, string $callId): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/calls/{$this->http->encodeSegment($callId)}/reject");
    }
    /**
     * Create a shareable WhatsApp call link.
     *
     * Both fields are required. `startTime` is absolute epoch MILLISECONDS — a link for right now is
     * the current timestamp rather than an omitted field, because whatsapp-web.js generates an
     * event-linked call and has no notion of "no start time". A WhatsApp-side failure answers `403`
     * rather than a success carrying an empty link.
     *
     * @param array{type:string,startTime:int|float} $body
     * @return array<string,mixed>
     */
    public function createLink(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/calls/link", [], $body);
    }

}
