package com.rmyndharis.openwa.resources;

import static com.rmyndharis.openwa.http.Http.encodeSegment;

import com.rmyndharis.openwa.OpenWAClient;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.model.CreateSessionRequest;
import com.rmyndharis.openwa.model.PairingCodeResponse;
import com.rmyndharis.openwa.model.QrCodeResponse;
import com.rmyndharis.openwa.model.RequestPairingCodeRequest;
import com.rmyndharis.openwa.model.SessionResponse;
import com.rmyndharis.openwa.model.SessionStatsOverview;
import java.util.List;

/** Sessions resource — lifecycle management for WhatsApp sessions. */
public final class SessionsResource {
    private final OpenWAClient client;

    public SessionsResource(OpenWAClient client) {
        this.client = client;
    }

    /** List all sessions (scoped to the API key's allowed sessions). */
    public List<SessionResponse> list() {
        return client.requestList(HttpMethod.GET, "/api/sessions", null, null, SessionResponse.class);
    }

    /** Get a single session by id. */
    public SessionResponse get(String id) {
        return client.request(HttpMethod.GET, "/api/sessions/" + encodeSegment(id), null, null, SessionResponse.class);
    }

    /** Create a new session. Requires an OPERATOR-level key. */
    public SessionResponse create(CreateSessionRequest body) {
        return client.request(HttpMethod.POST, "/api/sessions", null, body, SessionResponse.class);
    }

    /** Delete a session. Requires an OPERATOR-level key. */
    public void delete(String id) {
        client.requestVoid(HttpMethod.DELETE, "/api/sessions/" + encodeSegment(id), null, null);
    }

    /** Start a session and initialize the WhatsApp connection. */
    public SessionResponse start(String id) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/start", null, null, SessionResponse.class);
    }

    /** Stop a session and disconnect gracefully. */
    public SessionResponse stop(String id) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/stop", null, null, SessionResponse.class);
    }

    /**
     * Attempt an engine-native unlink of this device, then stop the session. A {@code 200} means the
     * unlink operation AND the required local credential cleanup completed — it is not an
     * independent observation that the handset UI no longer shows the linked device. Because a
     * completed unlink wipes the stored credentials, a later {@code start} requires a fresh QR scan
     * or pairing code. Requires a running session. Throws on HTTP {@code 502} with
     * {@code code: 'SESSION_LOGOUT_INCOMPLETE'} when the session was stopped locally but the logout
     * operation did not complete (no send, no acknowledgement, timeout/transport error, or local
     * cleanup failure); {@code phone} is cleared and no success audit is written. Start the session
     * again and retry the logout; do not assume the retry reconnects automatically or lands in a
     * guaranteed QR state.
     */
    public SessionResponse logout(String id) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/logout", null, null, SessionResponse.class);
    }

    /** Force-kill a stuck session (SIGKILL + teardown). */
    public SessionResponse forceKill(String id) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/force-kill", null, null, SessionResponse.class);
    }

    /** Get the current QR code for authentication (live from the engine, not the DB). */
    public QrCodeResponse getQrCode(String id) {
        return client.request(HttpMethod.GET, "/api/sessions/" + encodeSegment(id) + "/qr", null, null, QrCodeResponse.class);
    }

    /** Request an 8-character pairing code for phone-based login. */
    public PairingCodeResponse requestPairingCode(String id, RequestPairingCodeRequest body) {
        return client.request(HttpMethod.POST, "/api/sessions/" + encodeSegment(id) + "/pairing-code", null, body, PairingCodeResponse.class);
    }

    /** Aggregate statistics across the API key's sessions. */
    public SessionStatsOverview stats() {
        return client.request(HttpMethod.GET, "/api/sessions/stats/overview", null, null, SessionStatsOverview.class);
    }
}
