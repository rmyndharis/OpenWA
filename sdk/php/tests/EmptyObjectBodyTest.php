<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

/**
 * A request whose fields are all optional is an object on the wire. json_encode() writes an empty PHP
 * array as [], which the gateway refuses with 400 ("Validation failed (object is expected)"), where the
 * same request from the other SDKs is {} and is a no-op update.
 */
class EmptyObjectBodyTest extends TestCase
{
    /** @return array<string,array{0:callable,1:string,2:string}> */
    public static function allOptionalBodies(): array
    {
        return [
            'updateConfig' => [fn ($c) => $c->sessions->updateConfig('s', []), 'PATCH', '/api/sessions/s/config'],
            'updateProxy' => [fn ($c) => $c->sessions->updateProxy('s', []), 'PATCH', '/api/sessions/s/proxy'],
            'webhooks update' => [fn ($c) => $c->webhooks->update('s', 'w', []), 'PUT', '/api/sessions/s/webhooks/w'],
            'templates update' => [
                fn ($c) => $c->templates->update('s', 't', []),
                'PUT',
                '/api/sessions/s/templates/t',
            ],
            'labels upsert' => [fn ($c) => $c->labels->upsert('s', 'l', []), 'PUT', '/api/sessions/s/labels/l'],
            'updateGroupSettings' => [
                fn ($c) => $c->groups->updateGroupSettings('s', 'g@g.us', []),
                'PUT',
                '/api/sessions/s/groups/g@g.us/settings',
            ],
        ];
    }

    /**
     * @dataProvider allOptionalBodies
     */
    public function testAnEmptyBodyIsSentAsAnEmptyJsonObject(callable $call, string $verb, string $path): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();

        $call($client);

        $this->assertSame($verb, $backend->lastCall()['method']);
        $this->assertSame($path, $backend->lastCall()['path']);
        $this->assertSame('{}', $backend->rawBody(0));
    }

    public function testARawRequestWithAnEmptyArrayIsSentAsAnEmptyJsonObject(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);

        $backend->makeClient()->request('PATCH', '/api/sessions/s/config', [], []);

        $this->assertSame('{}', $backend->rawBody(0));
    }

    public function testAnObjectBodyStaysAnObject(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);

        $backend->makeClient()->request('PATCH', '/api/sessions/s/config', [], new \stdClass());

        $this->assertSame('{}', $backend->rawBody(0));
    }

    public function testNoBodyIsSentWhenThereIsNone(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true])->on(200, ['success' => true]);
        $client = $backend->makeClient();

        $client->request('PATCH', '/api/sessions/s/config', [], null);
        $client->request('GET', '/api/sessions/s/config');

        $this->assertSame('', $backend->rawBody(0));
        $this->assertSame('', $backend->rawBody(1));
    }

    public function testABodyWithContentIsSentUnchanged(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true])->on(200, ['success' => true])->on(200, ['success' => true]);
        $client = $backend->makeClient();

        $client->sessions->updateConfig('s', ['autoRejectCalls' => true, 'maxReconnectAttempts' => null]);
        $client->sessions->updateProxy('s', ['proxyUrl' => null]);
        // Only a top-level empty body becomes an object: a list inside it keeps its meaning.
        $client->request('POST', '/api/webhooks/delivery-failures/redrive', [], ['ids' => []]);

        $this->assertSame('{"autoRejectCalls":true,"maxReconnectAttempts":null}', $backend->rawBody(0));
        $this->assertSame('{"proxyUrl":null}', $backend->rawBody(1));
        $this->assertSame('{"ids":[]}', $backend->rawBody(2));
    }
}
