<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/** Raised when a request exceeds the configured timeout. */
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
