<?php

declare(strict_types=1);

namespace OpenWA\Tests;

use OpenWA\WebhookSignature;
use PHPUnit\Framework\TestCase;

class WebhookSignatureTest extends TestCase
{
    // Shared across the SDK suites; the gateway's generateSignature produces this header for this body.
    private const SECRET = 'test-secret-0123456789';
    private const BODY = '{"event":"message.received","timestamp":"2026-02-02T10:00:00.000Z","sessionId":"s1",'
        . '"idempotencyKey":"k","deliveryId":"dlv_1","data":{"text":"h' . "\u{00e9}llo \u{1F44B}" . '"}}';
    private const HEX = 'd74a41bb687f31ed4c932f76f524116100ca4120d2cabb7a469ee5d928122f70';

    public function testAcceptsTheGatewaySignature(): void
    {
        $this->assertTrue(WebhookSignature::verify(self::BODY, 'sha256=' . self::HEX, self::SECRET));
        $this->assertTrue(WebhookSignature::verify(self::BODY, 'sha256=' . strtoupper(self::HEX), self::SECRET));
    }

    public function testRejectsAChangedBodyAWrongSecretAndAMalformedHeader(): void
    {
        $signature = 'sha256=' . self::HEX;
        $tampered = self::BODY;
        $tampered[10] = chr(ord($tampered[10]) ^ 1);
        $this->assertFalse(WebhookSignature::verify($tampered, $signature, self::SECRET));
        $this->assertFalse(WebhookSignature::verify(self::BODY, $signature, 'another-secret-012345'));
        $this->assertFalse(WebhookSignature::verify(self::BODY, $signature, ''));
        $headers = [
            self::HEX,
            'SHA256=' . self::HEX,
            'sha256=' . substr(self::HEX, 1),
            'sha256=' . substr(self::HEX, 1) . 'z',
            $signature . "\n",
            '',
            null,
        ];
        foreach ($headers as $header) {
            $this->assertFalse(WebhookSignature::verify(self::BODY, $header, self::SECRET), var_export($header, true));
        }
    }
}
