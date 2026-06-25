<?php

declare(strict_types=1);

namespace OpenWA\Http;

use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\ConnectException;
use OpenWA\Exceptions\OpenWAApiException;
use OpenWA\Exceptions\OpenWATimeoutException;
use Psr\Http\Message\ResponseInterface;

/**
 * Injectable HTTP transport for the OpenWA SDK.
 *
 * The client never builds a bare Guzzle client with a hard-coded handler.
 * Instead it accepts an optional Guzzle {@see ClientInterface} (defaulting to a
 * new Guzzle client), and for testing a Guzzle {@see \GuzzleHttp\Handler\MockHandler}
 * is injected via the ``httpClient`` option — no global monkey-patching.
 */
class HttpExecutor
{
    private ClientInterface $http;
    private float $timeout;
    private string $apiKey;
    private string $baseUrl;
    /** @var array<string,string> */
    private array $defaultHeaders;

    /**
     * @param array<string,string> $defaultHeaders Applied UNDER the auth/JSON headers
     *                                             (which always win), on every request.
     */
    public function __construct(
        string $baseUrl,
        string $apiKey,
        float $timeout = 30.0,
        ?ClientInterface $httpClient = null,
        array $defaultHeaders = []
    ) {
        $this->timeout = $timeout;
        $this->apiKey = $apiKey;
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->defaultHeaders = $defaultHeaders;
        // Auth/JSON headers are applied per-request (in request()). Request URLs
        // are built absolute (baseUrl . path) so a base path prefix (e.g. /v1
        // behind a reverse proxy) is preserved; base_uri is intentionally unset,
        // because an absolute request path would otherwise replace it.
        $this->http = $httpClient ?? new \GuzzleHttp\Client([
            'timeout' => $timeout,
        ]);
    }

    /**
     * Percent-encode a single path segment (e.g. a chat/message id) so a value
     * containing /, # or ? can't break out of its path position. WhatsApp-id
     * characters that are already path-safe (@, :, +) are kept readable.
     */
    public function encodeSegment(string $segment): string
    {
        return str_replace(['%40', '%3A', '%2B'], ['@', ':', '+'], rawurlencode($segment));
    }

    /**
     * Perform one request and return the decoded JSON body (or null for 204).
     *
     * @param string               $method  HTTP method.
     * @param string               $path    Path beginning with /, e.g. /api/sessions.
     * @param array<string,mixed>  $query   Query parameters (null values skipped).
     * @param mixed|null           $body    JSON-serializable request body.
     *
     * @return mixed Decoded JSON, or null for empty/204 responses.
     *
     * @throws OpenWAApiException  On any non-2xx response (typed subclass).
     * @throws OpenWATimeoutException On timeout.
     */
    public function request(string $method, string $path, array $query = [], $body = null)
    {
        // Auth/JSON headers are applied per-request so they are correct whether
        // a default or injected client is used (and never leak Guzzle exceptions:
        // http_errors disabled so we translate status into typed SDK exceptions).
        $options = [
            'http_errors' => false,
            // Never auto-follow redirects: doing so would re-send the X-API-Key
            // header to the redirect target (potentially a different origin).
            'allow_redirects' => false,
            // Caller default headers first; auth/JSON win so they can't be clobbered.
            'headers' => array_merge($this->defaultHeaders, [
                'X-API-Key' => $this->apiKey,
                'Content-Type' => 'application/json',
                'Accept' => 'application/json',
            ]),
        ];
        // Build query string, skipping null values (so absent optionals aren't sent).
        $query = array_filter($query, fn ($v) => $v !== null);
        if ($query !== []) {
            $options['query'] = $query;
        }
        if ($body !== null) {
            $options['json'] = $body;
        }

        try {
            $response = $this->http->request($method, $this->baseUrl . $path, $options);
        } catch (ConnectException $e) {
            // cURL error 28 (CURLE_OPERATION_TIMEDOUT) is the canonical timeout
            // signal, surfaced via the handler context. We check errno first
            // (locale- and version-independent) and fall back to message matching
            // for transports that don't populate the context (e.g. stream handler).
            $errno = $e->getHandlerContext()['errno'] ?? null;
            $isTimeout = $errno === 28 || str_contains($e->getMessage(), 'timed out');
            if ($isTimeout) {
                throw new OpenWATimeoutException($this->timeout);
            }
            throw $e;
        }

        $status = $response->getStatusCode();
        // Treat any non-2xx as an error, including 3xx: redirects are deliberately not followed (so
        // the API key is never re-sent to the target), making an unfollowed 3xx unusable rather than
        // a success. Matches the JS (`!res.ok`) and Python (`>= 300`) transports.
        if ($status >= 300) {
            throw $this->buildApiException($response, $method, $path);
        }

        $text = (string) $response->getBody();
        if ($status === 204 || $text === '') {
            return null;
        }

        $decoded = json_decode($text, true);
        return $decoded === null && json_last_error() !== JSON_ERROR_NONE ? $text : $decoded;
    }

    private function buildApiException(ResponseInterface $response, string $method, string $path): OpenWAApiException
    {
        $status = $response->getStatusCode();
        $text = (string) $response->getBody();
        $data = null;
        if ($text !== '') {
            $decoded = json_decode($text, true);
            $data = ($decoded === null && json_last_error() !== JSON_ERROR_NONE) ? $text : $decoded;
        }

        // NestJS envelope: {statusCode, message, error}. `error` is sometimes absent
        // (e.g. some 500s), so detect on statusCode + message and treat error as optional.
        $envelope = is_array($data) && isset($data['statusCode'], $data['message']) ? $data : null;
        $rawMessage = $envelope['message'] ?? $data;
        if (is_array($rawMessage)) {
            $messageText = implode(', ', array_map('strval', $rawMessage));
        } elseif (is_string($rawMessage)) {
            $messageText = $rawMessage;
        } else {
            $messageText = $rawMessage === null ? $response->getReasonPhrase() : (string) $rawMessage;
        }
        $reason = $response->getReasonPhrase();
        $message = "OpenWA API {$status} {$reason} — {$method} {$path}: {$messageText}";

        return OpenWAApiException::classify($status, $message, $data, $envelope['error'] ?? null);
    }
}
