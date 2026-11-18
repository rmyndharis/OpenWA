<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

/**
 * What re-indexing the list fields of a body leaves alone: a list that already is one, an empty list, a value that
 * is not a list, the maps that are sent as objects, a raw request, and the arrays the caller holds, whether by value
 * or by reference.
 */
class ListFieldsPreservedTest extends TestCase
{
    private function body(callable $call): string
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $call($backend->makeClient());

        return $backend->rawBody(0);
    }

    /**
     * A list held by reference is the caller's own variable: the call must neither re-index it nor change the body
     * array that holds it. The values are not validated by the SDK, so one list stands in for every field.
     *
     * @return array<string,array{0:callable,1:string}>
     */
    public static function referencedLists(): array
    {
        $chat = ['chatId' => 'x@c.us'];
        $list = '["a@c.us","b@c.us"]';
        $condition = ['field' => 'sender', 'operator' => 'is'];

        return [
            'send-text mentions' => [fn ($c, &$l) => $c->messages->sendText('s', $chat + ['text' => 'hi', 'mentions' => &$l]), '"mentions":' . $list],
            'send-template mentions' => [fn ($c, &$l) => $c->messages->sendTemplate('s', $chat + ['templateName' => 't', 'mentions' => &$l]), '"mentions":' . $list],
            'group create participants' => [fn ($c, &$l) => $c->groups->create('s', ['name' => 'g', 'participants' => &$l]), '"participants":' . $list],
            'send-bulk item content mentions' =>[fn ($c, &$l) => $c->messages->sendBulk('s', ['messages' => [$chat + ['type' => 'text', 'content' => ['text' => 'hi', 'mentions' => &$l]]]]), '"mentions":' . $list],
            'vote-poll options' => [fn ($c, &$l) => $c->messages->votePoll('s', $chat + ['pollMessageId' => 'm', 'options' => &$l]), '"options":' . $list],
            'status send-text recipients' => [fn ($c, &$l) => $c->status->sendText('s', ['text' => 'hi', 'recipients' => &$l]), '"recipients":' . $list],
            'mark-read messageIds' => [fn ($c, &$l) => $c->chats->markRead('s', $chat + ['messageIds' => &$l]), '"messageIds":' . $list],
            'redrive ids' => [fn ($c, &$l) => $c->webhooks->redriveDeliveryFailures(['ids' => &$l]), '"ids":' . $list],
            'webhook create events' => [fn ($c, &$l) => $c->webhooks->create('s', ['url' => 'https://h/x', 'events' => &$l]), '"events":' . $list],
            'webhook update filters conditions' => [fn ($c, &$l) => $c->webhooks->update('s', 'w', ['filters' => ['conditions' => &$l]]), '"conditions":' . $list],
            'webhook update filter condition value' => [fn ($c, &$l) => $c->webhooks->update('s', 'w', ['filters' => ['conditions' => [$condition + ['value' => &$l]]]]), '"value":' . $list],
        ];
    }

    /**
     * @dataProvider referencedLists
     */
    public function testAListHeldByReferenceIsNotModified(callable $call, string $expectedFragment): void
    {
        $list = [0 => 'a@c.us', 2 => 'b@c.us'];
        $before = serialize($list);
        $backend = (new MockBackend())->on(200, ['success' => true]);

        $call($backend->makeClient(), $list);

        $this->assertSame($before, serialize($list));
        $this->assertStringContainsString($expectedFragment, $backend->rawBody(0));
    }

    public function testAListWithoutGapsIsUnchanged(): void
    {
        $this->assertStringContainsString('"mentions":["a@c.us","b@c.us"]', $this->body(fn ($c) => $c->messages->sendText('s', ['chatId' => 'x', 'text' => 'hi', 'mentions' => ['a@c.us', 'b@c.us']])));
    }

    public function testAStringKeyedListIsSentAsAJsonArray(): void
    {
        $this->assertStringContainsString('"mentions":["a@c.us","b@c.us"]', $this->body(fn ($c) => $c->messages->sendText('s', ['chatId' => 'x', 'text' => 'hi', 'mentions' => ['first' => 'a@c.us', 'second' => 'b@c.us']])));
    }

    public function testAnEmptyListStaysAnEmptyList(): void
    {
        $this->assertStringContainsString('"mentions":[]', $this->body(fn ($c) => $c->messages->sendText('s', ['chatId' => 'x', 'text' => 'hi', 'mentions' => []])));
        $this->assertStringContainsString('"options":[]', $this->body(fn ($c) => $c->messages->votePoll('s', ['chatId' => 'x', 'pollMessageId' => 'm', 'options' => []])));
    }

    public function testNullAndNonArrayValuesAreLeftAlone(): void
    {
        $this->assertStringContainsString('"mentions":null', $this->body(fn ($c) => $c->messages->sendText('s', ['chatId' => 'x', 'text' => 'hi', 'mentions' => null])));
        $this->assertStringContainsString('"mentions":"a@c.us"', $this->body(fn ($c) => $c->messages->sendText('s', ['chatId' => 'x', 'text' => 'hi', 'mentions' => 'a@c.us'])));
        $this->assertStringNotContainsString('mentions', $this->body(fn ($c) => $c->messages->sendText('s', ['chatId' => 'x', 'text' => 'hi'])));
    }

    public function testAnObjectValueIsLeftAlone(): void
    {
        $this->assertStringContainsString('"mentions":{"0":"a@c.us"}', $this->body(fn ($c) => $c->messages->sendText('s', ['chatId' => 'x', 'text' => 'hi', 'mentions' => (object) ['0' => 'a@c.us']])));
    }

    public function testTheCallersArrayIsNotModified(): void
    {
        $body = ['chatId' => 'x', 'text' => 'hi', 'mentions' => [0 => 'a@c.us', 2 => 'b@c.us']];
        $copy = $body;

        $this->body(fn ($c) => $c->messages->sendText('s', $body));

        $this->assertSame($copy, $body);
    }

    public function testARawRequestIsSentAsGiven(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);

        $backend->makeClient()->request('POST', '/api/anything', [], ['mentions' => [0 => 'a@c.us', 2 => 'b@c.us']]);

        $this->assertSame('{"mentions":{"0":"a@c.us","2":"b@c.us"}}', $backend->rawBody(0));
    }

    public function testTemplateVarsKeyedByNumberStayAnObject(): void
    {
        $wire = $this->body(fn ($c) => $c->messages->sendTemplate('s', ['chatId' => 'x', 'templateName' => 't', 'vars' => [1 => 'a', 2 => 'b'], 'mentions' => [0 => 'a@c.us', 2 => 'b@c.us']]));

        $this->assertStringContainsString('"vars":{"1":"a","2":"b"}', $wire);
        $this->assertStringContainsString('"mentions":["a@c.us","b@c.us"]', $wire);
    }

    public function testBulkBodyKeepsItsOptionsObjectAndReindexesItemMentions(): void
    {
        $wire = $this->body(fn ($c) => $c->messages->sendBulk('s', ['messages' => [3 => ['chatId' => 'x', 'type' => 'text', 'content' => ['text' => 'hi', 'mentions' => [1 => 'a@c.us']]]], 'options' => []]));

        $this->assertStringContainsString('"messages":[{', $wire);
        $this->assertStringContainsString('"mentions":["a@c.us"]', $wire);
        $this->assertStringContainsString('"options":{}', $wire);
    }

    public function testWebhookFiltersKeepTheirShapes(): void
    {
        $wire = $this->body(fn ($c) => $c->webhooks->update('s', 'w', ['filters' => null, 'events' => [2 => 'message.ack']]));
        $this->assertStringContainsString('"filters":null', $wire);
        $this->assertStringContainsString('"events":["message.ack"]', $wire);

        $wire = $this->body(fn ($c) => $c->webhooks->update('s', 'w', ['filters' => ['conditions' => [(object) ['field' => 'type', 'operator' => 'is', 'value' => 'text'], ['field' => 'body', 'operator' => 'contains', 'value' => 'x']]]]));
        $this->assertStringContainsString('"value":"text"', $wire);
        $this->assertStringContainsString('"value":"x"', $wire);

        $wire = $this->body(fn ($c) => $c->webhooks->update('s', 'w', ['filters' => (object) ['conditions' => []]]));
        $this->assertStringContainsString('"filters":{"conditions":[]}', $wire);
    }

    public function testRedriveKeepsAnEmptyBodyAnObject(): void
    {
        $this->assertSame('{}', $this->body(fn ($c) => $c->webhooks->redriveDeliveryFailures()));
    }
}
