package com.rmyndharis.openwa.model;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

/**
 * The config route needs three states per field: an absent key leaves the value unchanged, an
 * explicit null clears it to the default, a value sets it. Gson omits nulls by default, so a record
 * of nullable boxes could only ever express two — and restoring unlimited reconnect attempts, the
 * one thing this route exists for, was unreachable.
 */
class UpdateSessionConfigRequestTest {
    // Mirrors the client's nullEmittingGson exactly: without serializeNulls the writer drops the
    // very null the serializer was written to emit.
    private final Gson gson = new GsonBuilder()
            .serializeNulls()
            .registerTypeAdapter(UpdateSessionConfigRequest.class, new UpdateSessionConfigRequestSerializer())
            .create();

    @Test
    void absentFieldsAreOmitted() {
        assertEquals("{}", gson.toJson(UpdateSessionConfigRequest.builder().build()));
    }

    @Test
    void aValueIsSent() {
        assertEquals(
                "{\"maxReconnectAttempts\":5}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .maxReconnectAttempts(5)
                        .build()));
    }

    @Test
    void clearSendsAnExplicitNull() {
        assertEquals(
                "{\"maxReconnectAttempts\":null}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .clearMaxReconnectAttempts()
                        .build()));
    }

    @Test
    void clearWinsOverAValueForTheSameField() {
        assertEquals(
                "{\"maxReconnectAttempts\":null}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .maxReconnectAttempts(5)
                        .clearMaxReconnectAttempts()
                        .build()));
    }

    @Test
    void linkPreviewIsSentAndCleared() {
        assertEquals(
                "{\"linkPreview\":false}",
                gson.toJson(UpdateSessionConfigRequest.builder().linkPreview(false).build()));
        assertEquals(
                "{\"linkPreview\":null}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .linkPreview(true)
                        .clearLinkPreview()
                        .build()));
    }

    @Test
    void oneClearedFieldDoesNotDragTheOthersIn() {
        assertEquals(
                "{\"autoRejectCalls\":true,\"maxReconnectAttempts\":null}",
                gson.toJson(UpdateSessionConfigRequest.builder()
                        .autoRejectCalls(true)
                        .clearMaxReconnectAttempts()
                        .build()));
    }

    // The tests above use a copy of the client's Gson; these go through the client, so they also
    // fail if it stops routing these bodies to that Gson.
    @Test
    void clientSendsTheConfigBodyThroughTheSerializer() {
        MockTransport tx = new MockTransport().respond(200, "{}");
        new OpenWAClient(ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build())
                .sessions.updateConfig("s", UpdateSessionConfigRequest.builder()
                        .autoRejectCalls(true)
                        .clearMaxReconnectAttempts()
                        .build());
        assertEquals(HttpMethod.PATCH, tx.lastRequest().method());
        assertEquals("http://h/api/sessions/s/config", tx.lastRequest().url());
        assertEquals("{\"autoRejectCalls\":true,\"maxReconnectAttempts\":null}", tx.lastRequest().body());
    }

    @Test
    void clientSendsANullProxyUrlToClearTheProxy() {
        MockTransport tx = new MockTransport().respond(200, "{}");
        new OpenWAClient(ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build())
                .sessions.updateProxy("s", new UpdateSessionProxyRequest(null));
        assertEquals("http://h/api/sessions/s/proxy", tx.lastRequest().url());
        assertEquals("{\"proxyUrl\":null}", tx.lastRequest().body());
    }

    @Test
    void backCompatibleConstructorsLeaveLinkPreviewUnset() {
        SessionConfig config = new SessionConfig(true, 5, 1000);
        assertEquals(Boolean.TRUE, config.autoRejectCalls());
        assertEquals(5, config.maxReconnectAttempts());
        assertEquals(1000, config.reconnectBaseDelay());
        assertEquals(null, config.linkPreview());

        UpdateSessionConfigRequest req = new UpdateSessionConfigRequest(true, null, 2000, false, true, false);
        assertEquals(null, req.linkPreview());
        assertEquals(false, req.clearLinkPreview());
        assertEquals(
                "{\"autoRejectCalls\":true,\"maxReconnectAttempts\":null,\"reconnectBaseDelay\":2000}",
                gson.toJson(req));
    }
}
