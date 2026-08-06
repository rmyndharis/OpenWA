<?php

declare(strict_types=1);

namespace OpenWA\Tests;

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
        $client->sessions->create(['name' => 'n']);
        $this->assertSame(['name' => 'n'], $backend->lastCall()['body']);
        $client->sessions->start('s1');
        $this->assertStringContainsString('/sessions/s1/start', $backend->lastCall()['path']);
        $client->sessions->stop('s1');
        $client->sessions->logout('s1');
        $this->assertStringContainsString('/sessions/s1/logout', $backend->lastCall()['path']);
        $client->sessions->forceKill('s1');
        $this->assertStringContainsString('/sessions/s1/force-kill', $backend->lastCall()['path']);
        $client->sessions->delete('s1');
        $this->assertSame('DELETE', $backend->lastCall()['method']);
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

    // ── Groups ────────────────────────────────────────────────────────

    public function testGroupListGetCreate(): void
    {
        $backend = new MockBackend();
        $backend->on(200, []);
        $backend->on(200, ['id' => 'g1@g.us', 'subject' => 'G', 'participants' => []]);
        $backend->on(201, ['id' => 'g1@g.us', 'subject' => 'G', 'participants' => []]);
        $client = $backend->makeClient();
        $client->groups->list('s');
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
        $client->groups->inviteCode('s', 'g');
        $client->groups->revokeInviteCode('s', 'g');
        $this->assertStringContainsString('/revoke', $backend->calls()[4]['url']);
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
        $client->contacts->check('s', '628123');
        $this->assertStringContainsString('/check/628123', $backend->calls()[2]['url']);
        $client->contacts->profilePicture('s', 'a@c.us');
        $client->contacts->phone('s', 'x@lid');
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
        $client->webhooks->get('s', 'w1');
        $client->webhooks->create('s', ['url' => 'u', 'events' => ['*']]);
        $this->assertSame(['url' => 'u', 'events' => ['*']], $backend->calls()[2]['body']);
        $client->webhooks->update('s', 'w1', ['active' => false]);
        $this->assertSame('PUT', $backend->calls()[3]['method']);
        $client->webhooks->delete('s', 'w1');
        $client->webhooks->test('s', 'w1');
        $this->assertStringContainsString('/webhooks/w1/test', $backend->calls()[5]['url']);
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
        $client->chats->markRead('s', ['chatId' => 'a@c.us']);
        $this->assertStringContainsString('/chats/read', $backend->calls()[1]['url']);
        $client->chats->markUnread('s', ['chatId' => 'a@c.us']);
        $client->chats->delete('s', ['chatId' => 'a@c.us']);
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

    // ── Status (Stories) ──────────────────────────────────────────────

    public function testStatusSendForwardsRequiredRecipientsAndNestedMedia(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['statusId' => 's1', 'timestamp' => '2025-01-01T00:00:00.000Z', 'expiresAt' => '2025-01-02T00:00:00.000Z']);
        $backend->on(200, ['statusId' => 's2', 'timestamp' => '2025-01-01T00:00:00.000Z', 'expiresAt' => '2025-01-02T00:00:00.000Z']);
        $backend->on(200, ['statusId' => 's3', 'timestamp' => '2025-01-01T00:00:00.000Z', 'expiresAt' => '2025-01-02T00:00:00.000Z']);
        $backend->on(200, ['statusId' => 's4', 'timestamp' => '2025-01-01T00:00:00.000Z', 'expiresAt' => '2025-01-02T00:00:00.000Z']);
        $client = $backend->makeClient();
        // Server requires `recipients` on every status post; media posts use a nested {image|video:{...}} body.
        $client->status->sendText('s', ['text' => 'hi', 'recipients' => ['a@c.us']]);
        $this->assertSame(['text' => 'hi', 'recipients' => ['a@c.us']], $backend->lastCall()['body']);
        $client->status->sendImage('s', ['image' => ['url' => 'http://img'], 'recipients' => ['a@c.us'], 'caption' => 'c']);
        $this->assertSame(['image' => ['url' => 'http://img'], 'recipients' => ['a@c.us'], 'caption' => 'c'], $backend->lastCall()['body']);
        $client->status->sendVideo('s', ['video' => ['url' => 'http://vid'], 'recipients' => ['a@c.us']]);
        $this->assertSame(['video' => ['url' => 'http://vid'], 'recipients' => ['a@c.us']], $backend->lastCall()['body']);
        // A voice status wraps its media under `audio` and carries no caption.
        $client->status->sendVoice('s', ['audio' => ['base64' => 'T2dnUw=='], 'recipients' => ['a@c.us']]);
        $this->assertSame('/api/sessions/s/status/send-voice', $backend->lastCall()['path']);
        $this->assertSame(['audio' => ['base64' => 'T2dnUw=='], 'recipients' => ['a@c.us']], $backend->lastCall()['body']);
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
        $client->health->ready();
        $client->auth();
        $this->assertSame('POST', $backend->calls()[3]['method']);
        $this->assertStringContainsString('/auth/validate', $backend->calls()[3]['url']);
    }
}
