package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.DeliveryFailureQuery;
import com.rmyndharis.openwa.model.CreateWebhookRequest;
import com.rmyndharis.openwa.model.RedriveWebhookDeliveriesRequest;
import com.rmyndharis.openwa.model.UpdateWebhookRequest;
import com.rmyndharis.openwa.model.WebhookDeliveryFailure;
import com.rmyndharis.openwa.model.WebhookRedriveResult;
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
     * OPERATOR-level key. The route pages with {@code limit} and {@code offset} only: the query's
     * {@code sessionId} is not sent, so use {@link #list(String)} for one session's webhooks.
     */
    public List<WebhookResponse> listAll(DeliveryFailureQuery query) {
        DeliveryFailureQuery paging =
            query == null ? null : new DeliveryFailureQuery(null, query.limit(), query.offset());
        return client.requestList(HttpMethod.GET, "/api/webhooks", paging, null, WebhookResponse.class);
    }

    /**
     * Deliveries the gateway gave up on or could not dispatch: the diagnostic for a webhook that
     * stopped arriving. Rows with {@code attempts > 0} exhausted their retries against the receiver.
     * Rows with {@code attempts == 0} were not given up after retries: the payload was over the size
     * cap or could not be serialized after the webhook:before hooks, dispatch capacity was shed, or
     * shutdown interrupted the delivery (possibly between retries, after earlier attempts were sent).
     * A row is removed once a later replay delivers the event. Requires an ADMIN-level key.
     *
     * <p>A delivery a smart filter suppressed never reaches this log. Most recent first.
     */
    public List<WebhookDeliveryFailure> deliveryFailures(DeliveryFailureQuery query) {
        return client.requestList(
            HttpMethod.GET, "/api/webhooks/delivery-failures", query, null, WebhookDeliveryFailure.class);
    }

    /**
     * Replay recorded deliveries that still hold their event data ({@code replayable} in {@link
     * #deliveryFailures}), fewest attempts first, then oldest, one bounded batch per call.
     * Each replay reuses the stored idempotency key, so a receiver that already handled the event can dedup it. Only rows recorded
     * while the gateway's WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS is above 0 are replayable. Requires
     * an ADMIN-level key; rows outside the key's allowedSessions are never touched.
     *
     * @param body the batch filter; {@code null} uses the default batch filter
     */
    public WebhookRedriveResult redriveDeliveryFailures(RedriveWebhookDeliveriesRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/webhooks/delivery-failures/redrive",
            null,
            body != null ? body : RedriveWebhookDeliveriesRequest.builder().build(),
            WebhookRedriveResult.class);
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

    /**
     * Update a webhook. Fields left null are not sent and stay unchanged. To remove every filter,
     * set {@code filters(new WebhookFilters(List.of()))}; {@code filters(null)} keeps the current ones.
     */
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
