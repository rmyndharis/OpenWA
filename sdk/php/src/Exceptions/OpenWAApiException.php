<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * Raised when the API responds with a non-2xx status.
 *
 * Carries the HTTP status code and the parsed error body. Use the named
 * subclass for common statuses, or branch on getStatus().
 */
class OpenWAApiException extends OpenWAException
{
    private int $status;
    /** @var mixed */
    private $body;
    private ?string $errorKind;

    /**
     * @param mixed $body
     */
    public function __construct(string $message, int $status, $body = null, ?string $errorKind = null)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->body = $body;
        $this->errorKind = $errorKind;
    }

    public function getStatus(): int
    {
        return $this->status;
    }

    /** @return mixed */
    public function getBody()
    {
        return $this->body;
    }

    public function getErrorKind(): ?string
    {
        return $this->errorKind;
    }

    /**
     * Build the most specific OpenWAApiException subclass for a status code.
     *
     * @param mixed $body
     */
    public static function classify(int $status, string $message, $body, ?string $errorKind): OpenWAApiException
    {
        return match ($status) {
            401 => new OpenWAAuthException($message, $status, $body, $errorKind),
            403 => new OpenWAForbiddenException($message, $status, $body, $errorKind),
            404 => new OpenWANotFoundException($message, $status, $body, $errorKind),
            409 => new OpenWAConflictException($message, $status, $body, $errorKind),
            429 => new OpenWARateLimitException($message, $status, $body, $errorKind),
            501 => new OpenWANotImplementedException($message, $status, $body, $errorKind),
            default => new OpenWAApiException($message, $status, $body, $errorKind),
        };
    }
}
