<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use OpenWA\Exceptions\OpenWAException;
use PHPUnit\Framework\TestCase;

class HttpExecutorTest extends TestCase
{
    /**
     * The path is appended to the base URL, so one without a leading "/" could move the
     * host and carry the API key elsewhere. It is refused before anything is sent.
     */
    public function testPathWithoutLeadingSlashIsRefusedBeforeSending(): void
    {
        $backend = new MockBackend();
        $client = $backend->makeClient();
        foreach (['.evil.example/x', '@evil.example/x', 'api/sessions'] as $path) {
            try {
                $client->request('GET', $path);
                $this->fail("Expected InvalidArgumentException for {$path}");
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString('path must begin with "/"', $e->getMessage());
            }
        }
        $this->assertSame([], $backend->calls());
    }

    public function testPathWithDotSegmentsIsRefusedBeforeSending(): void
    {
        $backend = (new MockBackend())->on(200, ['ok' => true]);
        $client = $backend->makeClient();
        foreach ([
            '/api/sessions/s1/..',
            '/api/sessions/.',
            '/api/sessions/s1/../api-keys',
            '/api/sessions/%2e%2e',
            '/api/sessions/%2E',
        ] as $path) {
            try {
                $client->request('GET', $path);
                $this->fail("Expected InvalidArgumentException for {$path}");
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString('dot path segment', $e->getMessage());
            }
        }
        $this->assertSame([], $backend->calls());
        $client->request('GET', '/api/sessions/s1/labels/a.b?x=/..');
        $this->assertCount(1, $backend->calls());
    }

    /**
     * A client that is dumped while a call is debugged must not write its bearer-equivalent key out.
     */
    public function testTheApiKeyDoesNotAppearWhenTheClientIsDumped(): void
    {
        $key = 'owa_k1_do_not_print';
        $client = (new MockBackend())->makeClient('http://localhost:2785', $key);

        $this->assertStringNotContainsString($key, print_r($client, true));
        ob_start();
        var_dump($client);
        $this->assertStringNotContainsString($key, (string) ob_get_clean());
        // The other ways a value is written out: an export, a cast, and what a framework dumper reads.
        $this->assertStringNotContainsString($key, var_export($client, true));
        $executor = (new \ReflectionObject($client))->getProperty('http')->getValue($client);
        $this->assertStringNotContainsString($key, var_export($executor, true));
        $this->assertStringNotContainsString($key, json_encode((array) $executor, JSON_PARTIAL_OUTPUT_ON_ERROR) ?: '');
        $this->assertStringNotContainsString($key, print_r((array) $executor, true));
        // and the key is still what goes out on the wire
        $backend = (new MockBackend())->on(200, []);
        $backend->makeClient('http://localhost:2785', $key)->request('GET', '/api/anything');
        $this->assertSame($key, $backend->lastCall()['headers']['x-api-key'] ?? null);
    }

    /**
     * A default header often carries the credential of a proxy in front of the gateway: it is held out of
     * the property table with the key, and only its name shows.
     */
    public function testDefaultHeaderValuesDoNotAppearWhenTheClientIsDumpedEither(): void
    {
        $secret = 'PROXYSECRET';
        $backend = (new MockBackend())->on(200, []);
        $client = new \OpenWA\Client([
            'baseUrl' => 'http://localhost:2785',
            'apiKey' => 'owa_k1_test',
            'httpClient' => $backend->httpClient(),
            'defaultHeaders' => ['CF-Access-Client-Secret' => $secret],
        ]);
        $executor = (new \ReflectionObject($client))->getProperty('http')->getValue($client);

        $this->assertStringNotContainsString($secret, print_r($client, true));
        $this->assertStringContainsString('CF-Access-Client-Secret', print_r($client, true));
        $this->assertStringNotContainsString($secret, var_export($client, true));
        $this->assertStringNotContainsString($secret, var_export($executor, true));
        $this->assertStringNotContainsString($secret, print_r((array) $executor, true));
        // and the value is still what goes out on the wire
        $client->request('GET', '/api/anything');
        $this->assertSame($secret, $backend->lastCall()['headers']['cf-access-client-secret'] ?? null);
    }

    /** A copy would have no key and no headers, since both belong to the object they were given to. */
    public function testAnExecutorCannotBeCloned(): void
    {
        $client = (new MockBackend())->makeClient();
        $executor = (new \ReflectionObject($client))->getProperty('http')->getValue($client);

        $this->expectException(\Error::class);
        $copy = clone $executor;
        $this->assertNotSame($executor, $copy);
    }

    public function testQueryParamsExtendAQueryAlreadyInThePath(): void
    {
        $backend = (new MockBackend())->on(200, [])->on(200, []);
        $client = $backend->makeClient();

        $client->request('GET', '/api/anything?a=1', ['b' => 2, 'skip' => null]);
        $this->assertSame('/api/anything', $backend->lastCall()['path']);
        $this->assertSame('a=1&b=2', $backend->lastCall()['query']);

        $client->request('GET', '/api/anything', ['q' => 'a b']);
        $this->assertSame('q=a%20b', $backend->lastCall()['query']);
    }

    /** @dataProvider fragmentQueries */
    public function testRawPathFragmentsDoNotAbsorbQueryParameters(
        string $path,
        array $query,
        string $expectedQuery,
        string $expectedFragment
    ): void {
        $mock = new \GuzzleHttp\Handler\MockHandler([new \GuzzleHttp\Psr7\Response(200, [], '[]')]);
        $client = new \OpenWA\Client([
            'baseUrl' => 'https://fixture.invalid/gateway',
            'apiKey' => 'fixture-key',
            'httpClient' => new \GuzzleHttp\Client(['handler' => \GuzzleHttp\HandlerStack::create($mock)]),
        ]);
        $original = serialize([$path, $query]);

        $client->request('GET', $path, $query);

        $request = $mock->getLastRequest();
        $this->assertNotNull($request);
        $uri = $request->getUri();
        $this->assertSame('fixture.invalid', $uri->getHost());
        $this->assertSame('/gateway/api/sessions', $uri->getPath());
        $this->assertSame($expectedQuery, $uri->getQuery());
        $this->assertSame($expectedFragment, $uri->getFragment());
        $this->assertSame('/gateway/api/sessions' . ($expectedQuery === '' ? '' : '?' . $expectedQuery), $request->getRequestTarget());
        $this->assertSame('fixture-key', $request->getHeaderLine('X-API-Key'));
        $this->assertSame($original, serialize([$path, $query]));
    }

    public static function fragmentQueries(): array
    {
        return [
            'fragment' => ['/api/sessions#tab', ['limit' => 10], 'limit=10', 'tab'],
            'query and fragment' => ['/api/sessions?offset=0#tab', ['limit' => 10], 'offset=0&limit=10', 'tab'],
            'question mark in fragment' => ['/api/sessions#tab?fake=1', ['limit' => 10], 'limit=10', 'tab?fake=1'],
            'query without fragment' => ['/api/sessions?offset=0', ['limit' => 10], 'offset=0&limit=10', ''],
            'plain path' => ['/api/sessions', ['limit' => 10], 'limit=10', ''],
            'no additions' => ['/api/sessions#tab', [], '', 'tab'],
            'null omitted' => ['/api/sessions?offset=0#tab', ['limit' => null], 'offset=0', 'tab'],
            'encoded hashes' => ['/api/sessions?label=a%23b#tab', ['name' => 'x#y'], 'label=a%23b&name=x%23y', 'tab'],
            'empty fragment and zero values' => ['/api/sessions#', ['offset' => 0, 'active' => false, 'unused' => null], 'offset=0&active=false', ''],
        ];
    }

    public function testBooleanQueryParamsSerializeAsTrueAndFalseStrings(): void
    {
        $backend = (new MockBackend())->on(200, []);
        $client = $backend->makeClient();

        $client->request('GET', '/api/sessions/s1/messages', [
            'inlineMedia' => false,
            'includeDeleted' => true,
            'limit' => 0,
            'skip' => null,
        ]);

        $this->assertSame('inlineMedia=false&includeDeleted=true&limit=0', $backend->lastCall()['query']);
    }

    public function testEncodedIdentityHashesStayInThePath(): void
    {
        $mock = new \GuzzleHttp\Handler\MockHandler([new \GuzzleHttp\Psr7\Response(200, [], '{}')]);
        $client = new \OpenWA\Client([
            'baseUrl' => 'https://fixture.invalid/gateway',
            'apiKey' => 'fixture-key',
            'httpClient' => new \GuzzleHttp\Client(['handler' => \GuzzleHttp\HandlerStack::create($mock)]),
        ]);

        $client->contacts->get('session#one', 'contact#two@c.us');

        $request = $mock->getLastRequest();
        $this->assertNotNull($request);
        $this->assertSame('fixture.invalid', $request->getUri()->getHost());
        $this->assertSame('/gateway/api/sessions/session%23one/contacts/contact%23two@c.us', $request->getRequestTarget());
        $this->assertSame('', $request->getUri()->getQuery());
        $this->assertSame('', $request->getUri()->getFragment());
    }

    public function testStrictArrayResourceCallsRejectEmptyAndScalarPayloads(): void
    {
        $responses = [
            new \GuzzleHttp\Psr7\Response(204),
            new \GuzzleHttp\Psr7\Response(200, [], ''),
            new \GuzzleHttp\Psr7\Response(200, [], 'null'),
            new \GuzzleHttp\Psr7\Response(200, [], '"ok"'),
        ];
        foreach ($responses as $response) {
            $mock = new \GuzzleHttp\Handler\MockHandler([$response]);
            $client = new \OpenWA\Client([
                'baseUrl' => 'http://localhost',
                'apiKey' => 'fixture-key',
                'httpClient' => new \GuzzleHttp\Client(['handler' => \GuzzleHttp\HandlerStack::create($mock)]),
            ]);
            try {
                $client->sessions->get('sess-1');
                $this->fail('Expected OpenWAException for non-object 2xx payload');
            } catch (OpenWAException $e) {
                $this->assertStringContainsString('expected JSON object/array response', $e->getMessage());
            }
        }
    }

    public function testNullableArrayRejectsScalarWhileClientRequestAndVoidDeleteStayUnchanged(): void
    {
        $mock = new \GuzzleHttp\Handler\MockHandler([
            new \GuzzleHttp\Psr7\Response(200, [], '42'),
            new \GuzzleHttp\Psr7\Response(200, [], '"raw"'),
            new \GuzzleHttp\Psr7\Response(204),
        ]);
        $client = new \OpenWA\Client([
            'baseUrl' => 'http://localhost',
            'apiKey' => 'fixture-key',
            'httpClient' => new \GuzzleHttp\Client(['handler' => \GuzzleHttp\HandlerStack::create($mock)]),
        ]);

        try {
            $client->webhooks->deliveryFailures();
            $this->fail('Expected OpenWAException for scalar JSON');
        } catch (OpenWAException $e) {
            $this->assertStringContainsString('expected JSON object/array response', $e->getMessage());
        }

        $this->assertSame('raw', $client->request('GET', '/api/raw'));
        $client->sessions->delete('sess-1');
    }

    public function testAuthRejectsScalarPayloadsAndAllowsEmptyOrObject(): void
    {
        $mock = new \GuzzleHttp\Handler\MockHandler([
            new \GuzzleHttp\Psr7\Response(200, [], '"ok"'),
            new \GuzzleHttp\Psr7\Response(204),
            new \GuzzleHttp\Psr7\Response(200, [], '{"valid":true,"role":"admin"}'),
        ]);
        $client = new \OpenWA\Client([
            'baseUrl' => 'http://localhost',
            'apiKey' => 'fixture-key',
            'httpClient' => new \GuzzleHttp\Client(['handler' => \GuzzleHttp\HandlerStack::create($mock)]),
        ]);

        try {
            $client->auth();
            $this->fail('Expected OpenWAException for scalar auth payload');
        } catch (OpenWAException $e) {
            $this->assertStringContainsString('expected JSON object/array response', $e->getMessage());
        }

        $this->assertSame([], $client->auth());
        $this->assertSame(['valid' => true, 'role' => 'admin'], $client->auth());
    }
}
