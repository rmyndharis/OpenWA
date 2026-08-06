<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use OpenWA\Exceptions\OpenWANotFoundException;
use PHPUnit\Framework\TestCase;

class ProfileCallsTest extends TestCase
{
    public function testProfileNameStatus(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true, 'message' => 'Profile name updated']);
        $backend->on(200, ['success' => true, 'message' => 'Profile status updated']);
        $client = $backend->makeClient();
        $client->profile->setProfileName('s', 'My Business');
        $this->assertSame('PUT', $backend->calls()[0]['method']);
        $this->assertSame('/api/sessions/s/profile/name', $backend->calls()[0]['path']);
        $this->assertSame(['name' => 'My Business'], $backend->calls()[0]['body']);
        $client->profile->setProfileStatus('s', '');
        $this->assertSame('/api/sessions/s/profile/status', $backend->calls()[1]['path']);
        $this->assertSame(['status' => ''], $backend->calls()[1]['body']);
    }

    public function testProfilePictureUrlAndBase64(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['success' => true, 'message' => 'Profile picture updated']);
        $backend->on(200, ['success' => true, 'message' => 'Profile picture updated']);
        $client = $backend->makeClient();
        $client->profile->setProfilePicture('s', ['url' => 'https://example.com/avatar.jpg']);
        $this->assertSame('PUT', $backend->calls()[0]['method']);
        $this->assertSame('/api/sessions/s/profile/picture', $backend->calls()[0]['path']);
        $this->assertSame(['url' => 'https://example.com/avatar.jpg'], $backend->calls()[0]['body']);
        $client->profile->setProfilePicture('s', ['base64' => 'aW1hZ2U=', 'mimetype' => 'image/jpeg']);
        $this->assertSame(['base64' => 'aW1hZ2U=', 'mimetype' => 'image/jpeg'], $backend->calls()[1]['body']);
    }

    public function testRejectCall(): void
    {
        $backend = (new MockBackend())->on(200, ['success' => true]);
        $client = $backend->makeClient();
        $result = $client->calls->rejectCall('s', 'call-123');
        $call = $backend->lastCall();
        $this->assertSame('POST', $call['method']);
        $this->assertSame('/api/sessions/s/calls/call-123/reject', $call['path']);
        $this->assertTrue($result['success']);
    }

    public function testRejectCall404MapsToNotFoundException(): void
    {
        $backend = (new MockBackend())->on(404, [
            'statusCode' => 404,
            'message' => 'Call not found or no longer ringing',
            'error' => 'Not Found',
        ]);
        $this->expectException(OpenWANotFoundException::class);
        $backend->makeClient()->calls->rejectCall('s', 'missing');
    }
}
