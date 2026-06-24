<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

class TemplatesTest extends TestCase
{
    public function testCrudPaths(): void
    {
        $tpl = ['id' => 't1', 'sessionId' => 's', 'name' => 'welcome', 'body' => 'Hi {{name}}'];
        $backend = new MockBackend();
        $backend->on(200, [$tpl]);                         // list
        $backend->on(200, $tpl);                           // get
        $backend->on(201, $tpl);                           // create
        $backend->on(200, ['...' => 1] + $tpl);            // update
        $backend->on(204);                                 // delete
        $client = $backend->makeClient();

        $client->templates->list('s');
        $this->assertSame('/api/sessions/s/templates', $backend->calls()[0]['path']);

        $client->templates->get('s', 't1');
        $this->assertSame('/api/sessions/s/templates/t1', $backend->calls()[1]['path']);

        $client->templates->create('s', ['name' => 'welcome', 'body' => 'Hi {{name}}']);
        $this->assertSame('POST', $backend->calls()[2]['method']);
        $this->assertSame(['name' => 'welcome', 'body' => 'Hi {{name}}'], $backend->calls()[2]['body']);

        $client->templates->update('s', 't1', ['body' => 'Hello {{name}}']);
        $this->assertSame('PUT', $backend->calls()[3]['method']);
        $this->assertSame(['body' => 'Hello {{name}}'], $backend->calls()[3]['body']);

        $client->templates->delete('s', 't1');
        $this->assertSame('DELETE', $backend->lastCall()['method']);
    }
}
