<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * Raised when the API responds with a non-2xx status.
 *
 * Carries the HTTP status code, the parsed error body, the body's error code,
 * the retry delay and the response headers. Use the named subclass for common
 * statuses, or branch on getStatus().
 */
class OpenWAApiException extends OpenWAException
{
    private int $status;
    /** @var mixed */
    private $body;
    private ?string $errorKind;
    /** @var array<string, string[]> */
    private array $headers;
    private ?string $errorCode;
    private ?int $retryAfterSeconds;

    /**
     * @param mixed $body
     * @param array<string, string[]|string> $headers
     */
    public function __construct(
        string $message,
        int $status,
        $body = null,
        ?string $errorKind = null,
        array $headers = []
    ) {
        parent::__construct($message);
        $this->status = $status;
        $this->body = $body;
        $this->errorKind = $errorKind;
        $this->headers = array_map(fn ($v) => (array) $v, $headers);
        $fields = is_array($body) ? $body : [];
        $this->errorCode = is_string($fields['code'] ?? null) ? $fields['code'] : null;
        $retryHeader = array_change_key_case($this->headers)['retry-after'][0] ?? null;
        $this->retryAfterSeconds = self::retryAfter($fields['retryAfterSeconds'] ?? null, $retryHeader);
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
     * The body's machine-readable `code` (e.g. SEND_PACING_LIMITED), if any.
     * Exception::getCode() is final and returns an int, hence the name.
     */
    public function getErrorCode(): ?string
    {
        return $this->errorCode;
    }

    /**
     * Seconds to wait before retrying: the body's `retryAfterSeconds` when
     * present, else the Retry-After header (seconds or an HTTP date), else null.
     */
    public function getRetryAfterSeconds(): ?int
    {
        return $this->retryAfterSeconds;
    }

    /**
     * The response headers (empty when the exception did not come from a response).
     *
     * @return array<string, string[]>
     */
    public function getHeaders(): array
    {
        return $this->headers;
    }

    /**
     * The body's retryAfterSeconds wins: send pacing puts its wait (possibly
     * hours) only there, and a header added by a proxy must not shorten it.
     *
     * @param mixed $fromBody
     */
    private static function retryAfter($fromBody, ?string $header): ?int
    {
        if ((is_int($fromBody) || is_float($fromBody)) && $fromBody >= 0) {
            return (int) ceil($fromBody);
        }
        $value = trim((string) $header);
        if ($value === '') {
            return null;
        }
        // Not ctype_digit(): ext-ctype is optional and this SDK does not require it.
        if (preg_match('/^\d+$/D', $value) === 1) {
            return (int) $value;
        }
        $at = \DateTimeImmutable::createFromFormat('D, d M Y H:i:s \G\M\T', $value, new \DateTimeZone('UTC'));
        return $at === false ? null : max(0, $at->getTimestamp() - time());
    }

    /**
     * Build the most specific OpenWAApiException subclass for a status code.
     *
     * @param mixed $body
     * @param array<string, string[]|string> $headers
     */
    public static function classify(
        int $status,
        string $message,
        $body,
        ?string $errorKind,
        array $headers = []
    ): OpenWAApiException {
        return match ($status) {
            401 => new OpenWAAuthException($message, $status, $body, $errorKind, $headers),
            403 => new OpenWAForbiddenException($message, $status, $body, $errorKind, $headers),
            404 => new OpenWANotFoundException($message, $status, $body, $errorKind, $headers),
            409 => new OpenWAConflictException($message, $status, $body, $errorKind, $headers),
            429 => new OpenWARateLimitException($message, $status, $body, $errorKind, $headers),
            501 => new OpenWANotImplementedException($message, $status, $body, $errorKind, $headers),
            503 => new OpenWAServiceUnavailableException($message, $status, $body, $errorKind, $headers),
            default => new OpenWAApiException($message, $status, $body, $errorKind, $headers),
        };
    }
}
