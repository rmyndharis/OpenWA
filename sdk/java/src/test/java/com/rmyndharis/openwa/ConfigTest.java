package com.rmyndharis.openwa;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.errors.OpenWAError;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.http.HttpTransport;
import com.rmyndharis.openwa.model.SuccessResult;
import com.rmyndharis.openwa.support.MockTransport;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class ConfigTest {
    private static ClientConfig.Builder base() {
        return ClientConfig.builder().baseUrl("http://h").apiKey("owa_k1_x");
    }

    @Test
    void rejectsZeroAndNegativeTimeout() {
        assertThrows(IllegalArgumentException.class, () -> base().timeout(Duration.ZERO).build());
        assertThrows(IllegalArgumentException.class, () -> base().timeout(Duration.ofSeconds(-1)).build());
    }

    @Test
    void rejectsMalformedBaseUrl() {
        assertThrows(IllegalArgumentException.class,
            () -> ClientConfig.builder().baseUrl("http://my host:2785").apiKey("owa_k1_x").build());
    }

    @Test
    void rejectsApiKeyWithInteriorControlChar() {
        assertThrows(IllegalArgumentException.class,
            () -> ClientConfig.builder().baseUrl("http://h").apiKey("owa\nk1").build());
    }

    @Test
    void trimsWhitespaceFromBaseUrlAndApiKey() {
        // A trailing newline (e.g. key read from a file/env) must be tolerated, not fatal.
        MockTransport tx = new MockTransport().respond(200, "{\"valid\":true}");
        OpenWAClient c = new OpenWAClient(
            ClientConfig.builder().baseUrl("http://h ").apiKey(" owa_k1_x\n").transport(tx).build());
        c.auth();
        assertEquals("owa_k1_x", tx.lastRequest().headers().get("X-API-Key"));
        assertTrue(tx.lastRequest().url().startsWith("http://h/"));
    }

    @Test
    void transportIllegalArgumentIsWrappedAsOpenWAError() {
        HttpTransport bad = req -> {
            throw new IllegalArgumentException("restricted header name: \"Host\"");
        };
        OpenWAClient c = new OpenWAClient(base().transport(bad).build());
        OpenWAError e = assertThrows(OpenWAError.class,
            () -> c.request(HttpMethod.GET, "/x", null, null, SuccessResult.class));
        assertTrue(e.getMessage().contains("Invalid request"));
    }
}
