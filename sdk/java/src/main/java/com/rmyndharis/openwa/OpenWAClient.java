package com.rmyndharis.openwa;

import com.google.gson.Gson;
import com.google.gson.JsonParseException;
import com.rmyndharis.openwa.errors.OpenWAApiError;
import com.rmyndharis.openwa.errors.OpenWAError;
import com.rmyndharis.openwa.http.BinaryResponse;
import com.rmyndharis.openwa.http.DefaultHttpTransport;
import com.rmyndharis.openwa.http.Http;
import com.rmyndharis.openwa.http.HttpMethod;
import com.rmyndharis.openwa.http.HttpRequestData;
import com.rmyndharis.openwa.http.HttpResponseData;
import com.rmyndharis.openwa.http.HttpTransport;
import com.rmyndharis.openwa.model.AuthValidateResponse;
import com.rmyndharis.openwa.resources.CallsResource;
import com.rmyndharis.openwa.resources.MediaResource;
import com.rmyndharis.openwa.resources.CatalogResource;
import com.rmyndharis.openwa.resources.ChannelsResource;
import com.rmyndharis.openwa.resources.ChatsResource;
import com.rmyndharis.openwa.resources.ContactsResource;
import com.rmyndharis.openwa.resources.GroupsResource;
import com.rmyndharis.openwa.resources.HealthResource;
import com.rmyndharis.openwa.resources.LabelsResource;
import com.rmyndharis.openwa.resources.MessagesResource;
import com.rmyndharis.openwa.resources.ProfileResource;
import com.rmyndharis.openwa.resources.SearchResource;
import com.rmyndharis.openwa.resources.SessionsResource;
import com.rmyndharis.openwa.resources.StatusResource;
import com.rmyndharis.openwa.resources.TemplatesResource;
import com.rmyndharis.openwa.resources.WebhooksResource;
import java.io.IOException;
import java.lang.reflect.Array;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * The single entry point to the OpenWA SDK. Holds configuration and exposes
 * domain resources as fields:
 *
 * <pre>{@code
 * OpenWAClient client = new OpenWAClient("http://localhost:2785", "owa_k1_…");
 * client.sessions.start("my-session");
 * client.messages.sendText("my-session",
 *     SendTextRequest.builder().chatId("628123456789@c.us").text("Hello!").build());
 * }</pre>
 */
public final class OpenWAClient {
    private final Gson gson = new Gson();
    private final ClientConfig config;
    private final HttpTransport transport;

    // ── Resources ──────────────────────────────────────────────────────
    public final SessionsResource sessions = new SessionsResource(this);
    public final MessagesResource messages = new MessagesResource(this);
    public final SearchResource search = new SearchResource(this);
    public final ContactsResource contacts = new ContactsResource(this);
    public final GroupsResource groups = new GroupsResource(this);
    public final WebhooksResource webhooks = new WebhooksResource(this);
    public final ChatsResource chats = new ChatsResource(this);
    public final LabelsResource labels = new LabelsResource(this);
    public final ChannelsResource channels = new ChannelsResource(this);
    public final CatalogResource catalog = new CatalogResource(this);
    public final StatusResource status = new StatusResource(this);
    public final TemplatesResource templates = new TemplatesResource(this);
    public final HealthResource health = new HealthResource(this);
    public final ProfileResource profile = new ProfileResource(this);
    public final CallsResource calls = new CallsResource(this);
    public final MediaResource media = new MediaResource(this);

    public OpenWAClient(ClientConfig config) {
        // ClientConfig's constructor validates baseUrl/apiKey/timeout, so config is already sound here.
        this.config = config;
        this.transport = config.transport != null ? config.transport : new DefaultHttpTransport();
    }

    public OpenWAClient(String baseUrl, String apiKey) {
        this(ClientConfig.builder().baseUrl(baseUrl).apiKey(apiKey).build());
    }

    /** Validate the configured API key and resolve its role. */
    public AuthValidateResponse auth() {
        return request(HttpMethod.POST, "/api/auth/validate", null, null, AuthValidateResponse.class);
    }

    // ── Internal request API used by all resources ─────────────────────

    /**
     * Issue a request and deserialize a single object (or {@code null} for 204/empty).
     *
     * <p>A {@code String} target receives a non-JSON 2xx body as raw text — the same
     * fallback the JS/Python/PHP transports apply. For any other target the body must
     * be JSON; a non-JSON body surfaces as a tidy {@link OpenWAError}, never a raw
     * Gson exception.
     */
    @SuppressWarnings("unchecked")
    public <T> T request(HttpMethod method, String path, Object query, Object body, Class<T> type) {
        HttpResponseData res = execute(method, path, query, body);
        String text = utf8(res.body());
        if (res.status() == 204 || text.isEmpty()) {
            return null;
        }
        if (type == String.class) {
            // A String target mirrors the JS/Python/PHP raw-text fallback: decode a
            // JSON string body, accept a non-JSON 2xx body as the raw text.
            try {
                T parsed = gson.fromJson(text, type);
                if (parsed != null) {
                    return parsed;
                }
            } catch (JsonParseException ignore) {
                // fall through to the raw text
            }
            return (T) text;
        }
        try {
            return gson.fromJson(text, type);
        } catch (JsonParseException e) {
            throw new OpenWAError("Non-JSON response — " + method + " " + path);
        }
    }

    /** Issue a request and deserialize a JSON array into a {@code List} (empty for 204/empty). */
    @SuppressWarnings("unchecked")
    public <T> List<T> requestList(HttpMethod method, String path, Object query, Object body, Class<T> elementType) {
        HttpResponseData res = execute(method, path, query, body);
        String text = utf8(res.body());
        if (res.status() == 204 || text.isEmpty()) {
            return List.of();
        }
        Class<T[]> arrayType = (Class<T[]>) Array.newInstance(elementType, 0).getClass();
        try {
            T[] arr = gson.fromJson(text, arrayType);
            return arr == null ? List.of() : List.of(arr);
        } catch (JsonParseException e) {
            throw new OpenWAError("Non-JSON response — " + method + " " + path);
        }
    }

    /** Issue a request that returns no body. */
    public void requestVoid(HttpMethod method, String path, Object query, Object body) {
        execute(method, path, query, body);
    }

    /**
     * Issue a request for a non-JSON (binary) 2xx body — e.g. stored status media —
     * and return the raw bytes plus the served Content-Type. A 204/empty body yields
     * empty data and a {@code null} content type.
     */
    public BinaryResponse requestBytes(HttpMethod method, String path, Object query) {
        HttpResponseData res = execute(method, path, query, null);
        if (res.status() == 204 || res.body() == null || res.body().length == 0) {
            return new BinaryResponse(new byte[0], null);
        }
        String contentType = null;
        for (Map.Entry<String, List<String>> e : res.headers().entrySet()) {
            if ("content-type".equalsIgnoreCase(e.getKey()) && !e.getValue().isEmpty()) {
                contentType = e.getValue().get(0);
                break;
            }
        }
        return new BinaryResponse(res.body(), contentType);
    }

    private static String utf8(byte[] body) {
        return body == null ? "" : new String(body, StandardCharsets.UTF_8);
    }

    private HttpResponseData execute(HttpMethod method, String path, Object query, Object body) {
        String url = Http.buildUrl(config.baseUrl, path, query, gson);
        Map<String, String> headers = Http.mergeHeaders(config.defaultHeaders, null, config.apiKey);
        String bodyJson = body != null ? gson.toJson(body) : null;
        HttpRequestData reqData = new HttpRequestData(method, url, headers, bodyJson, config.timeout);
        HttpResponseData res;
        try {
            // A timeout surfaces as OpenWATimeoutError (unchecked) and propagates.
            res = transport.send(reqData);
        } catch (IOException e) {
            throw new OpenWAError("Transport error — " + method + " " + path + ": " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new OpenWAError("Transport interrupted — " + method + " " + path);
        } catch (IllegalArgumentException e) {
            // e.g. a JDK-restricted header name in defaultHeaders, or a URI-illegal char — keep it
            // inside the OpenWAError contract instead of leaking a raw JDK exception to the caller.
            throw new OpenWAError("Invalid request — " + method + " " + path + ": " + e.getMessage());
        }
        if (res.status() < 200 || res.status() >= 300) {
            throw OpenWAApiError.fromResponse(res.status(), "", utf8(res.body()), method + " " + path);
        }
        return res;
    }
}
