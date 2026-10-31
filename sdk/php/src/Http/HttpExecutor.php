<?php

declare(strict_types=1);

namespace OpenWA\Http;

use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\ConnectTimeoutException;
use GuzzleHttp\Exception\NetworkTimeoutException;
use GuzzleHttp\Exception\RequestException;
use GuzzleHttp\Exception\ResponseException;
use GuzzleHttp\Exception\ResponseTimeoutException;
use GuzzleHttp\Psr7\Request;
use OpenWA\Exceptions\OpenWAApiException;
use OpenWA\Exceptions\OpenWAException;
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
    /**
     * The API keys and default header values of the executors, outside their property tables: print_r,
     * var_dump, var_export, an (array) cast and a framework's dumper all read properties, and both are
     * bearer-equivalent (a header often carries the credential of a proxy in front of the gateway).
     *
     * @var \WeakMap<HttpExecutor,array{apiKey:string,headers:array<string,string|list<string>>}>|null
     */
    private static ?\WeakMap $secrets = null;

    private ClientInterface $http;
    private float $timeout;
    private string $baseUrl;
    /** @var list<string> Only the names: see $secrets for the values. */
    private array $headerNames;

    /**
     * @param array<string,scalar|null|non-empty-array<array-key,scalar|null>> $defaultHeaders Applied UNDER the auth/JSON headers
     *                                             (which always win), on every request.
     */
    public function __construct(
        string $baseUrl,
        #[\SensitiveParameter] string $apiKey,
        float $timeout = 30.0,
        ?ClientInterface $httpClient = null,
        #[\SensitiveParameter] array $defaultHeaders = []
    ) {
        self::checkDefaultHeaders($defaultHeaders);
        $defaultHeaders = array_map(
            static fn ($value) => is_array($value) ? array_map('strval', array_values($value)) : (string) $value,
            $defaultHeaders
        );
        $this->timeout = $timeout;
        self::$secrets ??= new \WeakMap();
        self::$secrets[$this] = ['apiKey' => $apiKey, 'headers' => $defaultHeaders];
        $this->baseUrl = rtrim($baseUrl, '/');
        $this->headerNames = array_map('strval', array_keys($defaultHeaders));
        // Auth/JSON headers are applied per-request (in request()). Request URLs
        // are built absolute (baseUrl . path) so a base path prefix (e.g. /v1
        // behind a reverse proxy) is preserved; base_uri is intentionally unset,
        // because an absolute request path would otherwise replace it.
        $this->http = $httpClient ?? new \GuzzleHttp\Client([
            'timeout' => $timeout,
        ]);
    }

    /**
     * Refuse a default header the HTTP stack would refuse, naming the header and never its value: the
     * stack's own message quotes the value, which would put a proxy credential in the application's log.
     * Public so that the client can run it before it builds an executor, whose constructor frame holds the
     * key and, before PHP 8.2, shows its first characters in a trace.
     *
     * A number, a boolean or null is sent as its text and a non-empty list as several values.
     *
     * @param array<mixed> $headers
     *
     * @throws OpenWAException
     */
    public static function checkDefaultHeaders(#[\SensitiveParameter] array $headers): void
    {
        foreach ($headers as $name => $value) {
            if (!is_string($name) || preg_match('/\A[!#$%&\'*+\-.^_`|~0-9A-Za-z]+\z/', $name) !== 1) {
                throw new OpenWAException(
                    'OpenWA Client: defaultHeaders has a header name that is not a valid HTTP token'
                );
            }
            if ($value === []) {
                throw new OpenWAException(sprintf('OpenWA Client: defaultHeaders value for "%s" must be text or a non-empty list', $name));
            }
            foreach (is_array($value) ? $value : [$value] as $each) {
                if (is_scalar($each) || $each === null) {
                    if (preg_match('/\A[\t\x20-\x7e]*\z/', (string) $each) === 1) {
                        continue;
                    }
                    $reason = 'must be text without control or non-ASCII characters; check for a stray newline';
                } else {
                    $reason = 'must be text';
                }
                throw new OpenWAException(sprintf('OpenWA Client: defaultHeaders value for "%s" %s', $name, $reason));
            }
        }
    }

    /**
     * What print_r and var_dump show of the executor, and so of every client and resource that holds it.
     * The key and the header values are not among the properties at all (see $secrets), so no dump,
     * export or cast can reach them.
     *
     * @return array<string,mixed>
     */
    public function __debugInfo(): array
    {
        return [
            'baseUrl' => $this->baseUrl,
            'timeout' => $this->timeout,
            'apiKey' => '[redacted]',
            'defaultHeaders' => $this->headerNames,
        ];
    }

    /** A copy would have no key, since the key belongs to the object it was given to. */
    private function __clone()
    {
    }

    /**
     * Percent-encode a single path segment (e.g. a chat/message id) so a value
     * containing /, # or ? can't break out of its path position. WhatsApp-id
     * characters that are already path-safe (@, :, +) are kept readable.
     *
     * An empty, "." or ".." segment is refused: the HTTP stack resolves dot
     * segments before sending, so such an id would reach the parent resource
     * instead of the intended one.
     *
     * @throws \InvalidArgumentException For an empty, "." or ".." segment.
     */
    public function encodeSegment(string $segment): string
    {
        if ($segment === '' || $segment === '.' || $segment === '..') {
            throw new \InvalidArgumentException(sprintf('OpenWA: empty or dot path segment "%s"', $segment));
        }
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
     * @param bool                 $allowText Return a 2xx body that is not JSON as its text. Off for the typed
     *                                        resources, whose callers expect an array: they get an exception that
     *                                        names the request, not a TypeError from the return type.
     *
     * @return mixed Decoded JSON, or null for empty/204 responses.
     *
     * @throws OpenWAApiException  On any non-2xx response (typed subclass).
     * @throws OpenWATimeoutException On timeout.
     * @throws OpenWAException On a 2xx body that is not JSON, unless $allowText.
     */
    public function request(
        string $method,
        string $path,
        array $query = [],
        $body = null,
        ?string $idempotencyKey = null,
        bool $allowText = false
    ) {
        $response = $this->send($method, $path, $query, $body, $idempotencyKey);

        $text = (string) $response->getBody();
        if ($response->getStatusCode() === 204 || $text === '') {
            return null;
        }

        $decoded = json_decode($text, true);
        if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
            if (!$allowText) {
                throw new OpenWAException("OpenWA: non-JSON response for {$method} {$path}");
            }
            return $text;
        }
        return $decoded;
    }

    /**
     * Perform one request for a non-JSON (binary) 2xx body — e.g. stored
     * status media — and return it as ['data' => raw bytes, 'contentType' =>
     * ?string]. A 204/empty body yields empty data and a null content type.
     *
     * @param string              $method HTTP method.
     * @param string              $path   Path beginning with /.
     * @param array<string,mixed> $query  Query parameters (null values skipped).
     *
     * @return array{data: string, contentType: ?string}
     *
     * @throws OpenWAApiException  On any non-2xx response (typed subclass).
     * @throws OpenWATimeoutException On timeout.
     */
    public function requestBinary(string $method, string $path, array $query = []): array
    {
        $response = $this->send($method, $path, $query, null);
        if ($response->getStatusCode() === 204) {
            return ['data' => '', 'contentType' => null];
        }
        $contentType = $response->getHeaderLine('Content-Type');
        return ['data' => (string) $response->getBody(), 'contentType' => $contentType === '' ? null : $contentType];
    }

    /**
     * Shared transport for {@see request()} and {@see requestBinary()}:
     * builds options, performs the Guzzle call, and maps a non-2xx (including
     * an unfollowed 3xx) to a typed SDK exception.
     *
     * @param array<string,mixed> $query
     * @param mixed|null          $body
     */
    private function send(string $method, string $path, array $query, $body, ?string $idempotencyKey = null): ResponseInterface
    {
        // Guzzle 7 upper-cased the method itself; Guzzle 8 sends it as written, and the gateway refuses "get".
        $method = strtoupper($method);
        if ($idempotencyKey !== null && preg_match('/\A[\x21-\x7E]{1,255}\z/', $idempotencyKey) !== 1) {
            throw new \InvalidArgumentException('Idempotency-Key must contain 1-255 visible ASCII characters');
        }
        // The path is appended to the base URL, so one without a leading "/" could move the host
        // (".example.net/x", "@example.net/x") and send the API key there.
        if (!str_starts_with($path, '/')) {
            throw new \InvalidArgumentException('OpenWA: path must begin with "/": ' . $path);
        }
        // Auth/JSON headers are applied per-request so they are correct whether
        // a default or injected client is used (and never leak Guzzle exceptions:
        // http_errors disabled so we translate status into typed SDK exceptions).
        $secrets = (self::$secrets ?? new \WeakMap())[$this] ?? ['apiKey' => '', 'headers' => []];
        $options = [
            'http_errors' => false,
            // These APIs consume the whole body, so read failures must occur inside the transport catch.
            'stream' => false,
            // Per-request options override injected Guzzle client defaults, so the SDK's configured
            // timeout is enforced consistently on both default and caller-supplied clients.
            'timeout' => $this->timeout,
            // Never auto-follow redirects: doing so would re-send the X-API-Key
            // header to the redirect target (potentially a different origin).
            'allow_redirects' => false,
            // Caller default headers first; auth/JSON win so they can't be clobbered. Header names are
            // case-insensitive and PSR-7 keeps every value, so a caller's copy in another case is dropped.
            'headers' => array_merge(array_filter(
                $secrets['headers'],
                fn ($name) => !in_array(strtolower((string) $name), ['x-api-key', 'content-type', 'accept'], true)
                    && ($idempotencyKey === null || strtolower((string) $name) !== 'idempotency-key'),
                ARRAY_FILTER_USE_KEY
            ), [
                'X-API-Key' => $secrets['apiKey'],
                'Content-Type' => 'application/json',
                'Accept' => 'application/json',
            ]),
        ];
        // Guzzle 8's stream handler also stops a connection that stays silent for 60 s (read_timeout, 0 disables
        // it), which would cut off a longer timeout or none. Guzzle 7 reads the option differently (0 and
        // fractions end reads at once), so only 8 is told; cURL handlers ignore it.
        if (ClientInterface::MAJOR_VERSION >= 8) {
            $options['read_timeout'] = $this->timeout;
        }
        if ($idempotencyKey !== null) {
            $options['headers']['Idempotency-Key'] = $idempotencyKey;
        }
        // Build query string, skipping null values (so absent optionals aren't sent). Guzzle's
        // 'query' option would replace a query already in a raw path, so extend the URL instead.
        $url = $this->baseUrl . $path;
        $query = array_filter($query, fn ($v) => $v !== null);
        if ($query !== []) {
            $parts = explode('#', $url, 2);
            $url = $parts[0] . (str_contains($parts[0], '?') ? '&' : '?') . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
            if (isset($parts[1])) {
                $url .= '#' . $parts[1];
            }
        }
        if ($body !== null) {
            $options['json'] = $body;
        }

        $started = hrtime(true);
        try {
            $response = $this->http->request($method, $url, $options);
        } catch (ConnectTimeoutException | NetworkTimeoutException | ResponseTimeoutException $e) {
            throw new OpenWATimeoutException($this->timeout);
        } catch (ConnectException $e) {
            // Guzzle 7 exposes cURL errno 28 in the context; custom transports may only supply a message.
            $errno = method_exists($e, 'getHandlerContext') ? ($e->getHandlerContext()['errno'] ?? null) : null;
            $isTimeout = $errno === 28 || str_contains($e->getMessage(), 'timed out');
            if ($isTimeout || $this->failedAfterTimeout($e, $started)) {
                throw new OpenWATimeoutException($this->timeout);
            }
            throw $e;
        } catch (RequestException $e) {
            if ($this->failedAfterTimeout($e, $started)) {
                throw new OpenWATimeoutException($this->timeout);
            }
            throw $e;
        }

        $status = $response->getStatusCode();
        // Treat any non-2xx as an error, including 3xx: redirects are deliberately not followed (so
        // the API key is never re-sent to the target), making an unfollowed 3xx unusable rather than
        // a success.
        if ($status < 200 || $status >= 300) {
            throw $this->buildApiException($response, $method, $path);
        }
        // Guzzle 7's stream handler returns a body cut before its Content-Length as if it were whole, where cURL
        // and Guzzle 8 raise a TransferException, so raise one too. A HEAD or 204 answer carries no body; every
        // handler drops the Content-Length of a body it decoded (gzip), so that one is not compared either.
        $declared = $response->getHeaderLine('Content-Length');
        $size = $response->getBody()->getSize();
        if ($method !== 'HEAD' && $status !== 204 && $size !== null && preg_match('/\A\d+\z/', $declared) === 1
            && $size < (int) $declared) {
            throw new RequestException(
                sprintf('OpenWA: %s %s: the response ended after %d of %s bytes', $method, $path, $size, $declared),
                new Request($method, $url)
            );
        }
        return $response;
    }

    /**
     * Guzzle's stream handler (a host without ext-curl) reports a gateway that stays silent past the timeout
     * as a plain ConnectException (before the headers, Guzzle 7) or a RequestException without a response
     * (before the headers on Guzzle 8, in the middle of the body on Guzzle 7): no errno, no timeout text.
     * Such a failure is a timeout when it took at least the whole timeout. cURL failures carry their own
     * "cURL error" text and are left alone, and a timeout of 0 (no bound) never matches.
     *
     * The start is hrtime(true), an int on 64-bit PHP and a float on 32-bit PHP.
     */
    private function failedAfterTimeout(\Throwable $e, int|float $startedNs): bool
    {
        return $this->timeout > 0
            && (hrtime(true) - $startedNs) / 1e9 >= $this->timeout
            && !str_starts_with($e->getMessage(), 'cURL error')
            && !$e instanceof ResponseException
            && !(method_exists($e, 'hasResponse') && $e->hasResponse());
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
            // A body without the envelope (the readiness 503's {status, details}) can nest arrays,
            // which strval() cannot convert; render those as JSON.
            $messageText = implode(', ', array_map(
                fn ($v) => is_array($v) ? json_encode($v) : (string) $v,
                $rawMessage,
            ));
        } elseif (is_string($rawMessage)) {
            $messageText = $rawMessage;
        } else {
            $messageText = $rawMessage === null ? $response->getReasonPhrase() : (string) $rawMessage;
        }
        $reason = $response->getReasonPhrase();
        $message = "OpenWA API {$status} {$reason} — {$method} {$path}: {$messageText}";

        // An intermediary that rewrites the body may send a non-string `error`; the kind stays unset then.
        $errorKind = is_string($envelope['error'] ?? null) ? $envelope['error'] : null;

        return OpenWAApiException::classify(
            $status,
            $message,
            $data,
            $errorKind,
            $response->getHeaders(),
        );
    }
}
