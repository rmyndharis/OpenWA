<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

class SearchTest extends TestCase
{
    public function testSearchSendsGetWithQueryParams(): void
    {
        $hit = [
            'messageId' => 'm1',
            'waMessageId' => 'wam1',
            'sessionId' => 's1',
            'chatId' => '628123456789@c.us',
            'body' => 'hello world',
            'snippet' => '<mark>hello</mark> world',
            'timestamp' => 1717900000,
            'type' => 'chat',
            'direction' => 'incoming',
            'from' => '628123456789@c.us',
            'score' => 1.5,
        ];
        $backend = (new MockBackend())->on(200, [
            'hits' => [$hit],
            'total' => 1,
            'tookMs' => 3,
            'provider' => 'builtin-fts',
        ]);
        $client = $backend->makeClient();

        $result = $client->search->search([
            'q' => 'hello',
            'sessionId' => 's1',
            'limit' => 10,
            'offset' => 0,
            'direction' => 'incoming',
        ]);

        $call = $backend->lastCall();
        $this->assertSame('GET', $call['method']);
        $this->assertSame('/api/search', $call['path']);
        $this->assertStringContainsString('q=hello', $call['query']);
        $this->assertStringContainsString('sessionId=s1', $call['query']);
        $this->assertStringContainsString('limit=10', $call['query']);
        $this->assertStringContainsString('offset=0', $call['query']);
        $this->assertStringContainsString('direction=incoming', $call['query']);

        $this->assertSame('builtin-fts', $result['provider']);
        $this->assertSame(1, $result['total']);
        $this->assertSame(3, $result['tookMs']);
        $this->assertCount(1, $result['hits']);
        $this->assertSame($hit, $result['hits'][0]);
    }

    public function testSearchDropsNullOptionalsFromQueryString(): void
    {
        $backend = (new MockBackend())->on(200, [
            'hits' => [],
            'total' => 0,
            'tookMs' => 0,
            'provider' => 'builtin-fts',
        ]);
        $client = $backend->makeClient();

        $client->search->search([
            'q' => 'term',
            'chatId' => null,
            'type' => 'chat',
            'dateFrom' => null,
        ]);

        $query = $backend->lastCall()['query'];
        // `q` and a present `type` are sent; null `chatId`/`dateFrom` are omitted.
        $this->assertStringContainsString('q=term', $query);
        $this->assertStringContainsString('type=chat', $query);
        $this->assertStringNotContainsString('chatId=', $query);
        $this->assertStringNotContainsString('dateFrom=', $query);
    }

    public function testSearchSendsDateAndNumericFilters(): void
    {
        $backend = (new MockBackend())->on(200, [
            'hits' => [],
            'total' => 0,
            'tookMs' => 1,
            'provider' => 'builtin-fts',
        ]);
        $client = $backend->makeClient();

        $client->search->search([
            'q' => 'invoice',
            'dateFrom' => 1717200000000,
            'dateTo' => 1717900000000,
            'limit' => 50,
            'offset' => 100,
        ]);

        $query = $backend->lastCall()['query'];
        $this->assertStringContainsString('dateFrom=1717200000000', $query);
        $this->assertStringContainsString('dateTo=1717900000000', $query);
        $this->assertStringContainsString('limit=50', $query);
        $this->assertStringContainsString('offset=100', $query);
    }

    public function testSearchReturnsEmptyArrayOnNullBody(): void
    {
        // A 204 or empty body resolves to null at the transport; search() falls back to [].
        $backend = (new MockBackend())->on(204);
        $client = $backend->makeClient();

        $result = $client->search->search(['q' => 'anything']);

        $this->assertSame([], $result);
    }
}
