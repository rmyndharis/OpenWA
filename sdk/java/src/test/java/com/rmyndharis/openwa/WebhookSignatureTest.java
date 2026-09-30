package com.rmyndharis.openwa;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.Gson;
import com.rmyndharis.openwa.model.WebhookDelivery;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

class WebhookSignatureTest {
    // Shared across the SDK suites; the gateway's generateSignature produces this header for this body.
    private static final String SECRET = "test-secret-0123456789";
    private static final String BODY =
        "{\"event\":\"message.received\",\"timestamp\":\"2026-02-02T10:00:00.000Z\",\"sessionId\":\"s1\","
            + "\"idempotencyKey\":\"k\",\"deliveryId\":\"dlv_1\",\"data\":{\"text\":\"héllo 👋\"}}";
    private static final String HEX = "d74a41bb687f31ed4c932f76f524116100ca4120d2cabb7a469ee5d928122f70";
    private static final String SIGNATURE = "sha256=" + HEX;

    @Test
    void acceptsTheGatewaySignatureOverTextOrBytes() {
        assertTrue(WebhookSignature.verify(BODY, SIGNATURE, SECRET));
        assertTrue(WebhookSignature.verify(BODY.getBytes(StandardCharsets.UTF_8), SIGNATURE, SECRET));
        assertTrue(WebhookSignature.verify(BODY, "sha256=" + HEX.toUpperCase(), SECRET));
    }

    @Test
    void rejectsAChangedBodyAWrongSecretAndAMalformedHeader() {
        byte[] tampered = BODY.getBytes(StandardCharsets.UTF_8);
        tampered[10] ^= 1;
        assertFalse(WebhookSignature.verify(tampered, SIGNATURE, SECRET));
        assertFalse(WebhookSignature.verify(BODY, SIGNATURE, "another-secret-012345"));
        assertFalse(WebhookSignature.verify(BODY, SIGNATURE, ""));
        for (String header : Arrays.asList(
                HEX, "SHA256=" + HEX, "sha256=" + HEX.substring(1), "sha256=" + HEX.substring(1) + "z", "", null)) {
            assertFalse(WebhookSignature.verify(BODY, header, SECRET), "accepted " + header);
        }
    }

    @Test
    void deliveryDecodesTheTestEvent() {
        WebhookDelivery d = new Gson().fromJson(
            "{\"event\":\"test\",\"sessionId\":\"s1\",\"deliveryId\":\"dlv_1\",\"data\":{\"a\":1}}", WebhookDelivery.class);
        assertEquals("test", d.event());
        assertEquals("s1", d.sessionId());
        assertEquals(1, d.data().get("a").getAsInt());
    }
}
