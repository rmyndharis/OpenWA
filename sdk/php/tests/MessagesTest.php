<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

class MessagesTest extends TestCase
{
    public function testSendTextUsesSendTextPath(): void
    {
        $backend = (new MockBackend())->on(201, ['messageId' => 'm1', 'timestamp' => 1]);
        $client = $backend->makeClient();
        $client->messages->sendText('s1', ['chatId' => 'a@c.us', 'text' => 'hi']);
        $call = $backend->lastCall();
        // Guzzle exposes the relative path at the handler layer; the host is
        // statically configured via base_uri, so we assert on path + body.
        $this->assertSame('/api/sessions/s1/messages/send-text', $call['path']);
        $this->assertSame(['chatId' => 'a@c.us', 'text' => 'hi'], $call['body']);
    }

    public function testListReturnsMessagesPageEnvelope(): void
    {
        // The server responds with a {messages, total} page, not a flat array. Pin the shape so a
        // future change — or a misunderstood "fix" that unwraps it and drops `total` — is caught.
        $backend = (new MockBackend())->on(200, [
            'messages' => [['id' => 'm1', 'body' => 'hi', 'chatId' => 'a@c.us']],
            'total' => 1,
        ]);
        $client = $backend->makeClient();
        $page = $client->messages->list('s1', ['limit' => 10]);
        $this->assertArrayHasKey('messages', $page);
        $this->assertIsArray($page['messages']);
        $this->assertSame('m1', $page['messages'][0]['id']);
        $this->assertSame(1, $page['total']);
        $this->assertStringContainsString('/messages', $backend->lastCall()['path']);
        $this->assertStringContainsString('limit=10', $backend->lastCall()['query']);
    }

    public static function mediaSegments(): array
    {
        return [
            'sendImage'    => ['sendImage',    'send-image'],
            'sendVideo'    => ['sendVideo',    'send-video'],
            'sendAudio'    => ['sendAudio',    'send-audio'],
            'sendDocument' => ['sendDocument', 'send-document'],
            'sendSticker'  => ['sendSticker',  'send-sticker'],
        ];
    }

    /**
     * @dataProvider mediaSegments
     */
    public function testMediaSegmentsUseCorrectPaths(string $method, string $segment): void
    {
        $backend = (new MockBackend())->on(201, ['messageId' => 'm', 'timestamp' => 2]);
        $client = $backend->makeClient();
        $client->messages->$method('s', ['chatId' => 'a@c.us', 'url' => 'u']);
        $this->assertStringContainsString("/messages/{$segment}", $backend->lastCall()['path']);
    }

    public function testReplyForwardReactDelete(): void
    {
        $backend = new MockBackend();
        $backend->on(201, ['messageId' => 'm', 'timestamp' => 1]);
        $backend->on(201, ['messageId' => 'm', 'timestamp' => 1]);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->messages->reply('s', ['chatId' => 'a@c.us', 'quotedMessageId' => 'q', 'text' => 'r']);
        $this->assertStringContainsString('/messages/reply', $backend->calls()[0]['url']);
        $client->messages->forward('s', ['fromChatId' => 'a@c.us', 'toChatId' => 'b@c.us', 'messageId' => 'm']);
        $this->assertStringContainsString('/messages/forward', $backend->calls()[1]['url']);
        $client->messages->react('s', ['chatId' => 'a@c.us', 'messageId' => 'm', 'emoji' => '👍']);
        $this->assertStringContainsString('/messages/react', $backend->calls()[2]['url']);
        $client->messages->delete('s', ['chatId' => 'a@c.us', 'messageId' => 'm']);
        $this->assertStringContainsString('/messages/delete', $backend->calls()[3]['url']);
    }

    public function testHistoryAndReactionsPath(): void
    {
        $backend = new MockBackend();
        $backend->on(200, []);
        $backend->on(200, []);
        $client = $backend->makeClient();
        $client->messages->history('s', 'a@c.us', ['limit' => 5]);
        $this->assertStringContainsString('/messages/a@c.us/history', $backend->calls()[0]['url']);
        $this->assertStringContainsString('limit=5', $backend->calls()[0]['url']);
        $client->messages->reactions('s', 'a@c.us', 'm1');
        $this->assertStringContainsString('/messages/a@c.us/m1/reactions', $backend->calls()[1]['url']);
    }

    public function testSendBulkBatchStatusCancelBatch(): void
    {
        $backend = new MockBackend();
        $backend->on(202, ['batchId' => 'b', 'status' => 'queued', 'totalMessages' => 1, 'estimatedCompletionTime' => 't', 'statusUrl' => '/u']);
        $backend->on(200, ['batchId' => 'b', 'status' => 'done', 'progress' => 100, 'results' => [], 'startedAt' => 's', 'completedAt' => 'c']);
        $backend->on(200, ['batchId' => 'b', 'status' => 'cancelled', 'progress' => 50]);
        $client = $backend->makeClient();
        $client->messages->sendBulk('s', ['messages' => [['chatId' => 'a@c.us', 'type' => 'text', 'content' => ['text' => 'x']]]]);
        $this->assertStringContainsString('/messages/send-bulk', $backend->calls()[0]['url']);
        $status = $client->messages->batchStatus('s', 'b');
        $this->assertSame(100, $status['progress']);
        $this->assertStringContainsString('/messages/batch/b', $backend->calls()[1]['url']);
        $cancelled = $client->messages->cancelBatch('s', 'b');
        $this->assertSame('cancelled', $cancelled['status']);
        $this->assertSame('POST', $backend->calls()[2]['method']);
        $this->assertStringContainsString('/messages/batch/b/cancel', $backend->calls()[2]['url']);
    }
}
