<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use OpenWA\Exceptions\OpenWAApiException;
use OpenWA\Exceptions\OpenWAAuthException;
use OpenWA\Exceptions\OpenWANotFoundException;
use OpenWA\Exceptions\OpenWARateLimitException;
use OpenWA\Exceptions\OpenWAServiceUnavailableException;
use OpenWA\Exceptions\OpenWATimeoutException;
use PHPUnit\Framework\TestCase;

class ClientTest extends TestCase
{
    public function testRequiresBaseUrlAndApiKey(): void
    {
        $this->expectException(\OpenWA\Exceptions\OpenWAException::class);
        new \OpenWA\Client(['baseUrl' => '', 'apiKey' => 'k']);
    }

    public function testRequiresApiKey(): void
    {
        $this->expectException(\OpenWA\Exceptions\OpenWAException::class);
        new \OpenWA\Client(['baseUrl' => 'https://x', 'apiKey' => '']);
    }

    public function testInsecureHttpBaseUrlLogsInsteadOfRaisingAPhpError(): void
    {
        // Laravel, Symfony and PHPUnit's failOnWarning turn an E_USER_WARNING into an exception, so a
        // raised warning left the client unbuildable for an http:// host on a private network.
        $log = (string) tempnam(sys_get_temp_dir(), 'openwa');
        $previousLog = ini_set('error_log', $log);
        set_error_handler(static function (int $errno, string $errstr): bool {
            throw new \ErrorException($errstr, 0, $errno);
        });
        try {
            new \OpenWA\Client(['baseUrl' => 'http://openwa:2785', 'apiKey' => 'k']);
            $this->assertStringContainsString('insecure http://', (string) file_get_contents($log));

            file_put_contents($log, '');
            new \OpenWA\Client(['baseUrl' => 'http://openwa:2785', 'apiKey' => 'k', 'allowInsecureHttp' => true]);
            $this->assertSame('', file_get_contents($log));
        } finally {
            restore_error_handler();
            ini_set('error_log', (string) $previousLog);
            unlink($log);
        }
    }

    public function testInsecureHttpCheckIgnoresSchemeAndHostCase(): void
    {
        // parse_url returns the scheme and host as written, so a baseUrl in capitals must still warn
        // for a remote host and stay quiet for localhost.
        $log = (string) tempnam(sys_get_temp_dir(), 'openwa');
        $previousLog = ini_set('error_log', $log);
        try {
            new \OpenWA\Client(['baseUrl' => 'HTTP://openwa:2785', 'apiKey' => 'k']);
            $this->assertStringContainsString('insecure http://', (string) file_get_contents($log));

            file_put_contents($log, '');
            new \OpenWA\Client(['baseUrl' => 'http://LOCALHOST:2785', 'apiKey' => 'k']);
            $this->assertSame('', file_get_contents($log));
        } finally {
            ini_set('error_log', (string) $previousLog);
            unlink($log);
        }
    }

    public function testSendsApiKeyHeader(): void
    {
        $backend = (new MockBackend())->on(200, []);
        $client = $backend->makeClient();
        $client->sessions->list();
        $call = $backend->lastCall();
        $this->assertSame('owa_k1_test', $call['headers']['x-api-key'] ?? '');
        $this->assertSame('application/json', $call['headers']['content-type'] ?? '');
    }

    public function testDefaultHeadersApplledUnderAuth(): void
    {
        $backend = (new MockBackend())->on(200, []);
        $client = new \OpenWA\Client([
            'baseUrl' => 'https://x',
            'apiKey' => 'REAL_KEY',
            'httpClient' => $backend->httpClient(),
            'defaultHeaders' => ['X-Trace' => 'keep', 'X-API-Key' => 'EVIL'],
        ]);
        $client->sessions->list();
        $headers = $backend->lastCall()['headers'];
        $this->assertSame('keep', $headers['x-trace'] ?? '');       // custom header forwarded
        $this->assertSame('REAL_KEY', $headers['x-api-key'] ?? '');  // auth still wins
    }

    public function testDefaultHeadersThatDifferOnlyInCaseDoNotReachTheWire(): void
    {
        // PSR-7 folds header names case-insensitively and keeps every value, so a lowercase copy
        // would be sent ahead of ours: "x-api-key: EVIL, REAL_KEY".
        $backend = (new MockBackend())->on(200, []);
        $client = new \OpenWA\Client([
            'baseUrl' => 'https://x',
            'apiKey' => 'REAL_KEY',
            'httpClient' => $backend->httpClient(),
            'defaultHeaders' => ['x-api-key' => 'EVIL', 'content-type' => 'text/plain'],
        ]);
        $client->sessions->list();
        $headers = $backend->lastCall()['headers'];
        $this->assertSame('REAL_KEY', $headers['x-api-key'] ?? '');
        $this->assertSame('application/json', $headers['content-type'] ?? '');
    }

    public function testPathSegmentsAreEncoded(): void
    {
        $backend = (new MockBackend())->on(200, ['id' => 'x']);
        $backend->makeClient()->labels->get('s', 'weird/id#x');
        $this->assertStringContainsString('/labels/weird%2Fid%23x', $backend->lastCall()['path']);

        $backend2 = (new MockBackend())->on(200, ['id' => 'x']);
        $backend2->makeClient()->labels->get('s', 'a@c.us');
        $this->assertStringContainsString('/labels/a@c.us', $backend2->lastCall()['path']); // @ preserved
    }

    public function testEmptyOrDotIdsAreRefusedBeforeSending(): void
    {
        // The HTTP stack resolves dot segments, so such an id would otherwise reach the parent resource.
        $backend = new MockBackend();
        $client = $backend->makeClient();
        $attempts = [
            fn () => $client->webhooks->delete('s1', '..'),
            fn () => $client->contacts->delete('s1', '.'),
            fn () => $client->templates->delete('s1', ''),
        ];
        foreach ($attempts as $attempt) {
            try {
                $attempt();
                $this->fail('expected InvalidArgumentException');
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString('dot path segment', $e->getMessage());
            }
        }
        $this->assertSame([], $backend->calls());

        $backend->on(204);
        $client->webhooks->delete('s1', '628123@c.us');
        $this->assertSame('/api/sessions/s1/webhooks/628123@c.us', $backend->lastCall()['path']);
    }

    public function testRawRequestEscapeHatch(): void
    {
        $backend = (new MockBackend())->on(200, ['ok' => true]);
        $result = $backend->makeClient()->request('GET', '/api/anything', ['a' => 1]);
        $this->assertSame(['ok' => true], $result);
        $this->assertSame('/api/anything', $backend->lastCall()['path']);
        $this->assertStringContainsString('a=1', $backend->lastCall()['query']);
    }

    public function testBaseUrlPathPrefixIsPreserved(): void
    {
        // A base URL with a path prefix (e.g. behind a reverse proxy at /v1) must
        // be kept; absolute request paths must not drop it.
        $backend = (new MockBackend())->on(200, []);
        $backend->makeClient('http://localhost:2785/v1')->sessions->list();
        $this->assertStringContainsString('/v1/api/sessions', $backend->lastCall()['path']);
    }

    public function testTreatsUnfollowedRedirectAsError(): void
    {
        // A redirect must not be followed (which would re-send X-API-Key to the target origin).
        // An unfollowed 3xx is not a usable response, so it surfaces as an API error rather than a
        // fake success — matching the JS and Python transports. Only one request is made.
        $backend = new MockBackend();
        $backend->on(302, ['redirected' => true], ['Location' => 'http://evil.example/x']);
        $backend->on(200, ['followed' => true]); // only reached if a redirect were followed
        $threw = false;
        try {
            $backend->makeClient()->sessions->list();
        } catch (OpenWAApiException $e) {
            $threw = true;
        }
        $this->assertTrue($threw, 'an unfollowed 3xx must surface as an API error');
        $this->assertCount(1, $backend->calls()); // the redirect target was never requested
    }

    public function test204DeleteSucceedsWithNoBody(): void
    {
        $backend = (new MockBackend())->on(204);
        $backend->makeClient()->sessions->delete('x');
        $this->assertSame('DELETE', $backend->lastCall()['method']);
    }

    public function test404MapsToNotFoundException(): void
    {
        $backend = (new MockBackend())->on(404, [
            'statusCode' => 404,
            'message' => 'Session not found',
            'error' => 'Not Found',
        ]);
        $this->expectException(OpenWANotFoundException::class);
        $backend->makeClient()->sessions->get('missing');
    }

    public function test401MapsToAuthException(): void
    {
        $backend = (new MockBackend())->on(401, [
            'statusCode' => 401,
            'message' => 'Unauthorized',
            'error' => 'Unauthorized',
        ]);
        $this->expectException(OpenWAAuthException::class);
        $backend->makeClient()->sessions->list();
    }

    public function testExposesAllResources(): void
    {
        $client = (new MockBackend())->makeClient();
        foreach (['sessions', 'messages', 'contacts', 'groups', 'webhooks', 'chats', 'status', 'health'] as $r) {
            $this->assertTrue(property_exists($client, $r), "Client should expose resource: {$r}");
        }
    }

    public function testErrorCarriesStatusAndBody(): void
    {
        $backend = (new MockBackend())->on(404, [
            'statusCode' => 404,
            'message' => 'Session not found',
            'error' => 'Not Found',
        ]);
        try {
            $backend->makeClient()->sessions->get('x');
            $this->fail('Expected exception');
        } catch (OpenWANotFoundException $e) {
            $this->assertSame(404, $e->getStatus());
            $this->assertSame('Not Found', $e->getErrorKind());
            $this->assertIsArray($e->getBody());
        }
    }

    public function testErrorCarriesCodeRetryAfterAndHeaders(): void
    {
        $fail = function (int $status, $body = null, array $headers = [], ?string $raw = null): OpenWAApiException {
            $backend = new MockBackend();
            $raw === null ? $backend->on($status, $body, $headers) : $backend->onRaw($status, $raw, $headers);
            try {
                $backend->makeClient()->sessions->list();
            } catch (OpenWAApiException $e) {
                return $e;
            }
            $this->fail('Expected exception');
        };

        $throttled = $fail(429, ['statusCode' => 429, 'message' => 'ThrottlerException: Too Many Requests'], [
            'retry-after' => '7',
        ]);
        $this->assertInstanceOf(OpenWARateLimitException::class, $throttled);
        $this->assertSame(7, $throttled->getRetryAfterSeconds());
        $this->assertNull($throttled->getErrorCode());
        $this->assertSame(['7'], $throttled->getHeaders()['retry-after']);
        $this->assertSame(0, $throttled->getCode());

        // Send pacing puts its wait in the body; a header must not shorten it.
        $pacing = [
            'statusCode' => 429,
            'error' => 'Too Many Requests',
            'message' => 'Daily send cap reached',
            'code' => 'SEND_PACING_LIMITED',
            'retryAfterSeconds' => 34521,
        ];
        foreach ([[], ['Retry-After' => '1']] as $headers) {
            $e = $fail(429, $pacing, $headers);
            $this->assertSame('SEND_PACING_LIMITED', $e->getErrorCode());
            $this->assertSame(34521, $e->getRetryAfterSeconds());
        }

        $dated = $fail(503, null, ['Retry-After' => gmdate('D, d M Y H:i:s', time() + 2) . ' GMT'])
            ->getRetryAfterSeconds();
        $this->assertTrue($dated !== null && $dated >= 0 && $dated <= 3, "HTTP-date Retry-After gave {$dated}");
        $this->assertNull($fail(503, null, ['Retry-After' => 'soon'])->getRetryAfterSeconds());

        $logout = $fail(502, ['statusCode' => 502, 'message' => 'x', 'code' => 'SESSION_LOGOUT_INCOMPLETE']);
        $this->assertSame('SESSION_LOGOUT_INCOMPLETE', $logout->getErrorCode());
        $plain = $fail(500, null, ['Content-Type' => 'text/plain'], 'oops');
        $this->assertNull($plain->getErrorCode());
        $this->assertNull($plain->getRetryAfterSeconds());

        // The four-argument constructor still works and has no headers.
        $this->assertSame([], (new OpenWARateLimitException('m', 429))->getHeaders());
    }

    public function testRetryAfterParsesWithoutTheCtypeExtension(): void
    {
        // The SDK does not require ext-ctype, so a build without it must still
        // classify a Retry-After response. Run the check in a child process
        // with the ctype functions disabled.
        $autoload = var_export(dirname(__DIR__) . '/vendor/autoload.php', true);
        $script = "require {$autoload};"
            . "\$e = \\OpenWA\\Exceptions\\OpenWAApiException::classify(429, 'm', null, null, ['Retry-After' => '7']);"
            . "echo get_class(\$e), ' ', var_export(\$e->getRetryAfterSeconds(), true);";
        $ctype = 'ctype_alnum,ctype_alpha,ctype_cntrl,ctype_digit,ctype_graph,'
            . 'ctype_lower,ctype_print,ctype_punct,ctype_space,ctype_upper,ctype_xdigit';
        $command = escapeshellarg(PHP_BINARY) . ' -d ' . escapeshellarg("disable_functions={$ctype}")
            . ' -r ' . escapeshellarg($script) . ' 2>&1';
        exec($command, $output, $exitCode);

        $this->assertSame(0, $exitCode, implode("\n", $output));
        $this->assertSame(OpenWARateLimitException::class . ' 7', implode("\n", $output));
    }

    public function testNonEnvelopeErrorBodyMapsToTypedException(): void
    {
        // The readiness probe answers 503 with {status, details}: no statusCode/message, and a
        // nested array that strval() cannot convert.
        $backend = (new MockBackend())->on(503, [
            'status' => 'error',
            'details' => ['mainDatabase' => ['status' => 'down']],
        ]);
        try {
            $backend->makeClient()->health->ready();
            $this->fail('Expected exception');
        } catch (OpenWAServiceUnavailableException $e) {
            $this->assertSame(503, $e->getStatus());
            $this->assertStringContainsString('{"mainDatabase":{"status":"down"}}', $e->getMessage());
        }
    }

    public function testTimeoutWithErrno28MapsToTimeoutException(): void
    {
        // Regression guard: cURL error 28 (CURLE_OPERATION_TIMEDOUT) must map to
        // OpenWATimeoutException, regardless of the message wording.
        $timeoutRequest = new \GuzzleHttp\Exception\ConnectException(
            'cURL error 28: Operation timed out',
            new \GuzzleHttp\Psr7\Request('GET', '/api/sessions'),
            null,
            ['errno' => 28],
        );
        $mock = new \GuzzleHttp\Handler\MockHandler([$timeoutRequest]);
        $httpClient = new \GuzzleHttp\Client(['handler' => \GuzzleHttp\HandlerStack::create($mock)]);
        $client = new \OpenWA\Client([
            'baseUrl' => 'http://localhost:2785',
            'apiKey' => 'k',
            'httpClient' => $httpClient,
        ]);

        $this->expectException(OpenWATimeoutException::class);
        $client->sessions->list();
    }

    public function testConnectionRefusedDoesNotMapToTimeoutException(): void
    {
        // Regression guard: a non-timeout ConnectException (errno 7) must NOT be
        // misclassified as a timeout — it must propagate as ConnectException.
        $refused = new \GuzzleHttp\Exception\ConnectException(
            'cURL error 7: connection refused',
            new \GuzzleHttp\Psr7\Request('GET', '/api/sessions'),
            null,
            ['errno' => 7],
        );
        $mock = new \GuzzleHttp\Handler\MockHandler([$refused]);
        $httpClient = new \GuzzleHttp\Client(['handler' => \GuzzleHttp\HandlerStack::create($mock)]);
        $client = new \OpenWA\Client([
            'baseUrl' => 'http://localhost:2785',
            'apiKey' => 'k',
            'httpClient' => $httpClient,
        ]);

        $this->expectException(\GuzzleHttp\Exception\ConnectException::class);
        $client->sessions->list();
    }
}
