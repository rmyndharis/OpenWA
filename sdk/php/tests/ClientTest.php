<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use OpenWA\Exceptions\OpenWAAuthException;
use OpenWA\Exceptions\OpenWANotFoundException;
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
        new \OpenWA\Client(['baseUrl' => 'http://x', 'apiKey' => '']);
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

    public function testBaseUrlPathPrefixIsPreserved(): void
    {
        // A base URL with a path prefix (e.g. behind a reverse proxy at /v1) must
        // be kept; absolute request paths must not drop it.
        $backend = (new MockBackend())->on(200, []);
        $backend->makeClient('http://localhost:2785/v1')->sessions->list();
        $this->assertStringContainsString('/v1/api/sessions', $backend->lastCall()['path']);
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
