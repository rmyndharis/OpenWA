<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use OpenWA\Client as OpenWAClient;
use Psr\Http\Message\RequestInterface;

/**
 * A scripted backend for SDK tests.
 *
 * Uses Guzzle's MockHandler + a history middleware to record every request so
 * tests can assert on the exact method, URL, query string, and body — without
 * any real network or global state.
 */
class MockBackend
{
    private MockHandler $mock;
    /** @var array<int,RequestInterface> */
    private array $recorded = [];

    public function __construct()
    {
        $this->mock = new MockHandler();
    }

    /**
     * Queue a response for the next matching call.
     *
     * @param mixed $body JSON-encodable body (omit/null for empty/204).
     */
    public function on(int $status = 200, $body = null, array $headers = []): self
    {
        if ($status === 204 || $body === null) {
            $this->mock->append(new Response($status, $headers, ''));
        } else {
            $headers['Content-Type'] = 'application/json';
            $this->mock->append(new Response($status, $headers, json_encode($body) ?: ''));
        }
        return $this;
    }

    public function httpClient(): GuzzleClient
    {
        // Record at the handler layer (innermost). The handler always sees the
        // fully-prepared request — host merged from base_uri, JSON body
        // serialized, headers applied — unlike history middleware which can run
        // before prepare-body. This is the most reliable capture point.
        $mock = $this->mock;
        $recorded = &$this->recorded;
        $recorder = static function (RequestInterface $request, array $options) use ($mock, &$recorded) {
            $recorded[] = $request;
            return $mock($request, $options);
        };

        return new GuzzleClient(['handler' => HandlerStack::create($recorder)]);
    }

    public function makeClient(string $baseUrl = 'http://localhost:2785', string $apiKey = 'owa_k1_test'): OpenWAClient
    {
        return new OpenWAClient([
            'baseUrl' => $baseUrl,
            'apiKey' => $apiKey,
            'httpClient' => $this->httpClient(),
        ]);
    }

    /** @return array<string,mixed> */
    public function lastCall(): array
    {
        return $this->callAt(count($this->recorded) - 1);
    }

    /**
     * @param int $index Zero-based call index.
     * @return array<string,mixed>
     */
    public function callAt(int $index): array
    {
        if (!isset($this->recorded[$index])) {
            return [];
        }
        $req = $this->recorded[$index];
        $uri = $req->getUri();
        $body = (string) $req->getBody();
        $decoded = null;
        if ($body !== '') {
            $tmp = json_decode($body, true);
            $decoded = ($tmp === null && json_last_error() !== JSON_ERROR_NONE) ? $body : $tmp;
        }
        $headerMap = [];
        foreach ($req->getHeaders() as $k => $vs) {
            $headerMap[strtolower((string) $k)] = $vs[0] ?? '';
        }
        return [
            'method' => $req->getMethod(),
            'url' => (string) $uri,
            'host' => $uri->getHost(),
            'path' => $uri->getPath(),
            'query' => $uri->getQuery(),
            'body' => $decoded,
            'headers' => $headerMap,
        ];
    }

    /** @return array<int,array<string,mixed>> */
    public function calls(): array
    {
        $out = [];
        for ($i = 0, $n = count($this->recorded); $i < $n; $i++) {
            $c = $this->callAt($i);
            $out[] = [
                'method' => $c['method'],
                'url' => $c['url'],
                'path' => $c['path'],
                'query' => $c['query'],
                'body' => $c['body'],
            ];
        }
        return $out;
    }
}
