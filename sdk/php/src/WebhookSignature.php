<?php

declare(strict_types=1);

namespace OpenWA;

/**
 * Checks the X-OpenWA-Signature header of a webhook delivery.
 */
final class WebhookSignature
{
    private function __construct()
    {
    }

    /**
     * Check a delivery's X-OpenWA-Signature header (`sha256=<hex HMAC-SHA256>`)
     * against the webhook secret. Pass the raw request body exactly as received
     * (e.g. `file_get_contents('php://input')`); a re-encoded json_decode() can
     * differ byte for byte and will not verify. Returns false for a missing,
     * malformed or non-matching signature and for an empty secret.
     */
    public static function verify(string $rawBody, ?string $signature, string $secret): bool
    {
        if ($secret === '' || $signature === null || !preg_match('/^sha256=([0-9a-fA-F]{64})$/D', $signature, $m)) {
            return false;
        }
        return hash_equals(hash_hmac('sha256', $rawBody, $secret), strtolower($m[1]));
    }
}
