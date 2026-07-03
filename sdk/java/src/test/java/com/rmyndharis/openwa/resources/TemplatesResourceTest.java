package com.rmyndharis.openwa.resources;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.rmyndharis.openwa.ClientConfig;
import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CreateTemplateRequest;
import com.rmyndharis.openwa.model.UpdateTemplateRequest;
import com.rmyndharis.openwa.support.MockTransport;
import org.junit.jupiter.api.Test;

class TemplatesResourceTest {
    final MockTransport tx = new MockTransport();
    final OpenWAClient client = new OpenWAClient(
        ClientConfig.builder().baseUrl("http://h").apiKey("k").transport(tx).build());

    @Test
    void listHitsTemplatesPath() {
        tx.respond(200, "[]");
        client.templates.list("s");
        assertEquals("http://h/api/sessions/s/templates", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void getEncodesIds() {
        tx.respond(
            200,
            "{\"id\":\"t/1\",\"sessionId\":\"s\",\"name\":\"n\",\"body\":\"b\",\"createdAt\":\"c\",\"updatedAt\":\"u\"}");
        client.templates.get("a/b", "t/1");
        assertEquals("http://h/api/sessions/a%2Fb/templates/t%2F1", tx.lastRequest().url());
        assertEquals(HttpMethod.GET, tx.lastRequest().method());
    }

    @Test
    void createSendsBody() {
        tx.respond(
            200,
            "{\"id\":\"t1\",\"sessionId\":\"s\",\"name\":\"greeting\",\"body\":\"Hello {{name}}\",\"createdAt\":\"c\",\"updatedAt\":\"u\"}");
        client.templates.create(
            "s", CreateTemplateRequest.builder().name("greeting").body("Hello {{name}}").build());
        assertEquals("http://h/api/sessions/s/templates", tx.lastRequest().url());
        assertEquals(HttpMethod.POST, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("greeting"));
    }

    @Test
    void updateSendsBodyAndEncodesId() {
        tx.respond(
            200,
            "{\"id\":\"t1\",\"sessionId\":\"s\",\"name\":\"n\",\"body\":\"updated\",\"createdAt\":\"c\",\"updatedAt\":\"u\"}");
        client.templates.update("s", "t1", UpdateTemplateRequest.builder().body("updated").build());
        assertEquals("http://h/api/sessions/s/templates/t1", tx.lastRequest().url());
        assertEquals(HttpMethod.PUT, tx.lastRequest().method());
        assertTrue(tx.lastRequest().body().contains("updated"));
    }

    @Test
    void deleteHitsTemplatePath() {
        tx.respond(204, "");
        client.templates.delete("s", "t1");
        assertEquals("http://h/api/sessions/s/templates/t1", tx.lastRequest().url());
        assertEquals(HttpMethod.DELETE, tx.lastRequest().method());
    }
}
