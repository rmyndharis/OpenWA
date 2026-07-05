package com.rmyndharis.openwa.errors;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.stream.Collectors;
import java.util.stream.StreamSupport;

/**
 * Thrown when the API responds with a non-2xx status. Carries the HTTP status
 * code and the parsed error body (or the raw text if the body was not JSON).
 *
 * <p>Use the {@link #fromResponse(int, String, String, String)} factory in most
 * cases — it parses the NestJS error envelope and returns the most specific
 * subclass.
 */
public class OpenWAApiError extends OpenWAError {
    private static final Gson GSON = new Gson();

    private final int status;
    private final Object body;
    private final String errorKind;

    public OpenWAApiError(String message, int status, Object body, String errorKind) {
        super(message);
        this.status = status;
        this.body = body;
        this.errorKind = errorKind;
    }

    /** HTTP status code (e.g. 400, 404, 409, 429, 501). */
    public int status() {
        return status;
    }

    /** Parsed JSON body if available, otherwise the raw response text. */
    public Object body() {
        return body;
    }

    /** Value of the {@code error} field in the NestJS error envelope, if present. */
    public String errorKind() {
        return errorKind;
    }

    /**
     * Build the most specific error subclass from a non-2xx response. A 3xx
     * surfaces as a generic {@link OpenWAApiError} whose message states the
     * redirect was not followed (the API key is never re-sent to a redirect
     * target).
     */
    public static OpenWAApiError fromResponse(int status, String statusText, String rawBody, String context) {
        if (status >= 300 && status < 400) {
            return new OpenWAApiError(
                "Unexpected redirect (not followed; the API key is never re-sent to a redirect target) — " + context,
                status, null, null);
        }
        JsonObject obj = null;
        Object parsedBody = rawBody;
        if (rawBody != null && !rawBody.isEmpty()) {
            try {
                JsonElement el = GSON.fromJson(rawBody, JsonElement.class);
                if (el != null && el.isJsonObject()) {
                    obj = el.getAsJsonObject();
                    parsedBody = obj;
                }
            } catch (RuntimeException ignore) {
                // leave parsedBody as the raw text
            }
        }
        // Pull `message`/`error` from any JSON object body, not only a full NestJS envelope, so a partial
        // body (e.g. a 500 with {statusCode, message} but no `error`) still yields a useful message.
        String errorKind = obj != null && obj.has("error") && obj.get("error").isJsonPrimitive()
            ? obj.get("error").getAsString()
            : null;
        JsonElement messageEl = obj != null && obj.has("message") ? obj.get("message") : null;
        String fallback = rawBody != null && !rawBody.isBlank() ? rawBody : (statusText == null ? "" : statusText);
        String messageText = describe(messageEl, fallback);
        // java.net.http exposes no HTTP reason phrase, so statusText is often blank — omit it rather than
        // emitting a double space, and omit the trailing ": " when there is no message text at all.
        String reason = statusText == null || statusText.isBlank() ? "" : " " + statusText;
        String tail = messageText.isEmpty() ? "" : ": " + messageText;
        String message = "OpenWA API " + status + reason + " — " + context + tail;
        return classify(status, message, parsedBody, errorKind);
    }

    private static String describe(JsonElement message, String fallback) {
        if (message == null || message.isJsonNull()) {
            return fallback;
        }
        if (message.isJsonArray()) {
            return StreamSupport.stream(message.getAsJsonArray().spliterator(), false)
                .map(el -> el.isJsonPrimitive() ? el.getAsString() : el.toString())
                .collect(Collectors.joining(", "));
        }
        // Guard against a non-primitive `message` (e.g. a nested object in a non-NestJS body): getAsString()
        // would throw, and throwing while constructing an error is worse than a slightly-verbose message.
        return message.isJsonPrimitive() ? message.getAsString() : message.toString();
    }

    /** Construct the most specific subclass for a status code. */
    public static OpenWAApiError classify(int status, String message, Object body, String errorKind) {
        return switch (status) {
            case 401 -> new OpenWAAuthError(message, status, body, errorKind);
            case 403 -> new OpenWAForbiddenError(message, status, body, errorKind);
            case 404 -> new OpenWANotFoundError(message, status, body, errorKind);
            case 409 -> new OpenWAConflictError(message, status, body, errorKind);
            case 429 -> new OpenWARateLimitError(message, status, body, errorKind);
            case 501 -> new OpenWANotImplementedError(message, status, body, errorKind);
            default -> new OpenWAApiError(message, status, body, errorKind);
        };
    }
}
