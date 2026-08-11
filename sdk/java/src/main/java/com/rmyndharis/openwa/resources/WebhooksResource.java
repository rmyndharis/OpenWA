package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.DeliveryFailureQuery;
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

    /**
     * List webhooks across EVERY session the key can see, not one session's. Requires an
     * OPERATOR-level key.
     */
    public List<WebhookResponse> listAll(DeliveryFailureQuery query) {
        return client.requestList(HttpMethod.GET, "/api/webhooks", query, null, WebhookResponse.class);
    }

    /**
     * Deliveries that were ATTEMPTED and failed — the diagnostic for a webhook that stopped arriving.
     * Requires an ADMIN-level key.
     *
     * <p>A delivery a smart filter suppressed never reaches this log. The response has no published
     * schema, so it is returned as a raw JSON tree.
     */
    public Object deliveryFailures(DeliveryFailureQuery query) {
        return client.request(HttpMethod.GET, "/api/webhooks/delivery-failures", query, null, Object.class);
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
