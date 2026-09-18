<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * 503 Service Unavailable — a transport failure, not a refusal.
 *
 * The gateway answers this when the engine did not confirm the operation in time: WhatsApp never
 * replied, the socket was down, or the request budget ran out. Retryable, unlike every other typed
 * exception here. The non-idempotent sends are deliberately left unbounded by the gateway so a slow
 * WhatsApp reply never answers one, and in a multi-node deployment a forwarded request answers 503
 * only when the owner node was never reached. A forward that fails after the request was sent
 * answers 502 or 504 instead (a plain OpenWAApiException): the owner may already have carried it
 * out, so do not repeat a non-idempotent send on those unchecked.
 */
class OpenWAServiceUnavailableException extends OpenWAApiException
{
}
