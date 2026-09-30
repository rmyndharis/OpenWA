package com.rmyndharis.openwa.errors;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
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
    private final Map<String, List<String>> headers;
    private final String code;
    private final Long retryAfterSeconds;

    public OpenWAApiError(String message, int status, Object body, String errorKind) {
        this(message, status, body, errorKind, Map.of());
    }

    public OpenWAApiError(
            String message, int status, Object body, String errorKind, Map<String, List<String>> headers) {
        super(message);
        this.status = status;
        this.body = body;
        this.errorKind = errorKind;
        // Case-insensitive like the transport's own map; a null key (the status line from
        // HttpURLConnection.getHeaderFields()) is not a header and is dropped.
        TreeMap<String, List<String>> copy = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        if (headers != null) {
            headers.forEach((k, v) -> {
                if (k != null) {
                    copy.put(k, v);
                }
            });
        }
        this.headers = Collections.unmodifiableMap(copy);
        JsonObject fields = body instanceof JsonObject obj ? obj : new JsonObject();
        JsonElement codeEl = fields.get("code");
        this.code = codeEl != null && codeEl.isJsonPrimitive() && codeEl.getAsJsonPrimitive().isString()
            ? codeEl.getAsString()
            : null;
        this.retryAfterSeconds = retryAfter(fields.get("retryAfterSeconds"), header(this.headers, "Retry-After"));
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

    /** The body's machine-readable {@code code} (e.g. {@code SEND_PACING_LIMITED}), or {@code null}. */
    public String code() {
        return code;
    }

    /**
     * Seconds to wait before retrying: the body's {@code retryAfterSeconds} when present, else the
     * {@code Retry-After} header (seconds or an HTTP date), else {@code null}.
     */
    public Long retryAfterSeconds() {
        return retryAfterSeconds;
    }

    /** The response headers (empty when the error did not come from a response). */
    public Map<String, List<String>> headers() {
        return headers;
    }

    private static String header(Map<String, List<String>> headers, String name) {
        List<String> values = headers.get(name);
        return values == null || values.isEmpty() ? null : values.get(0);
    }

    // The body's retryAfterSeconds wins: send pacing puts its wait (possibly hours) only there, and a
    // header added by a proxy must not shorten it.
    private static Long retryAfter(JsonElement fromBody, String header) {
        if (fromBody != null && fromBody.isJsonPrimitive() && fromBody.getAsJsonPrimitive().isNumber()
                && fromBody.getAsDouble() >= 0) {
            return (long) Math.ceil(fromBody.getAsDouble());
        }
        String value = header == null ? "" : header.trim();
        if (value.matches("\\d{1,18}")) {
            return Long.parseLong(value);
        }
        try {
            Instant at = ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant();
            return Math.max(0L, (long) Math.ceil((at.toEpochMilli() - System.currentTimeMillis()) / 1000.0));
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /**
     * Build the most specific error subclass from a non-2xx response. A 3xx
     * surfaces as a generic {@link OpenWAApiError} whose message states the
     * redirect was not followed (the API key is never re-sent to a redirect
     * target).
     */
    public static OpenWAApiError fromResponse(int status, String statusText, String rawBody, String context) {
        return fromResponse(status, statusText, rawBody, context, Map.of());
    }

    /** As {@link #fromResponse(int, String, String, String)}, keeping the response headers on the error. */
    public static OpenWAApiError fromResponse(
            int status, String statusText, String rawBody, String context, Map<String, List<String>> headers) {
        if (status >= 300 && status < 400) {
            return new OpenWAApiError(
                "Unexpected redirect (not followed; the API key is never re-sent to a redirect target) — " + context,
                status, null, null, headers);
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
        return classify(status, message, parsedBody, errorKind, headers);
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
        return classify(status, message, body, errorKind, Map.of());
    }

    /** As {@link #classify(int, String, Object, String)}, keeping the response headers on the error. */
    public static OpenWAApiError classify(
            int status, String message, Object body, String errorKind, Map<String, List<String>> headers) {
        return switch (status) {
            case 401 -> new OpenWAAuthError(message, status, body, errorKind, headers);
            case 403 -> new OpenWAForbiddenError(message, status, body, errorKind, headers);
            case 404 -> new OpenWANotFoundError(message, status, body, errorKind, headers);
            case 409 -> new OpenWAConflictError(message, status, body, errorKind, headers);
            case 429 -> new OpenWARateLimitError(message, status, body, errorKind, headers);
            case 501 -> new OpenWANotImplementedError(message, status, body, errorKind, headers);
            case 503 -> new OpenWAServiceUnavailableError(message, status, body, errorKind, headers);
            default -> new OpenWAApiError(message, status, body, errorKind, headers);
        };
    }
}
