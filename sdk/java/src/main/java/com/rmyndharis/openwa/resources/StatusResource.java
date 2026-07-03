package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.SendImageStatusRequest;
import com.rmyndharis.openwa.model.SendTextStatusRequest;
import com.rmyndharis.openwa.model.SendVideoStatusRequest;
import com.rmyndharis.openwa.model.StatusListResult;
import com.rmyndharis.openwa.model.StatusResult;

/**
 * Status (Stories) resource — WhatsApp status updates.
 *
 * <p>NOTE: this is WhatsApp "Status/Stories", distinct from session lifecycle status.
 */
public final class StatusResource {
    private final OpenWAClient client;

    public StatusResource(OpenWAClient client) {
        this.client = client;
    }

    /** Get all status updates. */
    public StatusListResult list(String sessionId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/status",
            null,
            null,
            StatusListResult.class);
    }

    /** Get status updates from a specific contact. */
    public StatusListResult fromContact(String sessionId, String contactId) {
        return client.request(
            HttpMethod.GET,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/" + encodeSegment(contactId),
            null,
            null,
            StatusListResult.class);
    }

    /** Post a text status update. */
    public StatusResult sendText(String sessionId, SendTextStatusRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/send-text",
            null,
            body,
            StatusResult.class);
    }

    /** Post an image status update. */
    public StatusResult sendImage(String sessionId, SendImageStatusRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/send-image",
            null,
            body,
            StatusResult.class);
    }

    /** Post a video status update. */
    public StatusResult sendVideo(String sessionId, SendVideoStatusRequest body) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/send-video",
            null,
            body,
            StatusResult.class);
    }

    /** Delete a status update by id. */
    public void delete(String sessionId, String statusId) {
        client.requestVoid(
            HttpMethod.DELETE,
            "/api/sessions/" + encodeSegment(sessionId) + "/status/" + encodeSegment(statusId),
            null,
            null);
    }
}
