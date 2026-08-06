<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use PHPUnit\Framework\TestCase;

class MediaTest extends TestCase
{
    public function testConversionStatus(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['available' => true]);
        $res = $backend->makeClient()->media->conversionStatus('s');
        $this->assertSame('GET', $backend->calls()[0]['method']);
        $this->assertSame('/api/sessions/s/media/convert', $backend->calls()[0]['path']);
        $this->assertTrue($res['available']);
    }

    public function testConvertVoiceSendsOnlyTheGivenField(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['base64' => 'T2dnUw==', 'mimetype' => 'audio/ogg; codecs=opus', 'bytes' => 8]);
        $res = $backend->makeClient()->media->convertVoice('s', ['base64' => 'SUQz']);
        $this->assertSame('POST', $backend->calls()[0]['method']);
        $this->assertSame('/api/sessions/s/media/convert/voice', $backend->calls()[0]['path']);
        $this->assertSame(['base64' => 'SUQz'], $backend->calls()[0]['body']);
        $this->assertSame('audio/ogg; codecs=opus', $res['mimetype']);
    }

    public function testConvertVideoWithUrl(): void
    {
        $backend = new MockBackend();
        $backend->on(200, ['base64' => 'AAAA', 'mimetype' => 'video/mp4', 'bytes' => 4]);
        $backend->makeClient()->media->convertVideo('s', ['url' => 'https://example.com/c.mov']);
        $this->assertSame('/api/sessions/s/media/convert/video', $backend->calls()[0]['path']);
        $this->assertSame(['url' => 'https://example.com/c.mov'], $backend->calls()[0]['body']);
    }
}
