package com.rmyndharis.openwa;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Checks the {@code X-OpenWA-Signature} header of a webhook delivery. */
public final class WebhookSignature {
    private static final Pattern SIGNATURE = Pattern.compile("sha256=([0-9a-fA-F]{64})");

    private WebhookSignature() {}

    /**
     * Check a delivery's {@code X-OpenWA-Signature} header ({@code sha256=<hex HMAC-SHA256>}) against
     * the webhook secret. Pass the raw request body exactly as received; a re-serialized parse can
     * differ byte for byte and will not verify. Returns {@code false} (never throws) for a missing,
     * malformed or non-matching signature and for an empty secret.
     */
    public static boolean verify(byte[] body, String signature, String secret) {
        if (body == null || signature == null || secret == null || secret.isEmpty()) {
            return false;
        }
        var match = SIGNATURE.matcher(signature);
        if (!match.matches()) {
            return false;
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return MessageDigest.isEqual(mac.doFinal(body), HexFormat.of().parseHex(match.group(1)));
        } catch (GeneralSecurityException e) {
            return false;
        }
    }

    /** As {@link #verify(byte[], String, String)}, for a body already read as a UTF-8 string. */
    public static boolean verify(String body, String signature, String secret) {
        return body != null && verify(body.getBytes(StandardCharsets.UTF_8), signature, secret);
    }
}
