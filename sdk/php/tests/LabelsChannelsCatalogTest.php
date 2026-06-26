<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

class LabelsChannelsCatalogTest extends TestCase
{
    public function testLabels(): void
    {
        $backend = new MockBackend();
        $backend->on(200, [['id' => 'l1', 'name' => 'VIP']]);
        $backend->on(200, ['id' => 'l1', 'name' => 'VIP']);
        $backend->on(200, [['id' => 'l1', 'name' => 'VIP']]);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->labels->list('s');
        $this->assertStringContainsString('/sessions/s/labels', $backend->calls()[0]['path']);
        $client->labels->get('s', 'l1');
        $this->assertStringContainsString('/labels/l1', $backend->calls()[1]['path']);
        $client->labels->forChat('s', 'a@c.us');
        $client->labels->addToChat('s', 'a@c.us', ['labelId' => 'l1']);
        $this->assertSame('POST', $backend->calls()[3]['method']);
        $this->assertSame(['labelId' => 'l1'], $backend->calls()[3]['body']);
        $client->labels->removeFromChat('s', 'a@c.us', 'l1');
        $this->assertSame('DELETE', $backend->calls()[4]['method']);
    }

    public function testChannels(): void
    {
        $backend = new MockBackend();
        $backend->on(200, [['id' => '123@newsletter', 'name' => 'News']]);
        $backend->on(200, ['id' => '123@newsletter', 'name' => 'News']);
        $backend->on(200, []);
        $backend->on(201, ['id' => '123@newsletter', 'name' => 'News']);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->channels->list('s');
        $this->assertStringContainsString('/sessions/s/channels', $backend->calls()[0]['path']);
        $client->channels->get('s', '123@newsletter');
        $client->channels->messages('s', '123@newsletter', ['limit' => 10]);
        $this->assertStringContainsString('limit=10', $backend->calls()[2]['query']);
        $client->channels->subscribe('s', ['inviteCode' => 'ABCxyz']);
        $this->assertSame('POST', $backend->calls()[3]['method']);
        $this->assertSame(['inviteCode' => 'ABCxyz'], $backend->calls()[3]['body']);
        $client->channels->unsubscribe('s', '123@newsletter');
        $this->assertSame('DELETE', $backend->calls()[4]['method']);
    }

    public function testCatalog(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['name' => 'My Shop', 'productsCount' => 5]);
        $backend->on(200, [['id' => 'p1', 'name' => 'Widget']]);
        $backend->on(200, ['id' => 'p1', 'name' => 'Widget']);
        $backend->on(201, ['messageId' => 'm', 'timestamp' => 1]);
        $backend->on(201, ['messageId' => 'm', 'timestamp' => 1]);
        $client = $backend->makeClient();
        $client->catalog->info('s');
        $this->assertStringContainsString('/sessions/s/catalog', $backend->calls()[0]['path']);
        $client->catalog->products('s', ['page' => 1, 'limit' => 20]);
        $this->assertStringContainsString('page=1', $backend->calls()[1]['query']);
        $client->catalog->product('s', 'p1');
        $client->catalog->sendProduct('s', ['chatId' => 'a@c.us', 'productId' => 'p1', 'body' => 'x']);
        $this->assertStringContainsString('/messages/send-product', $backend->calls()[3]['path']);
        $this->assertSame(['chatId' => 'a@c.us', 'productId' => 'p1', 'body' => 'x'], $backend->calls()[3]['body']);
        $client->catalog->sendCatalog('s', ['chatId' => 'a@c.us', 'body' => 'cat']);
        $this->assertStringContainsString('/messages/send-catalog', $backend->calls()[4]['path']);
    }

    public function testClientExposesAll11Resources(): void
    {
        $client = (new MockBackend())->makeClient();
        foreach (['sessions', 'messages', 'contacts', 'groups', 'webhooks', 'chats', 'status', 'health', 'labels', 'channels', 'catalog'] as $r) {
            $this->assertTrue(property_exists($client, $r), "Client should expose resource: {$r}");
        }
    }
}
