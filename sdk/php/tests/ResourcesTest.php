<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

class ResourcesTest extends TestCase
{
    // ── Sessions ──────────────────────────────────────────────────────

    public function testSessionLifecyclePaths(): void
    {
        $backend = new MockBackend();
        // Queue responses in CALL order: list, get, create, start, stop, forceKill, delete.
        $backend->on(200, []);
        $backend->on(200, ['id' => 's1', 'name' => 'n', 'status' => 'ready']);
        $backend->on(201, ['id' => 's1', 'name' => 'n', 'status' => 'created']);
        $backend->on(200, ['id' => 's1', 'status' => 'initializing']);
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
