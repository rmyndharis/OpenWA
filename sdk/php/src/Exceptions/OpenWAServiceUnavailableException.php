<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * 503 Service Unavailable — a transport failure, not a refusal.
 *
 * The gateway answers this when the engine did not confirm the operation in time: WhatsApp never
 * replied, the socket was down, or the request budget ran out. Retryable, unlike every other typed
 * exception here. The non-idempotent sends are deliberately left unbounded by the gateway so they
 * never answer one.
 */
class OpenWAServiceUnavailableException extends OpenWAApiException
{
}
