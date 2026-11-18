<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

/**
 * json_encode() writes a PHP array whose keys have gaps (what array_filter() and array_unique() leave) as a
 * JSON object, and the gateway answers 400 ("must be an array") to an object where it takes a list. A list
 * the caller builds into a body must therefore reach the wire as a JSON array on every route that takes one,
 * as the participant lists and the bulk messages list already do.
 */
class GappedListBodyTest extends TestCase
{
    /** @return array<string,array{0:callable,1:string}> */
    public static function listFields(): array
    {
        $gap = static fn (array $items): array => array_filter($items, static fn ($v) => $v !== null);
        $list = $gap(['a@c.us', null, 'b@c.us']);
        $mentions = '"mentions":["a@c.us","b@c.us"]';
        $recipients = '"recipients":["a@c.us","b@c.us"]';
        $events = array_unique(['message.received', 'message.received', 'message.ack']);
        $eventsWire = '"events":["message.received","message.ack"]';
        $conditions = $gap([['field' => 'sender', 'operator' => 'is', 'value' => ['a@c.us']], null, ['field' => 'body', 'operator' => 'contains', 'value' => 'x']]);
        $conditionsWire = '"conditions":[{"field":"sender","operator":"is","value":["a@c.us"]},{"field":"body","operator":"contains","value":"x"}]';
        $valueFilter = ['conditions' => [['field' => 'sender', 'operator' => 'is', 'value' => $list]]];
        $valueWire = '"value":["a@c.us","b@c.us"]';
        $chat = ['chatId' => 'x@c.us'];

        return [
            'send-text mentions' => [fn ($c) => $c->messages->sendText('s', $chat + ['text' => 'hi', 'mentions' => $list]), $mentions],
            'send-template mentions' => [fn ($c) => $c->messages->sendTemplate('s', $chat + ['templateName' => 't', 'mentions' => $list]), $mentions],
            'send-image mentions' => [fn ($c) => $c->messages->sendImage('s', $chat + ['url' => 'https://h/i.png', 'mentions' => $list]), $mentions],
            'send-video mentions' => [fn ($c) => $c->messages->sendVideo('s', $chat + ['url' => 'https://h/v.mp4', 'mentions' => $list]), $mentions],
            'send-audio mentions' => [fn ($c) => $c->messages->sendAudio('s', $chat + ['url' => 'https://h/a.ogg', 'mentions' => $list]), $mentions],
            'send-document mentions' => [fn ($c) => $c->messages->sendDocument('s', $chat + ['url' => 'https://h/d.pdf', 'mentions' => $list]), $mentions],
            'send-sticker mentions' => [fn ($c) => $c->messages->sendSticker('s', $chat + ['url' => 'https://h/s.webp', 'mentions' => $list]), $mentions],
            'reply mentions' => [fn ($c) => $c->messages->reply('s', $chat + ['quotedMessageId' => 'm', 'text' => 'hi', 'mentions' => $list]), $mentions],
            'edit mentions' => [fn ($c) => $c->messages->editMessage('s', $chat + ['messageId' => 'm', 'body' => 'hi', 'mentions' => $list]), $mentions],
            'send-bulk item content mentions' => [fn ($c) => $c->messages->sendBulk('s', ['messages' => [['chatId' => 'x@c.us', 'type' => 'text', 'content' => ['text' => 'hi', 'mentions' => $list]]]]), $mentions],
            'send-poll options' => [fn ($c) => $c->messages->sendPoll('s', $chat + ['name' => 'q', 'options' => $gap(['one', null, 'two'])]), '"options":["one","two"]'],
            'vote-poll options' => [fn ($c) => $c->messages->votePoll('s', $chat + ['pollMessageId' => 'm', 'options' => $gap(['one', null, 'two'])]), '"options":["one","two"]'],
            'status send-text recipients' => [fn ($c) => $c->status->sendText('s', ['text' => 'hi', 'recipients' => $list]), $recipients],
            'status send-image recipients' => [fn ($c) => $c->status->sendImage('s', ['image' => ['url' => 'https://h/i.png'], 'recipients' => $list]), $recipients],
            'status send-video recipients' => [fn ($c) => $c->status->sendVideo('s', ['video' => ['url' => 'https://h/v.mp4'], 'recipients' => $list]), $recipients],
            'status send-voice recipients' => [fn ($c) => $c->status->sendVoice('s', ['audio' => ['url' => 'https://h/a.ogg'], 'recipients' => $list]), $recipients],
            'webhook create events' => [fn ($c) => $c->webhooks->create('s', ['url' => 'https://h/x', 'events' => $events]), $eventsWire],
            'webhook update events' => [fn ($c) => $c->webhooks->update('s', 'w', ['events' => $events]), $eventsWire],
            'webhook create filters conditions' => [fn ($c) => $c->webhooks->create('s', ['url' => 'https://h/x', 'events' => ['message.received'], 'filters' => ['conditions' => $conditions]]), $conditionsWire],
            'webhook update filters conditions' => [fn ($c) => $c->webhooks->update('s', 'w', ['filters' => ['conditions' => $conditions]]), $conditionsWire],
            'webhook create filter condition value' => [fn ($c) => $c->webhooks->create('s', ['url' => 'https://h/x', 'events' => ['message.received'], 'filters' => $valueFilter]), $valueWire],
            'webhook update filter condition value' => [fn ($c) => $c->webhooks->update('s', 'w', ['filters' => $valueFilter]), $valueWire],
            'redrive ids' => [fn ($c) => $c->webhooks->redriveDeliveryFailures(['ids' => $gap(['f1', null, 'f2'])]), '"ids":["f1","f2"]'],
            'mark-read messageIds' => [fn ($c) => $c->chats->markRead('s', $chat + ['messageIds' => $gap(['m1', null, 'm2'])]), '"messageIds":["m1","m2"]'],
        ];
    }

    /**
     * @dataProvider listFields
     */
    public function testAListWithKeyGapsIsSentAsAJsonArray(callable $call, string $expectedFragment): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);

        $call($backend->makeClient());

        $this->assertStringContainsString($expectedFragment, $backend->rawBody(0));
    }
}
