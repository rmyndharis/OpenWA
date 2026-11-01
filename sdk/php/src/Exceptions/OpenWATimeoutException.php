<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * Raised when a request exceeds the configured timeout. The gateway may still complete the request:
 * retry a send only with the same Idempotency-Key, and re-read state before repeating any other write.
 */
class OpenWATimeoutException extends OpenWAException
{
    private float $timeout;

    public function __construct(float $timeout)
    {
        parent::__construct("Request timed out after {$timeout}s");
        $this->timeout = $timeout;
    }

    public function getTimeout(): float
    {
        return $this->timeout;
    }
}
