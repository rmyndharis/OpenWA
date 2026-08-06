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
}
