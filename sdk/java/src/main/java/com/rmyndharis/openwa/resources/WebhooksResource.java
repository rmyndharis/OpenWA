package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CreateWebhookRequest;
import com.rmyndharis.openwa.model.UpdateWebhookRequest;
import com.rmyndharis.openwa.model.WebhookResponse;
import com.rmyndharis.openwa.model.WebhookTestResult;
import java.util.List;

/** Webhooks resource — configure event delivery to external HTTP endpoints. */
public final class WebhooksResource {
    private final OpenWAClient client;

    public WebhooksResource(OpenWAClient client) {
        this.client = client;
    }

    /** List all webhooks for a session. */
    public List<WebhookResponse> list(String sessionId) {
        return client.requestList(
            HttpMethod.GET, "/api/sessions/" + encodeSegment(sessionId) + "/webhooks", null, null, WebhookResponse.class);
    }

    /** Get a single webhook by id. */
    public WebhookResponse get(String sessionId, String id) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/webhooks/" + encodeSegment(id),
            null,
            null,
            WebhookResponse.class);
    }

    /** Create a new webhook. */
    public WebhookResponse create(String sessionId, CreateWebhookRequest body) {
        return client.request(
            HttpMethod.POST, "/api/sessions/" + encodeSegment(sessionId) + "/webhooks", null, body, WebhookResponse.class);
    }

    /** Update a webhook. */
    public WebhookResponse update(String sessionId, String id, UpdateWebhookRequest body) {
        return client.request(
            HttpMethod.PUT,
            "/api/sessions/" + encodeSegment(sessionId) + "/webhooks/" + encodeSegment(id),
            null,
            body,
            WebhookResponse.class);
    }

    /** Delete a webhook. */
    public void delete(String sessionId, String id) {
        client.requestVoid(
            HttpMethod.DELETE, "/api/sessions/" + encodeSegment(sessionId) + "/webhooks/" + encodeSegment(id), null, null);
    }

    /** Trigger a test dispatch to the webhook URL and report the result. */
    public WebhookTestResult test(String sessionId, String id) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/webhooks/" + encodeSegment(id) + "/test",
            null,
            null,
            WebhookTestResult.class);
    }
}
