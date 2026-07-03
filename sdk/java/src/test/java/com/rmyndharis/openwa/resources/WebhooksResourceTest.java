package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CreateWebhookRequest;
import com.rmyndharis.openwa.model.UpdateWebhookRequest;
import com.rmyndharis.openwa.model.WebhookEvent;
import com.rmyndharis.openwa.support.MockTransport;
import java.util.List;
import org.junit.jupiter.api.Test;

class WebhooksResourceTest {
    static final String WEBHOOK_JSON =
        "{\"id\":\"w1\",\"sessionId\":\"s\",\"url\":\"http://x\",\"events\":[\"message.received\"],"
            + "\"active\":true,\"retryCount\":3,\"lastTriggeredAt\":null,\"createdAt\":\"t\",\"updatedAt\":\"t\"}";

    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsWebhooksRoot() {
        tx.respond(200, "[]");
        client.webhooks.list("s");
        assertEquals("http://h/api/sessions/s/webhooks", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getEncodesIds() {
        tx.respond(200, WEBHOOK_JSON);
        client.webhooks.get("a/b", "w/1");
        assertEquals("http://h/api/sessions/a%2Fb/webhooks/w%2F1", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void createSendsBody() {
        tx.respond(200, WEBHOOK_JSON);
        client.webhooks.create(
            "s",
            CreateWebhookRequest.builder()
                .url("https://example.test/hook")
                .events(List.of(WebhookEvent.MESSAGE_RECEIVED))
                .retryCount(5)
                .build());
        assertEquals("http://h/api/sessions/s/webhooks", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("https://example.test/hook"));
        assertTrue(tx.lastRequest().body().contains("message.received"));
    }

    @Test
    void updateSendsBodyAndEncodesId() {
        tx.respond(200, WEBHOOK_JSON);
        client.webhooks.update("s", "w/1", UpdateWebhookRequest.builder().active(false).build());
        assertEquals("http://h/api/sessions/s/webhooks/w%2F1", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("\"active\":false"));
    }

    @Test
    void deleteHitsWebhookPath() {
        tx.respond(204, "");
        client.webhooks.delete("s", "w1");
        assertEquals("http://h/api/sessions/s/webhooks/w1", tx.lastRequest().url());
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }

    @Test
    void testHitsTestPath() {
        tx.respond(200, "{\"success\":true,\"statusCode\":200}");
        client.webhooks.test("s", "w1");
        assertEquals("http://h/api/sessions/s/webhooks/w1/test", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
    }
}
