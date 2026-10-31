<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use OpenWA\Client;
use OpenWA\Exceptions\OpenWANotFoundException;
use PHPUnit\Framework\TestCase;

class ResourcesTest extends TestCase
{
    // ── Sessions ──────────────────────────────────────────────────────

    public function testSessionLifecyclePaths(): void
    {
        $backend = new MockBackend();
        // Queue responses in CALL order: list, get, create, start, stop, logout, forceKill, delete.
        $backend->on(200, []);
        $backend->on(200, ['id' => 's1', 'name' => 'n', 'status' => 'ready']);
        $backend->on(201, ['id' => 's1', 'name' => 'n', 'status' => 'created']);
        $backend->on(200, ['id' => 's1', 'status' => 'initializing']);
        $backend->on(200, ['id' => 's1', 'status' => 'disconnected']);
        $backend->on(200, ['id' => 's1', 'status' => 'disconnected']);
        $backend->on(200, ['id' => 's1', 'status' => 'disconnected']);
        $backend->on(204);
        $client = $backend->makeClient();
        $client->sessions->list();
        $this->assertSame('/api/sessions', $backend->calls()[0]['path']);
        $client->sessions->get('s1');
        $this->assertRequest($backend, 'GET', '/api/sessions/s1');
        $client->sessions->create(['name' => 'n']);
        $this->assertSame(['name' => 'n'], $backend->lastCall()['body']);
        $client->sessions->start('s1');
        $this->assertStringContainsString('/sessions/s1/start', $backend->lastCall()['path']);
        $client->sessions->stop('s1');
        $this->assertRequest($backend, 'POST', '/api/sessions/s1/stop');
        $client->sessions->logout('s1');
        $this->assertStringContainsString('/sessions/s1/logout', $backend->lastCall()['path']);
        $client->sessions->forceKill('s1');
        $this->assertStringContainsString('/sessions/s1/force-kill', $backend->lastCall()['path']);
        $client->sessions->delete('s1');
        $this->assertSame('DELETE', $backend->lastCall()['method']);
    }

    public function testSessionListSendsName(): void
    {
        $backend = new MockBackend();
        $backend->on(200, []);
        $client = $backend->makeClient();
        $client->sessions->list(['name' => 'my-bot']);
        $this->assertStringContainsString('name=my-bot', $backend->lastCall()['url']);
    }

    public function testQrPairingStats(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['qrCode' => 'data:image/png;base64,xxx', 'status' => 'qr_ready']);
        $backend->on(200, ['pairingCode' => 'ABCD1234', 'status' => 'qr_ready']);
        $backend->on(200, ['total' => 1, 'active' => 1, 'ready' => 1, 'disconnected' => 0, 'byStatus' => ['ready' => 1]]);
        $client = $backend->makeClient();
        $client->sessions->getQrCode('s1');
        $this->assertStringContainsString('/sessions/s1/qr', $backend->calls()[0]['url']);
        $client->sessions->requestPairingCode('s1', ['phoneNumber' => '628123456789']);
        $this->assertSame(['phoneNumber' => '628123456789'], $backend->lastCall()['body']);
        $client->sessions->stats();
        $this->assertStringContainsString('/sessions/stats/overview', $backend->lastCall()['url']);
    }

    public function testSetOnlinePresence(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->sessions->setOnlinePresence('s1', ['available' => false]);
        // The account's own presence: no chat id in the path and no /subscribe suffix.
        $this->assertSame('PUT', $backend->lastCall()['method']);
        $this->assertStringEndsWith('/sessions/s1/presence', $backend->lastCall()['url']);
        $this->assertSame(['available' => false], $backend->lastCall()['body']);
    }

    // ── Groups ────────────────────────────────────────────────────────

    public function testGroupListGetCreate(): void
    {
        $backend = new MockBackend();
        $backend->on(200, []);
        $backend->on(200, ['id' => 'g1@g.us', 'subject' => 'G', 'participants' => []]);
        $backend->on(201, ['id' => 'g1@g.us', 'subject' => 'G', 'participants' => []]);
        $client = $backend->makeClient();
        $client->groups->list('s');
        $this->assertRequest($backend, 'GET', '/api/sessions/s/groups');
        $client->groups->get('s', 'g1@g.us');
        $this->assertStringContainsString('/groups/g1@g.us', $backend->calls()[1]['url']);
        $client->groups->create('s', ['name' => 'G', 'participants' => ['a@c.us']]);
        $this->assertSame(['name' => 'G', 'participants' => ['a@c.us']], $backend->lastCall()['body']);
    }

    public function testGroupParticipantOps(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->groups->addParticipants('s', 'g', ['a@c.us', 'b@c.us']);
        $this->assertSame(['participants' => ['a@c.us', 'b@c.us']], $backend->calls()[0]['body']);
        $this->assertSame('POST', $backend->calls()[0]['method']);
        $client->groups->removeParticipants('s', 'g', ['a@c.us']);
        $this->assertSame('DELETE', $backend->calls()[1]['method']);
        $client->groups->promoteParticipants('s', 'g', ['a@c.us']);
        $this->assertStringContainsString('/promote', $backend->calls()[2]['url']);
        $client->groups->demoteParticipants('s', 'g', ['a@c.us']);
        $this->assertStringContainsString('/demote', $backend->calls()[3]['url']);
    }

    public function testGroupSubjectDescriptionInvite(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['inviteCode' => 'c', 'inviteLink' => 'l']);
        $backend->on(200, ['inviteCode' => 'c2', 'inviteLink' => 'l2']);
        $client = $backend->makeClient();
        $client->groups->setSubject('s', 'g', 'New');
        $this->assertSame(['subject' => 'New'], $backend->calls()[0]['body']);
        $this->assertSame('PUT', $backend->calls()[0]['method']);
        $client->groups->setDescription('s', 'g', 'desc');
        $this->assertSame(['description' => 'desc'], $backend->calls()[1]['body']);
        $client->groups->leave('s', 'g');
        $this->assertRequest($backend, 'POST', '/api/sessions/s/groups/g/leave');
        $client->groups->inviteCode('s', 'g');
        $this->assertRequest($backend, 'GET', '/api/sessions/s/groups/g/invite-code');
        $client->groups->revokeInviteCode('s', 'g');
        $this->assertStringContainsString('/revoke', $backend->calls()[4]['url']);
    }

    public function testGroupSetMemberLabel(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->groups->setMemberLabel('s', 'g@g.us', 'Site A');
        $this->assertRequest($backend, 'PUT', '/api/sessions/s/groups/g@g.us/member-label');
        $this->assertSame(['label' => 'Site A'], $backend->lastCall()['body']);
    }

    public function testGroupJoinAndSettings(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true, 'groupId' => 'g1@g.us']);
        $backend->on(200, ['announce' => true, 'locked' => false]);
        $backend->on(200, ['success' => true, 'message' => 'Group settings updated']);
        $client = $backend->makeClient();
        $joined = $client->groups->joinGroup('s', 'AbCdEf123');
        $this->assertSame('POST', $backend->calls()[0]['method']);
        $this->assertSame('/api/sessions/s/groups/join', $backend->calls()[0]['path']);
        $this->assertSame(['inviteCode' => 'AbCdEf123'], $backend->calls()[0]['body']);
        $this->assertSame('g1@g.us', $joined['groupId']);
        $settings = $client->groups->getGroupSettings('s', 'g1@g.us');
        $this->assertSame('/api/sessions/s/groups/g1@g.us/settings', $backend->calls()[1]['path']);
        $this->assertTrue($settings['announce']);
        $client->groups->updateGroupSettings('s', 'g1@g.us', ['announce' => true, 'ephemeralSeconds' => 604800]);
        $this->assertSame('PUT', $backend->calls()[2]['method']);
        $this->assertSame(['announce' => true, 'ephemeralSeconds' => 604800], $backend->calls()[2]['body']);
    }

    // ── Contacts ──────────────────────────────────────────────────────

    public function testContactPaths(): void
    {
        $backend = new MockBackend();
        $backend->on(200, []);
        $backend->on(200, ['id' => 'a@c.us']);
        $backend->on(200, ['number' => '628123', 'exists' => true, 'whatsappId' => '628123@c.us']);
        $backend->on(200, ['url' => 'http://p']);
        $backend->on(200, ['contactId' => 'x@lid', 'phone' => '628123']);
        $client = $backend->makeClient();
        $client->contacts->list('s', ['limit' => 10]);
        $this->assertStringContainsString('limit=10', $backend->calls()[0]['url']);
        $client->contacts->get('s', 'a@c.us');
        $this->assertRequest($backend, 'GET', '/api/sessions/s/contacts/a@c.us');
        $client->contacts->check('s', '628123');
        $this->assertStringContainsString('/check/628123', $backend->calls()[2]['url']);
        $client->contacts->profilePicture('s', 'a@c.us');
        $this->assertRequest($backend, 'GET', '/api/sessions/s/contacts/a@c.us/profile-picture');
        $client->contacts->phone('s', 'x@lid');
        $this->assertRequest($backend, 'GET', '/api/sessions/s/contacts/x@lid/phone');
    }

    public function testBlockUnblock(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->contacts->block('s', 'a@c.us');
        $this->assertSame('POST', $backend->calls()[0]['method']);
        $client->contacts->unblock('s', 'a@c.us');
        $this->assertSame('DELETE', $backend->calls()[1]['method']);
    }

    public function testListBlockedGetsSessionWideRoute(): void
    {
        $backend = (new MockBackend())->on(200, ['a@c.us', 'b@c.us']);
        $client = $backend->makeClient();
        $res = $client->contacts->listBlocked('s');
        $call = $backend->lastCall();
        $this->assertSame('GET', $call['method']);
        // Session-wide: no contact id in the path, and not the /contacts list route.
        $this->assertSame('/api/sessions/s/contacts/blocked', $call['path']);
        $this->assertNull($call['body']);
        $this->assertSame(['a@c.us', 'b@c.us'], $res);
    }

    public function testProfilePicturesBatchResolvesIdsQuery(): void
    {
        $backend = (new MockBackend())->on(200, ['pictures' => ['a@c.us' => 'http://p/a', 'b@c.us' => null]]);
        $client = $backend->makeClient();
        $res = $client->contacts->profilePictures('s', ['a@c.us', 'b@c.us']);
        $call = $backend->lastCall();
        $this->assertSame('GET', $call['method']);
        $this->assertSame('/api/sessions/s/contacts/profile-pictures', $call['path']);
        $this->assertSame('ids=a%40c.us%2Cb%40c.us', $call['query']);
        $this->assertSame(['a@c.us' => 'http://p/a', 'b@c.us' => null], $res['pictures']);
    }

    // ── Webhooks ──────────────────────────────────────────────────────

    public function testWebhookCrudTest(): void
    {
        $wh = ['id' => 'w1', 'sessionId' => 's', 'url' => 'u', 'events' => ['*'], 'active' => true, 'createdAt' => '', 'updatedAt' => ''];
        $backend = new MockBackend();
        $backend->on(200, [$wh]);
        $backend->on(200, $wh);
        $backend->on(201, $wh);
        $backend->on(200, array_merge($wh, ['active' => false]));
        $backend->on(204);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->webhooks->list('s');
        $this->assertRequest($backend, 'GET', '/api/sessions/s/webhooks');
        $client->webhooks->get('s', 'w1');
        $this->assertRequest($backend, 'GET', '/api/sessions/s/webhooks/w1');
        $client->webhooks->create('s', ['url' => 'u', 'events' => ['*']]);
        $this->assertSame(['url' => 'u', 'events' => ['*']], $backend->calls()[2]['body']);
        $client->webhooks->update('s', 'w1', ['active' => false]);
        $this->assertSame('PUT', $backend->calls()[3]['method']);
        $client->webhooks->delete('s', 'w1');
        $this->assertRequest($backend, 'DELETE', '/api/sessions/s/webhooks/w1');
        $client->webhooks->test('s', 'w1');
        $this->assertStringContainsString('/webhooks/w1/test', $backend->calls()[5]['url']);
    }

    public function testEmptyMapFieldsEncodeAsJsonObjectNotJsonList(): void
    {
        // headers (webhook create/update) and vars (send-template) are map-typed on the wire; an
        // empty PHP array would serialize as a JSON list [] and the gateway's object validation
        // rejects it. The SDK must cast the empty map so it encodes as {}.
        $backend = (new MockBackend())->on(201, ['id' => 'w1']);
        $client = $backend->makeClient();

        $client->webhooks->create('s', ['url' => 'u', 'events' => ['*'], 'headers' => []]);
        $this->assertSame('{"url":"u","events":["*"],"headers":{}}', $backend->rawBody(0));

        $backend->on(200, ['id' => 'w1']);
        $client->webhooks->update('s', 'w1', ['active' => true, 'headers' => []]);
        $this->assertSame('{"active":true,"headers":{}}', $backend->rawBody(1));

        $backend->on(200, ['id' => 'm1']);
        $client->messages->sendTemplate('s', ['chatId' => 'c', 'templateName' => 't', 'vars' => []]);
        $this->assertSame('{"chatId":"c","templateName":"t","vars":{}}', $backend->rawBody(2));

        $backend->on(201, ['id' => 's1']);
        $client->sessions->create(['name' => 'n', 'config' => []]);
        $this->assertSame('{"name":"n","config":{}}', $backend->rawBody(3));
    }

    /** @dataProvider objectMaps */
    public function testMapFieldsStayObjectsForEveryArrayKeyShape(array $map): void
    {
        $backend = new MockBackend();
        foreach (range(1, 5) as $ignored) {
            $backend->on(200, []);
        }
        $client = $backend->makeClient();
        $template = ['chatId' => 'c', 'templateName' => 't', 'vars' => $map];
        $bulk = ['messages' => [['chatId' => 'c', 'type' => 'text', 'content' => ['text' => '{{0}}'], 'variables' => $map]], 'options' => []];
        $webhook = ['url' => 'https://receiver.example/hook', 'events' => ['message.received'], 'headers' => $map];
        $session = ['name' => 'fixture-session', 'config' => $map];
        $original = serialize([$template, $bulk, $webhook, $session]);

        $client->messages->sendTemplate('s', $template, 'template-key');
        $client->messages->sendBulk('s', $bulk);
        $client->webhooks->create('s', $webhook);
        $client->webhooks->update('s', 'w', ['headers' => $map]);
        $client->sessions->create($session);

        $bodies = array_map(fn ($index) => json_decode($backend->rawBody($index), false, 512, JSON_THROW_ON_ERROR), range(0, 4));
        foreach ([$bodies[0]->vars, $bodies[1]->messages[0]->variables, $bodies[2]->headers, $bodies[3]->headers, $bodies[4]->config] as $value) {
            $this->assertInstanceOf(\stdClass::class, $value);
            $this->assertSame($map, (array) $value);
        }
        $this->assertInstanceOf(\stdClass::class, $bodies[1]->options);
        $this->assertSame([], (array) $bodies[1]->options);
        $this->assertIsArray($bodies[1]->messages);
        $this->assertSame($original, serialize([$template, $bulk, $webhook, $session]));
        $this->assertSame('template-key', $backend->callAt(0)['headers']['idempotency-key']);
        $this->assertArrayNotHasKey('idempotency-key', $backend->callAt(1)['headers']);
    }

    public static function objectMaps(): array
    {
        return [
            'numeric zero' => [[0 => 'one']],
            'contiguous numeric keys' => [[0 => 'one', 1 => 'two']],
            'sparse numeric keys' => [[1 => 'one']],
            'named keys' => [['custom' => 'value']],
            'empty map' => [[]],
        ];
    }

    /** @dataProvider referencedMaps */
    public function testMapNormalizationPreservesCallerReferences(string $kind): void
    {
        $map = $kind === 'bulk-options' ? ['delayBetweenMessages' => 3000] : ['custom' => 'Alice'];
        $item = ['chatId' => 'c', 'type' => 'text', 'content' => ['text' => '{{custom}}'], 'variables' => $map];
        $items = [$item];
        $body = match ($kind) {
            'template' => ['chatId' => 'c', 'templateName' => 't', 'vars' => &$map],
            'bulk-variable' => ['messages' => [['chatId' => 'c', 'type' => 'text', 'content' => ['text' => '{{custom}}'], 'variables' => &$map]]],
            'bulk-item' => ['messages' => [&$item]],
            'bulk-messages' => ['messages' => &$items],
            'bulk-options' => ['messages' => [$item], 'options' => &$map],
            'webhook-create', 'webhook-update' => ['headers' => &$map],
            'session' => ['name' => 'fixture-session', 'config' => &$map],
        };
        $before = serialize([$body, $map, $item, $items]);
        $backend = (new MockBackend())->on(200, []);
        $client = $backend->makeClient();

        match ($kind) {
            'template' => $client->messages->sendTemplate('s', $body),
            'bulk-variable', 'bulk-item', 'bulk-messages', 'bulk-options' => $client->messages->sendBulk('s', $body),
            'webhook-create' => $client->webhooks->create('s', $body),
            'webhook-update' => $client->webhooks->update('s', 'w', $body),
            'session' => $client->sessions->create($body),
        };

        $this->assertSame($before, serialize([$body, $map, $item, $items]));
        $sent = json_decode($backend->rawBody(0), false, 512, JSON_THROW_ON_ERROR);
        $value = match ($kind) {
            'template' => $sent->vars,
            'bulk-variable', 'bulk-item', 'bulk-messages' => $sent->messages[0]->variables,
            'bulk-options' => $sent->options,
            'webhook-create', 'webhook-update' => $sent->headers,
            'session' => $sent->config,
        };
        $this->assertInstanceOf(\stdClass::class, $value);
        $this->assertSame($map, (array) $value);
    }

    public static function referencedMaps(): array
    {
        return [
            'template variables' => ['template'],
            'bulk variables' => ['bulk-variable'],
            'bulk item' => ['bulk-item'],
            'bulk messages' => ['bulk-messages'],
            'bulk options' => ['bulk-options'],
            'webhook create' => ['webhook-create'],
            'webhook update' => ['webhook-update'],
            'session config' => ['session'],
        ];
    }

    public function testMapNormalizationPreservesNullOmissionAndProtocolLists(): void
    {
        $backend = new MockBackend();
        foreach (range(1, 5) as $ignored) {
            $backend->on(200, []);
        }
        $client = $backend->makeClient();
        $client->messages->sendTemplate('s', ['chatId' => 'c', 'templateName' => 't', 'vars' => null]);
        $client->messages->sendTemplate('s', ['chatId' => 'c', 'templateName' => 't']);
        $client->messages->sendPoll('s', ['chatId' => 'c', 'name' => 'Q', 'options' => ['A', 'B'], 'mentions' => []]);
        $client->webhooks->create('s', ['url' => 'https://receiver.example/hook', 'events' => ['message.received'], 'headers' => null, 'filters' => ['conditions' => []]]);
        $client->request('POST', '/api/anything', [], ['first', 'second']);

        $bodies = array_map(fn ($index) => json_decode($backend->rawBody($index), false, 512, JSON_THROW_ON_ERROR), range(0, 4));
        $this->assertTrue(property_exists($bodies[0], 'vars'));
        $this->assertNull($bodies[0]->vars);
        $this->assertFalse(property_exists($bodies[1], 'vars'));
        $this->assertSame(['A', 'B'], $bodies[2]->options);
        $this->assertSame([], $bodies[2]->mentions);
        $this->assertNull($bodies[3]->headers);
        $this->assertSame(['message.received'], $bodies[3]->events);
        $this->assertSame([], $bodies[3]->filters->conditions);
        $this->assertSame(['first', 'second'], $bodies[4]);
    }

    public function testBulkItemsEncodeEmptyVariablesAsJsonObject(): void
    {
        $backend = (new MockBackend())->on(200, ['id' => 'b1']);
        $client = $backend->makeClient();

        $client->messages->sendBulk('s', ['messages' => [
            ['chatId' => 'c1', 'type' => 'template', 'templateName' => 't', 'variables' => []],
            ['chatId' => 'c2', 'type' => 'template', 'templateName' => 't', 'variables' => ['x' => 'y']],
        ]]);
        $this->assertSame(
            '{"messages":[{"chatId":"c1","type":"template","templateName":"t","variables":{}},{"chatId":"c2","type":"template","templateName":"t","variables":{"x":"y"}}]}',
            $backend->rawBody(0)
        );
    }

    public function testWebhookCreateForwardsPolymorphicFilterValuesVerbatim(): void
    {
        $backend = (new MockBackend())->on(201, ['id' => 'w1']);
        $client = $backend->makeClient();
        // The filter value is polymorphic on the wire: string (text fields),
        // string list (id/enum fields), bool (boolean fields) + caseSensitive.
        $filters = [
            'conditions' => [
                ['field' => 'sender', 'operator' => 'is', 'value' => ['123@c.us']],
                ['field' => 'body', 'operator' => 'contains', 'value' => 'invoice', 'caseSensitive' => true],
                ['field' => 'isGroup', 'operator' => 'is', 'value' => false],
            ],
        ];
        $client->webhooks->create('s', ['url' => 'u', 'events' => ['message.received'], 'filters' => $filters]);
        $this->assertSame(
            ['url' => 'u', 'events' => ['message.received'], 'filters' => $filters],
            $backend->lastCall()['body']
        );
    }

    // ── Chats & Health ────────────────────────────────────────────────

    public function testChatsPreserveOptionalLastMessageType(): void
    {
        $backend = new MockBackend();
        $backend->on(200, [['id' => 'photo@c.us', 'lastMessageType' => 'image'], ['id' => 'empty@c.us']]);
        $chats = $backend->makeClient()->chats->list('s');
        $this->assertSame('image', $chats[0]['lastMessageType']);
        $this->assertArrayNotHasKey('lastMessageType', $chats[1]);
    }

    public function testChats(): void
    {
        $backend = new MockBackend();
        $backend->on(200, []);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->chats->list('s');
        $this->assertRequest($backend, 'GET', '/api/sessions/s/chats');
        $client->chats->markRead('s', ['chatId' => 'a@c.us']);
        $this->assertStringContainsString('/chats/read', $backend->calls()[1]['url']);
        $client->chats->markUnread('s', ['chatId' => 'a@c.us']);
        $this->assertRequest($backend, 'POST', '/api/sessions/s/chats/unread');
        $client->chats->delete('s', ['chatId' => 'a@c.us']);
        $this->assertRequest($backend, 'POST', '/api/sessions/s/chats/delete');
        $client->chats->sendState('s', ['chatId' => 'a@c.us', 'state' => 'typing']);
        $this->assertStringContainsString('/chats/typing', $backend->calls()[4]['url']);
    }

    public function testChatsClearMessages(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->chats->clearMessages('s', 'a@c.us');
        $this->assertSame('DELETE', $backend->lastCall()['method']);
        $this->assertSame('/api/sessions/s/chats/a@c.us/messages', $backend->lastCall()['path']);
    }

    public function testGroupsPicture(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['url' => 'https://x/p.jpg']);
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->groups->getPicture('s', 'g@g.us');
        $this->assertSame('/api/sessions/s/groups/g@g.us/picture', $backend->lastCall()['path']);
        $client->groups->setPicture('s', 'g@g.us', ['url' => 'https://x/new.jpg']);
        $this->assertSame('PUT', $backend->lastCall()['method']);
        $client->groups->deletePicture('s', 'g@g.us');
        $this->assertSame('DELETE', $backend->lastCall()['method']);
    }

    public function testContactsAddressbook(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->contacts->upsert('s', 'a@c.us', ['firstName' => 'Ada']);
        $this->assertSame('PUT', $backend->lastCall()['method']);
        $this->assertSame('/api/sessions/s/contacts/a@c.us', $backend->lastCall()['path']);
        $client->contacts->delete('s', 'a@c.us');
        $this->assertSame('DELETE', $backend->lastCall()['method']);
    }

    public function testChatsArchive(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->chats->archive('s', ['chatId' => 'a@c.us', 'archive' => true]);
        $this->assertSame('/api/sessions/s/chats/archive', $backend->lastCall()['path']);
        $this->assertSame('POST', $backend->lastCall()['method']);
    }

    public function testChatsPinPostsTheFlag(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->chats->pin('s', ['chatId' => 'a@c.us', 'pin' => true]);
        $this->assertSame('/api/sessions/s/chats/pin', $backend->lastCall()['path']);
        $this->assertSame('POST', $backend->lastCall()['method']);
        $this->assertSame(['chatId' => 'a@c.us', 'pin' => true], $backend->lastCall()['body']);
    }

    public function testChatsPinReportsRefusalRatherThanThrowing(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => false]);
        $client = $backend->makeClient();
        $this->assertSame(['success' => false], $client->chats->pin('s', ['chatId' => 'a@c.us', 'pin' => true]));
    }

    public function testChatsMuteSendsEpochMillisecondsUnchanged(): void
    {
        // The value must arrive as the exact millisecond number given. A client that divided by 1000
        // would still get a 200 back; the wrong unit is only visible on the wire.
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->chats->mute('s', ['chatId' => 'a@c.us', 'muteUntil' => 1893456000000]);
        $this->assertSame('/api/sessions/s/chats/mute', $backend->lastCall()['path']);
        $this->assertSame(['chatId' => 'a@c.us', 'muteUntil' => 1893456000000], $backend->lastCall()['body']);
    }

    public function testChatsMuteSendsExplicitNullToUnmute(): void
    {
        // null is the unmute signal and is NOT the same as omitting the key, which the route rejects.
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->chats->mute('s', ['chatId' => 'a@c.us', 'muteUntil' => null]);
        $this->assertArrayHasKey('muteUntil', $backend->lastCall()['body']);
        $this->assertNull($backend->lastCall()['body']['muteUntil']);
    }

    // ── Status (Stories) ──────────────────────────────────────────────

    public function testStatusSendForwardsRecipientsAndNestedMedia(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['statusId' => 's1', 'timestamp' => '2025-01-01T00:00:00.000Z', 'expiresAt' => '2025-01-02T00:00:00.000Z']);
        $backend->on(200, ['statusId' => 's2', 'timestamp' => '2025-01-01T00:00:00.000Z', 'expiresAt' => '2025-01-02T00:00:00.000Z']);
        $backend->on(200, ['statusId' => 's3', 'timestamp' => '2025-01-01T00:00:00.000Z', 'expiresAt' => '2025-01-02T00:00:00.000Z']);
        $backend->on(200, ['statusId' => 's4', 'timestamp' => '2025-01-01T00:00:00.000Z', 'expiresAt' => '2025-01-02T00:00:00.000Z']);
        $client = $backend->makeClient();
        // `recipients` is forwarded verbatim (required on Baileys, ignored by whatsapp-web.js); media posts
        // use a nested {image|video|audio:{...}} body.
        $client->status->sendText('s', ['text' => 'hi', 'recipients' => ['628123456789@c.us']]);
        $this->assertSame(['text' => 'hi', 'recipients' => ['628123456789@c.us']], $backend->lastCall()['body']);
        $client->status->sendImage('s', ['image' => ['url' => 'http://img'], 'recipients' => ['628123456789@c.us'], 'caption' => 'c']);
        $this->assertSame(['image' => ['url' => 'http://img'], 'recipients' => ['628123456789@c.us'], 'caption' => 'c'], $backend->lastCall()['body']);
        $client->status->sendVideo('s', ['video' => ['url' => 'http://vid'], 'recipients' => ['628123456789@c.us']]);
        $this->assertSame(['video' => ['url' => 'http://vid'], 'recipients' => ['628123456789@c.us']], $backend->lastCall()['body']);
        // A voice status wraps its media under `audio` and carries no caption.
        $client->status->sendVoice('s', ['audio' => ['base64' => 'T2dnUw=='], 'recipients' => ['628123456789@c.us']]);
        $this->assertSame('/api/sessions/s/status/send-voice', $backend->lastCall()['path']);
        $this->assertSame(['audio' => ['base64' => 'T2dnUw=='], 'recipients' => ['628123456789@c.us']], $backend->lastCall()['body']);
    }

    public function testVotePollPostsOptionTexts(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->messages->votePoll('s', ['chatId' => 'c1', 'pollMessageId' => 'p1', 'options' => ['Pizza']]);
        $this->assertSame('/api/sessions/s/messages/vote-poll', $backend->lastCall()['path']);
        $this->assertSame('POST', $backend->lastCall()['method']);
    }

    public function testStarPostsTheBooleanThrough(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->messages->star('s', ['chatId' => 'c1', 'messageId' => 'm1', 'star' => false]);
        $this->assertSame('/api/sessions/s/messages/star', $backend->lastCall()['path']);
        $this->assertSame('POST', $backend->lastCall()['method']);
    }

    public function testPinAndUnpinPostToTheirRoutes(): void
    {
        $backend = new MockBackend();
        // Queue responses in CALL order: pin, unpin.
        $backend->on(200, ['success' => true]);
        $backend->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $client->messages->pin('s', ['chatId' => 'c1', 'messageId' => 'm1', 'durationSeconds' => 604800]);
        $this->assertSame('/api/sessions/s/messages/pin', $backend->lastCall()['path']);
        $this->assertSame('POST', $backend->lastCall()['method']);
        $client->messages->unpin('s', ['chatId' => 'c1', 'messageId' => 'm1']);
        $this->assertSame('/api/sessions/s/messages/unpin', $backend->lastCall()['path']);
    }

    public function testMessageMediaReturnsArchivedBytes(): void
    {
        $backend = (new MockBackend())->onRaw(200, 'PNG_BYTES', ['Content-Type' => 'image/png']);
        $client = $backend->makeClient();
        $media = $client->messages->media('s', 'c1', 'm1');
        $call = $backend->lastCall();
        $this->assertSame('GET', $call['method']);
        $this->assertSame('/api/sessions/s/messages/c1/m1/media', $call['path']);
        $this->assertSame('PNG_BYTES', $media['data']);
        $this->assertSame('image/png', $media['contentType']);
    }

    public function testStatusMediaReturnsStoredBytes(): void
    {
        $backend = (new MockBackend())->onRaw(200, 'PNG_BYTES', ['Content-Type' => 'image/png']);
        $client = $backend->makeClient();
        $media = $client->status->media('s', 'w1');
        $call = $backend->lastCall();
        $this->assertSame('GET', $call['method']);
        $this->assertSame('/api/sessions/s/status/w1/media', $call['path']);
        $this->assertSame('PNG_BYTES', $media['data']);
        $this->assertSame('image/png', $media['contentType']);
    }

    public function testStatusMedia404MapsToNotFoundException(): void
    {
        $backend = (new MockBackend())->on(404, [
            'statusCode' => 404,
            'message' => 'Status media not found or expired',
            'error' => 'Not Found',
        ]);
        $this->expectException(OpenWANotFoundException::class);
        $backend->makeClient()->status->media('s', 'w1');
    }

    public function testHealthAndAuth(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['status' => 'ok', 'version' => '0.7.2']);
        $backend->on(200, ['status' => 'ok']);
        $backend->on(200, ['status' => 'ok', 'details' => []]);
        $backend->on(200, ['valid' => true, 'role' => 'admin']);
        $client = $backend->makeClient();
        $client->health->check();
        $this->assertSame('/api/health', $backend->calls()[0]['path']);
        $client->health->live();
        $this->assertRequest($backend, 'GET', '/api/health/live');
        $client->health->ready();
        $this->assertRequest($backend, 'GET', '/api/health/ready');
        $client->auth();
        $this->assertSame('POST', $backend->calls()[3]['method']);
        $this->assertStringContainsString('/auth/validate', $backend->calls()[3]['url']);
    }

    public function testGroupMembershipRequests(): void
    {
        $backend = new MockBackend();
        $backend->on(200, [['participantId' => 'a@c.us', 'method' => 'invite_link']]);
        $backend->on(200, ['success' => true, 'message' => 'ok', 'results' => []]);
        $backend->on(200, ['success' => true, 'message' => 'ok', 'results' => []]);
        $client = $backend->makeClient();

        $pending = $client->groups->getMembershipRequests('s', 'g1@g.us');
        $this->assertSame('GET', $backend->lastCall()['method']);
        $this->assertStringEndsWith('/groups/g1@g.us/membership-requests', $backend->lastCall()['url']);
        $this->assertSame('a@c.us', $pending[0]['participantId']);

        $client->groups->approveMembershipRequests('s', 'g1@g.us', ['a@c.us']);
        $this->assertStringEndsWith('/membership-requests/approve', $backend->lastCall()['url']);
        $this->assertSame(['participants' => ['a@c.us']], $backend->lastCall()['body']);

        // Omitting the list means "every pending request": an empty body, not a null participants key.
        $client->groups->rejectMembershipRequests('s', 'g1@g.us');
        $this->assertStringEndsWith('/membership-requests/reject', $backend->lastCall()['url']);
        $this->assertSame([], $backend->lastCall()['body']);
        // On the wire that is an empty object, as in the other SDKs, not an empty array.
        $this->assertSame('{}', $backend->rawBody(2));
    }

    public function testCreateCallLink(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['link' => 'https://call.whatsapp.com/video/AbC']);
        $client = $backend->makeClient();
        $res = $client->calls->createLink('s', ['type' => 'video', 'startTime' => 1800000000000]);
        $this->assertSame('POST', $backend->lastCall()['method']);
        $this->assertStringEndsWith('/sessions/s/calls/link', $backend->lastCall()['url']);
        $this->assertSame(['type' => 'video', 'startTime' => 1800000000000], $backend->lastCall()['body']);
        $this->assertStringContainsString('call.whatsapp.com', $res['link']);
    }

    public function testRedriveDeliveryFailuresPostsTheFilterOrAnEmptyObject(): void
    {
        $result = ['redriven' => 1, 'delivered' => 1, 'enqueued' => 0, 'failed' => 0, 'skipped' => 0, 'remaining' => 0];
        $backend = new MockBackend();
        $backend->on(200, $result);
        $backend->on(200, $result);
        $client = $backend->makeClient();

        $this->assertSame($result, $client->webhooks->redriveDeliveryFailures(['sessionId' => 's', 'limit' => 10]));
        $this->assertRequest($backend, 'POST', '/api/webhooks/delivery-failures/redrive');
        $this->assertSame('{"sessionId":"s","limit":10}', $backend->rawBody(0));

        // An empty filter must go out as a JSON object: `[]` is not a valid body for the DTO.
        $client->webhooks->redriveDeliveryFailures();
        $this->assertSame('{}', $backend->rawBody(1));
    }

    public function testRedriveDeliveryFailuresKeepsAnExplicitEmptyIdsList(): void
    {
        // The gateway reads ids: [] as "replay nothing" and an omitted ids as "replay up to 100 rows".
        $backend = new MockBackend();
        $backend->on(200, ['redriven' => 0, 'delivered' => 0, 'enqueued' => 0, 'failed' => 0, 'skipped' => 0, 'remaining' => 3]);

        $backend->makeClient()->webhooks->redriveDeliveryFailures(['ids' => []]);

        $this->assertSame('{"ids":[]}', $backend->rawBody(0));
    }

    public function testSendMethodsForwardIdempotencyKeysWithoutChangingJson(): void
    {
        $cases = [
            ['sendText', 'send-text', ['chatId' => 'a@c.us', 'text' => 'hello', 'quotedMessageId' => 'q']],
            ['sendImage', 'send-image', ['chatId' => 'a@c.us', 'url' => 'https://media/image', 'caption' => 'image']],
            ['sendVideo', 'send-video', ['chatId' => 'a@c.us', 'url' => 'https://media/video']],
            ['sendAudio', 'send-audio', ['chatId' => 'a@c.us', 'url' => 'https://media/audio', 'ptt' => true]],
            ['sendDocument', 'send-document', ['chatId' => 'a@c.us', 'url' => 'https://media/doc', 'filename' => 'doc.pdf']],
            ['sendSticker', 'send-sticker', ['chatId' => 'a@c.us', 'url' => 'https://media/sticker']],
            ['sendLocation', 'send-location', ['chatId' => 'a@c.us', 'latitude' => -6.2, 'longitude' => 106.8]],
            ['sendContact', 'send-contact', ['chatId' => 'a@c.us', 'contactName' => 'A', 'contactNumber' => '628']],
            ['sendTemplate', 'send-template', ['chatId' => 'a@c.us', 'templateId' => 't', 'vars' => []]],
            ['sendPoll', 'send-poll', ['chatId' => 'a@c.us', 'name' => 'Q', 'options' => ['A', 'B']]],
            ['reply', 'reply', ['chatId' => 'a@c.us', 'quotedMessageId' => 'q', 'text' => 'reply']],
            ['forward', 'forward', ['fromChatId' => 'a@c.us', 'toChatId' => 'b@c.us', 'messageId' => 'm']],
        ];
        foreach ([null, '!', '~', 'a', str_repeat('a', 255)] as $key) {
            $backend = new MockBackend();
            $client = $backend->makeClient();
            foreach ($cases as $index => [$method, $segment, $body]) {
                $backend->on(200, ['messageId' => 'm', 'timestamp' => 1]);
                if ($key === null) {
                    $client->messages->{$method}('s', $body);
                } else {
                    $client->messages->{$method}('s', $body, $key);
                }
                $call = $backend->lastCall();
                $this->assertSame('POST', $call['method'], $method);
                $this->assertSame('/api/sessions/s/messages/' . $segment, $call['path'], $method);
                // The key travels in its header only: in the URL it would reach proxy and access logs.
                $this->assertSame('', $call['query'], $method);
                $this->assertSame($body, $call['body'], $method);
                $expected = $body;
                if ($method === 'sendTemplate') {
                    $expected['vars'] = new \stdClass();
                }
                $this->assertSame(json_encode($expected), $backend->rawBody($index), $method);
                if ($key === null) {
                    $this->assertArrayNotHasKey('idempotency-key', $call['headers'], $method);
                } else {
                    $this->assertSame($key, $call['headers']['idempotency-key'], $method);
                }
            }
        }
    }

    public function testSendKeysStayLocalToEachRequest(): void
    {
        $backend = new MockBackend();
        $client = $backend->makeClient();
        $body = ['chatId' => 'a@c.us', 'text' => 'hello'];
        foreach (['first-key', 'second-key', null] as $key) {
            $backend->on(200, ['messageId' => 'm', 'timestamp' => 1]);
            if ($key === null) {
                $client->messages->sendText('s', $body);
                $this->assertArrayNotHasKey('idempotency-key', $backend->lastCall()['headers']);
            } else {
                $client->messages->sendText('s', $body, $key);
                $this->assertSame($key, $backend->lastCall()['headers']['idempotency-key']);
            }
            $this->assertSame('', $backend->lastCall()['query']);
            $this->assertSame($body, $backend->lastCall()['body']);
        }
    }

    public function testSendKeyOverridesDefaultHeaderWithoutChangingDefaults(): void
    {
        $backend = new MockBackend();
        $defaults = ['iDeMpOtEnCy-KeY' => 'default-key', 'X-Trace' => 'trace'];
        $client = new Client([
            'baseUrl' => 'http://localhost:2785',
            'apiKey' => 'owa_k1_test',
            'httpClient' => $backend->httpClient(),
            'defaultHeaders' => $defaults,
        ]);
        $body = ['chatId' => 'a@c.us', 'text' => 'hello'];
        $backend->on(200, ['messageId' => 'm', 'timestamp' => 1]);
        $client->messages->sendText('s', $body, 'request-key');
        $this->assertSame('request-key', $backend->lastCall()['headers']['idempotency-key']);
        $this->assertSame('trace', $backend->lastCall()['headers']['x-trace']);
        $backend->on(200, ['messageId' => 'm', 'timestamp' => 1]);
        $client->messages->sendText('s', $body);
        $this->assertSame('default-key', $backend->lastCall()['headers']['idempotency-key']);
        $this->assertSame(['iDeMpOtEnCy-KeY' => 'default-key', 'X-Trace' => 'trace'], $defaults);
    }

    public function testInvalidSendKeysAreRefusedBeforeTransport(): void
    {
        $backend = new MockBackend();
        $client = $backend->makeClient();
        foreach (['', ' ', 'contains space', "key\n", "\xC3\xA9", "a\x7Fb", str_repeat('a', 256)] as $key) {
            try {
                $client->messages->sendText('s', ['chatId' => 'a@c.us', 'text' => 'hello'], $key);
                $this->fail('Expected invalid key to be refused');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('1-255 visible ASCII', $error->getMessage());
                $this->assertSame([], $backend->calls());
            }
        }
    }

    /**
     * Eleven routes no other test calls. Each row is written from the contract (openapi.json: verb, path,
     * query and request-body keys), not read off the client, so a changed verb or a renamed body key fails here.
     *
     * @dataProvider untestedRoutes
     */
    public function testVerbPathQueryAndBodyOfARouteNoOtherTestCalls(
        callable $call,
        string $method,
        string $path,
        array $query,
        ?array $body
    ): void {
        $backend = (new MockBackend())->on(200, []);
        $call($backend->makeClient());

        $this->assertCount(1, $backend->calls());
        $this->assertRequest($backend, $method, $path);
        parse_str($backend->lastCall()['query'], $sent);
        $this->assertSame($query, $sent);
        $this->assertSame($body === null ? '' : json_encode($body), $backend->rawBody(0));
    }

    public static function untestedRoutes(): array
    {
        $config = ['autoRejectCalls' => true, 'maxReconnectAttempts' => null, 'reconnectBaseDelay' => 2000];
        return [
            'sessions->getConfig' => [fn (Client $c) => $c->sessions->getConfig('s1'), 'GET', '/api/sessions/s1/config', [], null],
            'sessions->updateConfig' => [fn (Client $c) => $c->sessions->updateConfig('s1', $config), 'PATCH', '/api/sessions/s1/config', [], $config],
            'sessions->getProxy' => [fn (Client $c) => $c->sessions->getProxy('s1'), 'GET', '/api/sessions/s1/proxy', [], null],
            'sessions->updateProxy' => [fn (Client $c) => $c->sessions->updateProxy('s1', ['proxyUrl' => null]), 'PATCH', '/api/sessions/s1/proxy', [], ['proxyUrl' => null]],
            'webhooks->listAll' => [fn (Client $c) => $c->webhooks->listAll(['limit' => 5, 'offset' => 10]), 'GET', '/api/webhooks', ['limit' => '5', 'offset' => '10'], null],
            'webhooks->deliveryFailures' => [
                fn (Client $c) => $c->webhooks->deliveryFailures(['sessionId' => 's1', 'limit' => 5, 'offset' => 10]),
                'GET',
                '/api/webhooks/delivery-failures',
                ['sessionId' => 's1', 'limit' => '5', 'offset' => '10'],
                null,
            ],
            'chats->subscribePresence' => [
                fn (Client $c) => $c->chats->subscribePresence('s1', ['chatId' => 'a@c.us']),
                'POST',
                '/api/sessions/s1/presence/subscribe',
                [],
                ['chatId' => 'a@c.us'],
            ],
            'chats->getPresence' => [fn (Client $c) => $c->chats->getPresence('s1', 'a@c.us'), 'GET', '/api/sessions/s1/presence/a@c.us', [], null],
            'status->fromContact' => [fn (Client $c) => $c->status->fromContact('s1', 'a@c.us'), 'GET', '/api/sessions/s1/status/a@c.us', [], null],
            'labels->chats' => [fn (Client $c) => $c->labels->chats('s1', 'l1'), 'GET', '/api/sessions/s1/labels/l1/chats', [], null],
            'groups->joinInfo' => [fn (Client $c) => $c->groups->joinInfo('s1', 'INVITE'), 'GET', '/api/sessions/s1/groups/join-info', ['code' => 'INVITE'], null],
        ];
    }

    private function assertRequest(MockBackend $backend, string $method, string $path): void
    {
        $this->assertSame($method, $backend->lastCall()['method']);
        $this->assertSame($path, $backend->lastCall()['path']);
    }
}
