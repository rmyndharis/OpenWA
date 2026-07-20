package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.SuccessResult;

/** Calls resource — incoming call handling. */
public final class CallsResource {
    private final OpenWAClient client;

    public CallsResource(OpenWAClient client) {
        this.client = client;
    }

    /**
     * Reject a ringing incoming call. The {@code callId} comes from a {@code call.received}
     * webhook event; 404 when the call is not found or no longer ringing.
     */
    public SuccessResult rejectCall(String sessionId, String callId) {
        return client.request(
            HttpMethod.POST,
            "/api/sessions/"
                + encodeSegment(sessionId)
                + "/calls/"
                + encodeSegment(callId)
                + "/reject",
            null,
            null,
            SuccessResult.class);
    }
}
