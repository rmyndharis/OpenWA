<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Exception\TransferException;
use GuzzleHttp\Handler\CurlHandler;
use GuzzleHttp\Handler\StreamHandler;
use GuzzleHttp\HandlerStack;
use OpenWA\Client;
use PHPUnit\Framework\TestCase;

/**
 * The gateway streams stored media and cuts the connection when a read fails after the first byte, so a
 * body shorter than its Content-Length is a failed download. It must never come back as the file,
 * whichever handler Guzzle runs: the stream handler is the one Guzzle uses on a host without ext-curl.
 * A whole body, a HEAD or 204 answer that declares a length, and a compressed body Guzzle decoded are
 * not failures.
 */
class TruncatedMediaBodyTest extends TestCase
{
    private const CUT = "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 100\r\nConnection: close\r\n\r\n";

    /** @var resource|null */
    private $server = null;

    private ?string $script = null;

    protected function tearDown(): void
    {
        if (is_resource($this->server)) {
            proc_terminate($this->server);
            proc_close($this->server);
        }
        if ($this->script !== null) {
            @unlink($this->script);
        }
    }

    /** Start a one-shot server that writes $response as given and closes; returns host:port. */
    private function serve(string $response): string
    {
        $source = <<<'SERVER'
        <?php
        $socket = stream_socket_server('tcp://127.0.0.1:0');
        fwrite(STDOUT, stream_socket_get_name($socket, false) . "\n");
        fflush(STDOUT);
        $conn = stream_socket_accept($socket, 20);
        while (($line = fgets($conn)) !== false && $line !== "\r\n") {
        }
        fwrite($conn, base64_decode($argv[1]));
        fclose($conn);
        SERVER;
        $this->script = (string) tempnam(sys_get_temp_dir(), 'owa-cut');
        file_put_contents($this->script, $source);
        $this->server = proc_open([PHP_BINARY, $this->script, base64_encode($response)], [1 => ['pipe', 'w']], $pipes);
        $this->assertIsResource($this->server);
        $address = trim((string) fgets($pipes[1]));
        $this->assertMatchesRegularExpression('/^127\.0\.0\.1:\d+$/', $address);

        return $address;
    }

    private function clientFor(string $handler, string $response): Client
    {
        if ($handler === 'curl' && !extension_loaded('curl')) {
            $this->markTestSkipped('ext-curl is not loaded');
        }

        return new Client([
            'baseUrl' => 'http://' . $this->serve($response),
            'apiKey' => 'k',
            'timeout' => 5.0,
            'httpClient' => new GuzzleClient([
                'handler' => HandlerStack::create($handler === 'curl' ? new CurlHandler() : new StreamHandler()),
            ]),
        ]);
    }

    /** @return array<string,array{0:string}> */
    public static function handlers(): array
    {
        return ['stream handler' => ['stream'], 'cURL handler' => ['curl']];
    }

    /** @return array<string,array{0:string,1:callable(Client):array{data:string,contentType:?string}}> */
    public static function downloads(): array
    {
        $calls = [
            'messages->media' => static fn (Client $c): array => $c->messages->media('s', 'c@c.us', 'm'),
            'status->media' => static fn (Client $c): array => $c->status->media('s', 'st1'),
        ];
        $cases = [];
        foreach (self::handlers() as $handlerName => [$handler]) {
            foreach ($calls as $callName => $call) {
                $cases["{$callName} on the {$handlerName}"] = [$handler, $call];
            }
        }

        return $cases;
    }

    /**
     * @dataProvider downloads
     *
     * @param callable(Client):array{data:string,contentType:?string} $download
     */
    public function testABodyCutBeforeItsContentLengthIsNotReturnedAsTheFile(string $handler, callable $download): void
    {
        $client = $this->clientFor($handler, self::CUT . str_repeat('A', 10));

        try {
            $result = $download($client);
        } catch (TransferException $e) {
            $this->assertStringNotContainsString('AAAAAAAAAA', $e->getMessage());

            return;
        }

        $this->fail(sprintf('a body cut at %d of 100 bytes was returned as the file', strlen($result['data'])));
    }

    /** @dataProvider handlers */
    public function testAJsonBodyCutBeforeItsContentLengthIsNotReturned(string $handler): void
    {
        $client = $this->clientFor($handler, str_replace('image/jpeg', 'application/json', self::CUT) . '{"ok":true}');

        $this->expectException(TransferException::class);
        $client->request('GET', '/api/anything');
    }

    /** @dataProvider handlers */
    public function testABodyOfItsContentLengthIsReturned(string $handler): void
    {
        $client = $this->clientFor($handler, self::CUT . str_repeat('A', 100));

        $this->assertSame(str_repeat('A', 100), $client->messages->media('s', 'c@c.us', 'm')['data']);
    }

    /** @dataProvider handlers */
    public function testAHeadAnswerThatDeclaresALengthIsNotACutBody(string $handler): void
    {
        $client = $this->clientFor($handler, str_replace('image/jpeg', 'application/json', self::CUT));

        $this->assertNull($client->request('HEAD', '/api/health'));
    }

    /** @dataProvider handlers */
    public function testANoContentAnswerThatDeclaresALengthIsNotACutBody(string $handler): void
    {
        $client = $this->clientFor($handler, "HTTP/1.1 204 No Content\r\nContent-Length: 100\r\nConnection: close\r\n\r\n");

        $this->assertNull($client->request('POST', '/api/anything'));
    }

    /** @dataProvider handlers */
    public function testADecodedCompressedBodyIsNotComparedWithTheEncodedLength(string $handler): void
    {
        $gzip = (string) gzencode(str_repeat('B', 5000));
        $client = $this->clientFor(
            $handler,
            "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Encoding: gzip\r\nContent-Length: " . strlen($gzip)
                . "\r\nConnection: close\r\n\r\n" . $gzip
        );

        $this->assertSame(str_repeat('B', 5000), $client->status->media('s', 'st1')['data']);
    }
}
